<script setup lang="ts">
import { t as msg, tf } from "../i18n";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import ThemeToggle from "./ThemeToggle.vue";
import { 收纳浮窗锚点 } from "../kernel/tabPickerAnchor";
import {
  activate,
  closeOtherTabs,
  closeTabsToRight,
  createUntitled,
  getHost,
  isDirty,
  moveTab,
  tabs,
} from "../state/documents";

/**
 * 标签栏：点击激活、中键/双击关闭、拖拽排序、右键菜单。
 * 关闭脏标签前抛事件给 App 走 006 的确认流程。
 *
 * 外壳改造后的布局（几轮要求叠在一起）：
 * - 「+」跟着最后一个标签走（原来钉在栏的右端，标签少时离得太远）；
 * - 127：「+」的语义从「打开文件」改成「**新增标签**」（建一份未命名空文档，直接可输入）；
 *   打开文件退到它右边一颗描边文件夹图标上 —— 入口没少，只是不再和「+」挤成同一颗；
 * - 设置从顶栏挪到这里、画成齿轮（顶栏只留品牌 + 拖动区 + 窗口三键）；
 * - 127：主题开关挂在齿轮右手边（`ThemeToggle.vue`），设置对话框里那条主题删掉了；
 * - 栏右端**不再有模式切换按钮**（125 按已定口径 Q10 删掉：模式入口只留底栏那三个直达按钮，
 *   「点一下走下一档」这种要用户先知道当前在哪档的设计是多余的一层）。
 */
const emit = defineEmits<{ close: [id: string]; open: []; "open-settings": [] }>();

const menu = reactive({
  open: false,
  x: 0,
  y: 0,
  tabId: "" as string,
});

const drag = reactive({ from: -1, over: -1 });

/**
 * 140（要求：「页签区域不再上下左右滚动，去掉滚动条，标签过多时收纳，点图标展开浮窗选择」）。
 *
 * 做法是**算容量**而不是靠 CSS 裁：
 * - 每颗标签的宽度在 `TAB_MIN`～`TAB_MAX` 之间由 flex 平分（控件尺寸恒定，不随字数换行）；
 * - `capacity` = 标签区可用宽度 ÷ 最小宽度，装不下的收进「+N」那颗；
 * - **当前标签永远在可视窗口里**（窗口以它为中心滑），所以 134 那条"从资源管理器
 *   双击排在后面的文档，看上去像没打开"的修法没有丢，只是从滚动变成收纳；
 * - 右侧齿轮与主题开关在标签区外面，位置与标签数量无关（这条点名要固定）。
 */
const TAB_MIN = 96;
const TAB_MAX = 200;
const TAB_GAP = 2;
/**
 * 「+」「打开文件」两颗固定占位，加上**收纳那颗**的宽度 —— 收纳那颗按常驻算：
 * 它出现与否取决于容量，容量又取决于它占不占地方，来回解会抖；
 * 宁可少排一颗标签，也不要出现「算满了却被裁掉 2px」这种（e2e 量出来过）。
 */
/** 三颗固定键各自的宽度：「+」「打开文件」是 26，「+N」那颗给到 34（两位数也放得下） */
const BTN_W = 26;
const MORE_W = 34;
const TAB_FIXED = 2 * (BTN_W + TAB_GAP) + (MORE_W + TAB_GAP);

const strip = ref<HTMLElement | null>(null);
const stripW = ref(0);

function measure(): void {
  if (strip.value) stripW.value = strip.value.clientWidth;
  // 162：栏一变宽窄，那颗「+N」就挪一格；浮窗开着的话跟着挪
  if (picker.value) 定位浮窗();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  measure();
  // 窗口拖宽拖窄、侧栏收起展开都会走这里；没有 ResizeObserver 的旧运行时退回窗口 resize
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(measure);
    if (strip.value) ro.observe(strip.value);
  }
  window.addEventListener("resize", measure);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener("resize", measure);
});

const capacity = computed(() => {
  const avail = Math.max(0, stripW.value - TAB_FIXED - (tabs.list.length ? TAB_GAP * 2 : 0));
  return Math.max(1, Math.floor((avail + TAB_GAP) / (TAB_MIN + TAB_GAP)));
});
/** 可视窗口：以当前标签为中心，保证它一定在里头 */
const window0 = computed(() => {
  const n = capacity.value;
  if (tabs.list.length <= n) return 0;
  const idx = Math.max(0, tabs.list.findIndex((t) => t.id === tabs.activeId));
  const half = Math.floor((n - 1) / 2);
  return Math.min(Math.max(0, idx - half), tabs.list.length - n);
});
const shown = computed(() => tabs.list.slice(window0.value, window0.value + capacity.value));
const hidden = computed(() => tabs.list.filter((t) => !shown.value.includes(t)));

const picker = ref(false);
/**
 * 162：浮窗贴着那颗「+N」开（要求：「窗口过多收纳展开放在展开按钮那里，而不是放在左边」）。
 *
 * 位置**每次展开算一次、栏宽一变再算一次** —— 那颗按钮长在标签串尾巴上，栏一拖宽拖窄它就挪地方
 * （实测：溢出时标签正好把栏填满，所以**换活动标签并不挪它**，别把判据押在这上面）。
 * 算一次定死的话，浮窗会跟按钮各去各的。
 * 数交给 `kernel/tabPickerAnchor.ts` 那份纯函数算（单位层与 E2E/桌面钉的是同一个答案）。
 */
const moreBtn = ref<HTMLElement | null>(null);
const 浮窗位 = reactive({ top: 36, right: 8 });
function 定位浮窗(): void {
  const 矩 = moreBtn.value?.getBoundingClientRect() ?? null;
  const 锚 = 收纳浮窗锚点(矩, { width: window.innerWidth, height: window.innerHeight });
  // null = 这一帧按钮不在（`v-if` 掉了）。保持上一次的位置，不许跳回左上
  if (锚) Object.assign(浮窗位, 锚);
}
function togglePicker(): void {
  picker.value = !picker.value;
  if (picker.value) 定位浮窗();
}
function pick(id: string): void {
  activate(id);
  picker.value = false;
}

function onMiddle(e: MouseEvent, id: string) {
  if (e.button === 1) {
    e.preventDefault();
    emit("close", id);
  }
}

function onContext(e: MouseEvent, id: string) {
  e.preventDefault();
  menu.tabId = id;
  menu.x = e.clientX;
  menu.y = e.clientY;
  menu.open = true;
}

function closeMenu() {
  menu.open = false;
}

function currentTab() {
  return tabs.list.find((t) => t.id === menu.tabId) ?? null;
}

function doCloseOther() {
  closeOtherTabs(menu.tabId);
  closeMenu();
}

function doCloseRight() {
  closeTabsToRight(menu.tabId);
  closeMenu();
}

async function doCopyPath() {
  const t = currentTab();
  const h = getHost();
  if (t?.path && h) await h.writeClipboard(t.path);
  closeMenu();
}

async function doReveal() {
  const t = currentTab();
  const h = getHost();
  if (t?.path && h) await h.revealInFolder(t.path);
  closeMenu();
}

function onDrop(to: number) {
  if (drag.from >= 0) moveTab(drag.from, to);
  drag.from = -1;
  drag.over = -1;
}
</script>

<template>
  <div class="tabbar" data-testid="tabbar">
   <div ref="strip" class="tabbar__strip" data-testid="tabbar-strip">
    <div
      v-for="(t, i) in shown"
      :key="t.id"
      class="tab"
      :class="{ 'is-active': t.id === tabs.activeId, 'is-over': drag.over === window0 + i }"
      :draggable="true"
      @click="activate(t.id)"
      @mousedown.middle="onMiddle($event, t.id)"
      @dblclick="emit('close', t.id)"
      @contextmenu="onContext($event, t.id)"
      @dragstart="drag.from = window0 + i"
      @dragover.prevent="drag.over = window0 + i"
      @drop="onDrop(window0 + i)"
      @dragend="drag.from = -1; drag.over = -1"
    >
      <span v-if="isDirty(t)" class="tab__dirty" :title="msg('tab.dirty')" data-testid="tab-dirty">●</span>
      <span class="tab__name">{{ t.name }}</span>
      <button class="tab__close" :title="msg('tab.close')" :aria-label="msg('tab.closeTab')" @click.stop="emit('close', t.id)">
        ×
      </button>
    </div>
    <!-- 140：装不下的收进这颗，点开创浮窗挑（页签区不出现滚动条）；162：浮窗就开在这颗下面 -->
    <button
      ref="moreBtn"
      v-if="hidden.length"
      class="tabbar__more"
      :class="{ 'is-on': picker }"
      :title="tf('tab.moreHint', { n: hidden.length })"
      :aria-label="tf('tab.moreHint', { n: hidden.length })"
      :aria-expanded="picker ? 'true' : 'false'"
      data-testid="tab-more"
      @click="togglePicker"
    >+{{ hidden.length }}</button>
    <!--
 127：这颗「+」**不再是打开文件**，按已定口径改成「新增标签」——
      点下去开一份未命名的空 Markdown，直接进编辑档、可以打字（`createUntitled`）。
      打开文件没被删掉，它就在右边那颗描边文件夹上。
    -->
    <button
      class="tabbar__new"
      :title="msg('tab.newTabHint')"
      :aria-label="msg('tab.newTab')"
      data-testid="tab-new"
      @click="createUntitled()"
    >
      +
    </button>
    <!--
      这颗是这条改动带出来的**取舍**，不是我自己加的第三种按钮：
      按原话「打开文件按钮调整为新增标签」，标签栏就没有打开入口了，
      只剩空态页那颗按钮 + Ctrl+O —— 已经开着文档时想再开一个只能记快捷键。
      所以这里补一颗描边的「打开文件」图标保住可见入口（testid 仍是 tab-open，回归用例不用改地址）。
      要不要留还没敲定，删它就是一行的事，已写进 127 的待决清单。
    -->
    <button
      class="tabbar__open"
      :title="msg('tab.openHint')"
      :aria-label="msg('tab.open')"
      data-testid="tab-open"
      @click="getHost() && $emit('open')"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M2 5.6A1.1 1.1 0 0 1 3.1 4.5H6.3L7.5 5.8H12.9A1.1 1.1 0 0 1 14 6.9V11.4A1.1 1.1 0 0 1 12.9 12.5H3.1A1.1 1.1 0 0 1 2 11.4Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
      </svg>
    </button>
   </div>
    <!--
      设置：标签栏右端的齿轮（124 从顶栏挪过来）。
      路径是**算出来的**（8 齿、齿根 r=5.5、齿顶 r=7.3、中心孔 r=2.3，16×16 viewBox），
      不是我手描的 —— 第一版手描的两条 path 方向相同，默认 nonzero 填充规则下
      中心孔根本没挖出来，看起来就是一坨带棱角的东西（原话：「图标不对」的真相）。
      现在孔是**反向绕**的第二个子路径，nonzero 下自然成洞。
    -->
    <button
      class="tabbar__settings"
      :title="msg('tab.settingsHint')"
      :aria-label="msg('dialog.settings')"
      data-testid="open-settings"
      @click="emit('open-settings')"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          fill="currentColor"
          d="M13.08 5.90 L13.31 6.56 L15.21 6.87 L15.21 9.13 L13.31 9.44 L13.08 10.10 L12.77 10.73 L13.90 12.30 L12.30 13.90 L10.73 12.77 L10.10 13.08 L9.44 13.31 L9.13 15.21 L6.87 15.21 L6.56 13.31 L5.90 13.08 L5.27 12.77 L3.70 13.90 L2.10 12.30 L3.23 10.73 L2.92 10.10 L2.69 9.44 L0.79 9.13 L0.79 6.87 L2.69 6.56 L2.92 5.90 L3.23 5.27 L2.10 3.70 L3.70 2.10 L5.27 3.23 L5.90 2.92 L6.56 2.69 L6.87 0.79 L9.13 0.79 L9.44 2.69 L10.10 2.92 L10.73 3.23 L12.30 2.10 L13.90 3.70 L12.77 5.27 Z M10.30 8.00 A2.3 2.3 0 0 0 5.70 8.00 A2.3 2.3 0 0 0 10.30 8.00 Z"
        />
      </svg>
    </button>
    <!-- 127：主题开关（从设置里挪出来，就在齿轮右手边；右缘与顶栏关闭按钮对齐） -->
    <ThemeToggle />
  </div>

  <!-- 收纳浮窗：列**全部**标签（只列收起的那几颗的话，用户看不出自己在哪里）；
       位置贴在「+N」那颗下面（162），由 `定位浮窗()` 每次展开与栏宽变化时重算 -->
  <div v-if="picker" class="menu-mask" data-testid="tab-picker-mask" @click="picker = false">
    <ul
      class="menu tabpicker"
      data-testid="tab-picker"
      :style="{ top: 浮窗位.top + 'px', right: 浮窗位.right + 'px' }"
      @click.stop
    >
      <li class="tabpicker__head">{{ msg("tab.pickerTitle") }}</li>
      <li
        v-for="t in tabs.list"
        :key="t.id"
        class="tabpicker__item"
        :class="{ 'is-active': t.id === tabs.activeId }"
        :data-testid="'tab-pick-' + t.id"
        @click="pick(t.id)"
      >
        <span v-if="isDirty(t)" class="tabpicker__dot">●</span>
        <span class="tabpicker__name" :title="t.path ?? t.name">{{ t.name }}</span>
      </li>
    </ul>
  </div>

  <div v-if="menu.open" class="menu-mask" @click="closeMenu" @contextmenu.prevent="closeMenu">
    <ul class="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <li @click="emit('close', menu.tabId); closeMenu()">{{ msg('tab.closeTab') }}</li>
      <li :class="{ 'is-disabled': tabs.list.length < 2 }" @click="tabs.list.length > 1 && doCloseOther()">{{ msg('menu.closeOthers') }}</li>
      <li :class="{ 'is-disabled': !currentTab() || currentTab() === tabs.list[tabs.list.length - 1] }"
          @click="doCloseRight()">{{ msg('menu.closeRight') }}</li>
      <li class="menu__sep" />
      <li :class="{ 'is-disabled': !currentTab()?.path }" @click="doCopyPath">{{ msg('menu.copyPath') }}</li>
      <li :class="{ 'is-disabled': !getHost()?.capabilities.revealInFolder }" @click="doReveal">{{ msg('menu.reveal') }}</li>
    </ul>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 32px;
  /*
   * 左右各对齐一条既有的线，不另起一套缩进：
   * - 右 10px = 顶栏的 `padding: 0 10px`，让主题开关的右缘落在窗口关闭按钮正下方（127 要求）；
   * - 左 18px = 侧栏收起后那条窄边的宽度（`.rail` 的 18px，border-box 含右框线），
   *   于是「首个标签的左边界」与「收起后窄边的右边界」是同一条竖线；
   *   没打开任何文件时「+」就是这一栏的第一个元素，同一个 padding 把它带到同一条线上。
   */
  padding: 3px 10px 0 18px;
  background: var(--hp-surface);
  border-bottom: 1px solid var(--hp-border);
}

/*
 * 140：标签区自己不再滚动（原来 `overflow-x: auto; scrollbar-width: thin`）——
 * 装不下就收纳进「+N」，横向滚动条与纵向滚动条都不该出现在这一栏。
 */
.tabbar__strip {
  display: flex;
  align-items: stretch;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.tabbar__more {
  align-self: center;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--hp-text-weak);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tabbar__more:hover,
.tabbar__more.is-on {
  border-color: var(--hp-border);
  background: var(--hp-hover);
  color: var(--hp-accent);
}

/*
 * 162（要求：「窗口过多收纳展开放在展开按钮那里，而不是放在左边」）：
 * 原来这里写死 `top: 36px; left: 18px`（照「首个标签左边界 = 收起后窄边右边界」那条对齐线放的），
 * 而那颗「+N」长在标签串尾巴上 —— 结果按钮在右、列表在左，中间隔着整栏标签。
 * 现在 `top` / `right` 由 `定位浮窗()` 算出来挂到元素上（右缘与按钮右缘齐平，两头夹住不出界），
 * 这里只留形状与滚动。`max-width` 是那道夹的兜底：窗口再窄也不捅出左右边界。
 */
.tabpicker {
  top: 36px;
  right: 8px;
  max-width: calc(100vw - 16px);
  max-height: min(60vh, 420px);
  overflow-y: auto;
  min-width: 240px;
}

.tabpicker__head {
  padding: 4px 10px;
  color: var(--hp-text-weak);
  font-size: 11px;
  cursor: default;
}

.tabpicker__head:hover {
  background: none;
}

.tabpicker__item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tabpicker__item.is-active {
  color: var(--hp-accent);
  background: var(--hp-selected);
}

.tabpicker__dot {
  color: var(--hp-accent);
  font-size: 9px;
}

.tabpicker__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 140：容量按 TAB_MIN 算，所以这里给同样的下限；宽裕时由 flex 平分到上限 */
  flex: 1 1 0;
  min-width: 96px;
  max-width: 200px;
  padding: 0 8px 0 12px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  background: transparent;
  font-size: 13px;
  color: var(--hp-text-weak);
  cursor: pointer;
  user-select: none;
}

.tab:hover {
  background: var(--hp-hover);
}

.tab.is-active {
  background: var(--hp-bg);
  border-color: var(--hp-border);
  color: var(--hp-text);
}

.tab.is-over {
  border-left: 2px solid var(--hp-accent);
}

.tab__name {
  /*
   * 140：标签等宽平分之后，名字必须**吃掉中间那段空**，× 才会落在右缘。
   * 不这么做的话 × 紧跟在名字后面，而标签的几何中心正好压在 × 上 ——
   * 点标签变成关标签（是 e2e「切标签不丢源码模式的编辑内容」先红出来的，
   * 命中测试打在 `tab__close` 上）。
   */
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab__dirty {
  color: var(--hp-accent);
  font-size: 10px;
}

.tab__close {
  padding: 0 4px;
  color: var(--hp-text-weak);
  border-radius: 3px;
}

.tab__close:hover {
  background: var(--hp-border);
  color: var(--hp-text);
}


.tabbar__new {
  /*
   * 127（要求：「图标要和旁边的大小一致」）：这三个键 —— + / 打开文件 / 齿轮 —— 是**一组**，
   * 盒子一律 26×22、图形一律 15px。原来「+」是 padding 撑出来的、文件夹是 14px、齿轮是 15px，
   * 三个尺寸各不相同，看着就像三拨东西。
   */
  align-self: center;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--hp-text-weak);
  font-size: 15px;
  line-height: 1;
}

.tabbar__new:hover {
  border-color: var(--hp-border);
  background: var(--hp-hover);
  color: var(--hp-accent);
}

/* 127：打开文件退成一颗描边图标，尺寸与「+」「齿轮」同一档 */
.tabbar__open {
  align-self: center;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--hp-text-weak);
}

.tabbar__open:hover {
  border-color: var(--hp-border);
  background: var(--hp-hover);
  color: var(--hp-accent);
}

/* 从顶栏挪过来的齿轮按钮（栏右端唯一的功能键 —— 模式切换在底栏，不在这里） */
.tabbar__settings {
  align-self: center;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  margin-left: 6px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--hp-text-weak);
}

.tabbar__settings:hover {
  border-color: var(--hp-border);
  background: var(--hp-hover);
  color: var(--hp-accent);
}

.menu-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.menu {
  position: fixed;
  min-width: 188px;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--hp-border);
  border-radius: 6px;
  background: var(--hp-surface);
  box-shadow: 0 6px 22px var(--hp-shadow);
  font-size: 13px;
}

.menu li {
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}

.menu li:hover {
  background: var(--hp-hover);
}

.menu li.is-disabled {
  color: var(--hp-text-weak);
  cursor: not-allowed;
  opacity: 0.6;
}

.menu li.is-disabled:hover {
  background: none;
}

.menu__sep {
  height: 1px;
  margin: 4px 2px;
  padding: 0;
  background: var(--hp-border);
  cursor: default;
}
</style>
