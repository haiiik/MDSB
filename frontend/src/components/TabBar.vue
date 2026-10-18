<script setup lang="ts">
import { t as msg } from "../i18n";
import { reactive } from "vue";
import ThemeToggle from "./ThemeToggle.vue";
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
 * 外壳改造后的布局（她的几轮要求叠在一起）：
 * - 「+」跟着最后一个标签走（原来钉在栏的右端，标签少时离得太远）；
 * - 127：「+」的语义从「打开文件」改成「**新增标签**」（建一份未命名空文档，直接可输入）；
 *   打开文件退到它右边一颗描边文件夹图标上 —— 入口没少，只是不再和「+」挤成同一颗；
 * - 设置从顶栏挪到这里、画成齿轮（顶栏只留品牌 + 拖动区 + 窗口三键）；
 * - 127：主题开关挂在齿轮右手边（`ThemeToggle.vue`），设置对话框里那条主题删掉了；
 * - 栏右端**不再有模式切换按钮**（125 按她的口径 Q10 删掉：模式入口只留底栏那三个直达按钮，
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
    <div
      v-for="(t, i) in tabs.list"
      :key="t.id"
      class="tab"
      :class="{ 'is-active': t.id === tabs.activeId, 'is-over': drag.over === i }"
      :draggable="true"
      @click="activate(t.id)"
      @mousedown.middle="onMiddle($event, t.id)"
      @dblclick="emit('close', t.id)"
      @contextmenu="onContext($event, t.id)"
      @dragstart="drag.from = i"
      @dragover.prevent="drag.over = i"
      @drop="onDrop(i)"
      @dragend="drag.from = -1; drag.over = -1"
    >
      <span v-if="isDirty(t)" class="tab__dirty" :title="msg('tab.dirty')" data-testid="tab-dirty">●</span>
      <span class="tab__name">{{ t.name }}</span>
      <button class="tab__close" :title="msg('tab.close')" aria-label="关闭标签" @click.stop="emit('close', t.id)">
        ×
      </button>
    </div>
    <!--
      127：这颗「+」**不再是打开文件**，按她的口径改成「新增标签」——
      点下去开一份未命名的空 Markdown，直接进编辑档、可以打字（`createUntitled`）。
      打开文件没被删掉，它就在右边那颗描边文件夹上。
    -->
    <button
      class="tabbar__new"
      :title="msg('tab.newTabHint')"
      aria-label="新增标签"
      data-testid="tab-new"
      @click="createUntitled()"
    >
      +
    </button>
    <!--
      这颗是她这条改动带出来的**取舍**，不是我自己加的第三种按钮：
      按原话「打开文件按钮调整为新增标签」，标签栏就没有打开入口了，
      只剩空态页那颗按钮 + Ctrl+O —— 已经开着文档时想再开一个只能记快捷键。
      所以这里补一颗描边的「打开文件」图标保住可见入口（testid 仍是 tab-open，回归用例不用改地址）。
      要不要留她说了算，删它就是一行的事，已写进 127 的待决清单。
    -->
    <button
      class="tabbar__open"
      :title="msg('tab.openHint')"
      aria-label="打开文件"
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
    <div class="tabbar__spacer" />
    <!--
      设置：标签栏右端的齿轮（124 从顶栏挪过来）。
      路径是**算出来的**（8 齿、齿根 r=5.5、齿顶 r=7.3、中心孔 r=2.3，16×16 viewBox），
      不是我手描的 —— 第一版手描的两条 path 方向相同，默认 nonzero 填充规则下
      中心孔根本没挖出来，看起来就是一坨带棱角的东西（她说「图标不对」的真相）。
      现在孔是**反向绕**的第二个子路径，nonzero 下自然成洞。
    -->
    <button
      class="tabbar__settings"
      :title="msg('tab.settingsHint')"
      aria-label="设置"
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
   * - 右 10px = 顶栏的 `padding: 0 10px`，让主题开关的右缘落在窗口关闭按钮正下方（127 她的要求）；
   * - 左 18px = 侧栏收起后那条窄边的宽度（`.rail` 的 18px，border-box 含右框线），
   *   于是「首个标签的左边界」与「收起后窄边的右边界」是同一条竖线；
   *   没打开任何文件时「+」就是这一栏的第一个元素，同一个 padding 把它带到同一条线上。
   */
  padding: 3px 10px 0 18px;
  background: var(--hp-surface);
  border-bottom: 1px solid var(--hp-border);
  overflow-x: auto;
  scrollbar-width: thin;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
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

.tabbar__spacer {
  flex: 1;
  min-width: 8px;
}

.tabbar__new {
  /*
   * 127（她：「图标要和旁边的大小一致」）：这三个键 —— + / 打开文件 / 齿轮 —— 是**一组**，
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
