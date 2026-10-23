<script setup lang="ts">
import { t, tf } from "../i18n";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { activeMarkdown, activeTab, getHost, globalError } from "../state/documents";
import { panel, toggleCollapsed } from "../state/panel";
import {
  baseName,
  clearAllRecent,
  isUnavailable,
  openRecent,
  recent,
  refreshRecent,
  removeRecent,
  togglePin,
} from "../state/recent";
import { buildHeadingTree, type HeadingItem } from "../kernel/anchors";
import { outlineOf } from "../kernel/outline";
import { activeHeadingId, jumpTo } from "../state/viewport";
import { confirm } from "../state/dialogs";

/**
 * 侧栏：最近文件 / 当前文档大纲 双页，可整体折叠（011 + 014 + 016）。
 * 折叠后只留一条窄热区，正文补满。
 */

const collapsed = computed(() => panel.collapsed);

const tree = computed<HeadingItem[]>(() =>
  activeTab.value ? buildHeadingTree(outlineOf(activeMarkdown.value)) : []
);

/** 被折叠起来的节点 id 集合（默认全展开） */
const folded = ref<Set<string>>(new Set());

// 换文档：清掉折叠状态并刷新最近列表，不残留上一篇的树（014 验收）
watch(
  () => activeTab.value?.id,
  () => {
    folded.value = new Set();
    void refreshRecent();
  }
);

function isOpen(id: string) {
  return !folded.value.has(id);
}

function flip(id: string) {
  const next = new Set(folded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  folded.value = next;
}

async function clickRecent(path: string) {
  const ok = await openRecent(path);
  if (!ok) {
    await confirm({
      title: t("sidebar.fileUnopenable"),
      message: tf("sidebar.unopenableMsg", { name: baseName(path), path }),
      actions: [t("dialog.gotIt")],
    });
  }
}

/* ---------------- 127：最近条目的右键菜单 ---------------- */

const recentMenu = reactive({ open: false, x: 0, y: 0, path: "" });
const canReveal = computed(() => getHost()?.capabilities.revealInFolder === true);
const menuPinned = computed(() => recent.items.find((e) => e.path === recentMenu.path)?.pinned === true);

function openRecentMenu(e: MouseEvent, path: string) {
  e.preventDefault();
  recentMenu.path = path;
  recentMenu.x = e.clientX;
  recentMenu.y = e.clientY;
  recentMenu.open = true;
}

function closeRecentMenu() {
  recentMenu.open = false;
}

async function menuCopyPath() {
  const h = getHost();
  if (h && recentMenu.path) await h.writeClipboard(recentMenu.path);
  closeRecentMenu();
}

async function menuReveal() {
  const h = getHost();
  if (h?.capabilities.revealInFolder && recentMenu.path) await h.revealInFolder(recentMenu.path);
  closeRecentMenu();
}

function menuPin() {
  if (recentMenu.path) togglePin(recentMenu.path);
  closeRecentMenu();
}

function menuRemove() {
  if (recentMenu.path) removeRecent(recentMenu.path);
  closeRecentMenu();
}

/* ---------------- 127：悬停 1 秒后把被截断的全名滚出来 ---------------- */

/**
 * 她问这个方案合理不 —— 我的处理是「做，但补两处」：
 * - **只对真的被截断的行启用**（`scrollWidth > clientWidth`），短名字不该动；
 * - **同时给原生 `title`（完整路径）当兜底**：移动中的字要眼睛追着读，长名字反而更难读全，
 *   跑马灯的价值是「让人知道这里还有字」，静止可读的那份交给 title；
 * - 移出即复位（不留在中间），延时 1s 是为了鼠标扫过列表时不整列乱动；
 * - `prefers-reduced-motion` 下不滚（CSS 里关掉动画）。
 * 位移与时长写成 CSS 变量：距离每行都不一样，写死一个 -40px 会把短截断的滚过头。
 */
let marqueeTimer: ReturnType<typeof setTimeout> | null = null;

function startMarquee(e: MouseEvent) {
  const btn = e.currentTarget as HTMLElement | null;
  const name = btn?.querySelector<HTMLElement>(".recent__name");
  if (!name) return;
  if (marqueeTimer) clearTimeout(marqueeTimer);
  marqueeTimer = setTimeout(() => {
    marqueeTimer = null;
    // **到点这一刻还要认一次「指针还在这一行上」**。mouseleave 会把定时器清掉，但列表重新渲染时
    // 那条 mouseleave 可能压根没送到（换节点的 leave/enter 不成对），于是延时的尾巴会在
    // 鼠标早就离开之后才落下来 —— 表现就是「我都移开了这行还在滚」，E2E 里也复现成卡死的 is-scrolling。
    if (!btn || !btn.isConnected || !btn.matches(":hover")) return;
    const 溢出 = name.scrollWidth - name.clientWidth;
    if (溢出 <= 1) return; // 没截断就别动
    name.style.setProperty("--hp-shift", -(溢出 + 6) + "px");
    // 约 22px/秒：再快就读不上了，再慢就等得烦；最短 2.5s
    name.style.setProperty("--hp-dur", Math.max(2.5, (溢出 + 6) / 22) + "s");
    name.classList.add("is-scrolling");
  }, 1000);
}

function stopMarquee(e: MouseEvent) {
  if (marqueeTimer) {
    clearTimeout(marqueeTimer);
    marqueeTimer = null;
  }
  (e.currentTarget as HTMLElement | null)?.querySelector(".recent__name")?.classList.remove("is-scrolling");
}

onBeforeUnmount(() => {
  if (marqueeTimer) clearTimeout(marqueeTimer);
});

/** 127：三档都要能跳 —— 交给当前模式注册的跳转器（阅读按 id、编辑按第 n 个标题、源码按第 n 个标题行） */
function jump(h: HeadingItem) {
  if (!jumpTo({ id: h.id, index: h.index })) globalError.value = tf("nav.notFound", { text: h.text });
}

async function askClear() {
  const choice = await confirm({
    title: t('sidebar.clearAll'),
    message: t("sidebar.clearHint"),
    actions: [t("sidebar.clear")],
  });
  if (choice === t("sidebar.clear")) await clearAllRecent();
}

function flatten(nodes: HeadingItem[]): Array<{ node: HeadingItem; depth: number; hidden: boolean }> {
  const out: Array<{ node: HeadingItem; depth: number; hidden: boolean }> = [];
  const walk = (list: HeadingItem[], depth: number, hidden: boolean) => {
    for (const n of list) {
      out.push({ node: n, depth, hidden });
      walk(n.children, depth + 1, hidden || !isOpen(n.id));
    }
  };
  walk(nodes, 0, false);
  return out;
}
</script>

<template>
  <aside v-if="!collapsed" class="sidebar" data-testid="sidebar">
    <!--
      外壳改造后的头部：
      - 「最近 / 导航」两个页签**居中**（原来左对齐、右边塞着收起键，看着一边沉）；
      - 「大纲」改叫「导航」—— 它列的是全文标题、点的是跳转，本质是导航而不是层级摘要；
      - 收起键从页签行里拿出来，贴着**栏的右侧边**做成一条竖向把手，
        和栏的右框线对齐，位置从此不随页签文案长短移动。
      （`page-outline` 这个 testid 留着：它指的是同一页，改名不该让回归测试跟着改地址。）
    -->
    <!--
      127 第二批（她：「最近和导航各自增加图标，然后这里要再做的好看一点」）：
      - 两颗页签各带一个**画出来的**图标（时钟 = 最近，缩进列表 = 导航），不用 emoji：
        emoji 的宽高与基线随字体档变，127 的齿轮与主题开关都为此返工过；
      - 选中态从「整块蓝底药丸」换成**底部一条 accent 下划线 + 文字图标同色**：
        这一行是面板的页签，不是按钮 —— 药丸会让人以为点下去有按压反馈，
        而下划线是「你现在看的是哪一页」的通用读法（浏览器/VS Code 都是这套）；
      - hover 只给一条淡底，不抢选中态的注意力。
      （`page-outline` 这个 testid 留着：它指的是同一页，改名不该让回归测试跟着改地址。）
    -->
    <div class="sidebar__head">
      <div class="sidebar__tabs" role="tablist">
        <button
          class="sidebar__tab"
          :class="{ 'is-active': panel.page === 'recent' }"
          role="tab"
          :aria-selected="panel.page === 'recent'"
          data-testid="page-recent"
          :title="t('sidebar.recentHint')"
          @click="panel.page = 'recent'"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M8 4.6V8l2.6 1.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>{{ t('sidebar.recent') }}</button>
        <button
          class="sidebar__tab"
          :class="{ 'is-active': panel.page === 'outline' }"
          role="tab"
          :aria-selected="panel.page === 'outline'"
          data-testid="page-outline"
          :title="t('sidebar.outlineHint')"
          @click="panel.page = 'outline'"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M2.2 3.6h11.6M2.2 8h7.4M2.2 12.4h9.2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>{{ t('sidebar.outline') }}</button>
      </div>
      <button
        class="sidebar__edge"
        :title="t('sidebar.collapse')"
        data-testid="collapse-sidebar"
        @click="toggleCollapsed()"
      >
        ⟨
      </button>
    </div>

    <!-- 最近文件 -->
    <div v-if="panel.page === 'recent'" class="sidebar__body" data-testid="recent-list">
      <p v-if="recent.items.length === 0" class="placeholder">{{ t("sidebar.emptyRecent") }}</p>
      <!--
        127 第二批（她逐条点的）：
        - **只显示文件名**：目录那一行删了（列表本来就该一眼扫名字，路径靠悬停与右键）；
        - 右键出菜单：复制路径 / 打开所在文件夹 / 置顶 / 移除；
        - 置顶与删除两颗按钮**与文件名居中对齐**（单行之后 `align-items: center` 才真的成立）；
        - 文件名超长**截断**，且截断的是名字、不是按钮（`.recent__main` 给 `min-width:0`，
          按钮那一列 `flex:0 0 auto`）；
        - 悬停 1 秒后**跑马灯滚出全名**（只对真的被截断的那几行启用），
          同时 `title` 给**完整路径**作兜底 —— 移动中的字追起来其实费劲，
          原生悬停提示是静止可读的。分析写在工单里。
      -->
      <ul v-else class="recent">
        <li
          v-for="e in recent.items"
          :key="e.path"
          class="recent__item"
          :class="{ 'is-bad': isUnavailable(e.path) }"
          :data-path="e.path"
          @contextmenu="openRecentMenu($event, e.path)"
        >
          <button
            class="recent__main"
            :title="e.path"
            @click="clickRecent(e.path)"
            @mouseenter="startMarquee"
            @mouseleave="stopMarquee"
          >
            <span class="recent__name"><span class="recent__text">{{ baseName(e.path) }}</span></span>
            <span v-if="isUnavailable(e.path)" class="recent__flag is-bad" :title="t('sidebar.unavailable')">{{ t('sidebar.unavailableShort') }}</span>
          </button>
          <span class="recent__ops">
            <button
              :class="{ 'is-on': e.pinned }"
              :title="e.pinned ? t('sidebar.unpin') : t('sidebar.pin')"
              :aria-label="e.pinned ? t('sidebar.unpin') : t('sidebar.pin')"
              data-testid="recent-pin"
              @click.stop="togglePin(e.path)"
            >
              <!-- 画的五角星（140）：原来两态都靠字符 ★，置顶时旁边还多插一枚星标，
                   行宽一变星星就跟着挪 —— 换成同一盒子里的描边/实心两态，位置永远不动 -->
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M8 1.6l1.9 4.1 4.5.5-3.3 3 .9 4.4L8 11.4l-4 2.2.9-4.4-3.3-3 4.5-.5z"
                  :fill="e.pinned ? 'currentColor' : 'none'"
                  :stroke="e.pinned ? 'none' : 'currentColor'"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              :title="t('sidebar.remove')"
              :aria-label="t('sidebar.remove')"
              data-testid="recent-remove"
              @click.stop="removeRecent(e.path)"
            >
              ×
            </button>
          </span>
        </li>
      </ul>
      <button v-if="recent.items.length" class="sidebar__foot" data-testid="clear-recent" @click="askClear">
        {{ t('sidebar.clearAll') }}
      </button>
    </div>

    <!-- 大纲 -->
    <div v-else class="sidebar__body" data-testid="outline-list">
      <p v-if="!activeTab" class="placeholder" data-testid="outline-no-doc">{{ t('sidebar.noDoc') }}</p>
      <p v-else-if="tree.length === 0" class="placeholder" data-testid="outline-empty">{{ t('sidebar.noHeadings') }}</p>
      <ul v-else class="outline">
        <li
          v-for="row in flatten(tree)"
          v-show="!row.hidden"
          :key="row.node.id"
          class="outline__row"
          :class="{ 'is-active': activeHeadingId === row.node.id }"
          :style="{ paddingLeft: 6 + row.depth * 14 + 'px' }"
        >
          <button v-if="row.node.children.length" class="outline__twist" @click.stop="flip(row.node.id)">
            {{ isOpen(row.node.id) ? "▾" : "▸" }}
          </button>
          <span v-else class="outline__twist is-blank">▾</span>
          <button class="outline__link" :title="row.node.text" data-testid="outline-link" @click="jump(row.node)">
            {{ row.node.text }}
          </button>
        </li>
      </ul>
    </div>
  </aside>

  <button v-else class="rail" :title="t('sidebar.expand')" data-testid="sidebar-rail" @click="toggleCollapsed()">
    ⟩
  </button>

  <!--
    127：最近条目的右键菜单。原来「复制路径 / 在资源管理器中显示」只有标签栏有，
    而最近列表把目录那行删掉之后，这两个动作**只剩这里能做**，所以补在这里而不是让人去开标签。
  -->
  <div v-if="recentMenu.open" class="menu-mask" @click="closeRecentMenu" @contextmenu.prevent="closeRecentMenu">
    <ul class="menu" :style="{ left: recentMenu.x + 'px', top: recentMenu.y + 'px' }" @click.stop>
      <li data-testid="recent-menu-copy" @click="menuCopyPath">{{ t('menu.copyPath') }}</li>
      <li
        class="menu__item"
        :class="{ 'is-disabled': !canReveal }"
        data-testid="recent-menu-reveal"
        @click="menuReveal"
      >{{ t('menu.reveal') }}</li>
      <li class="menu__sep" />
      <li data-testid="recent-menu-pin" @click="menuPin">{{ menuPinned ? t('sidebar.unpin') : t('sidebar.pin') }}</li>
      <li data-testid="recent-menu-remove" @click="menuRemove">{{ t('sidebar.remove') }}</li>
    </ul>
  </div>
</template>

<style scoped>
.sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--hp-sidebar-w);
  flex-shrink: 0;
  background: var(--hp-surface);
  border-right: 1px solid var(--hp-border);
}

.sidebar__head {
  position: relative;
  display: flex;
  align-items: stretch;
  height: 32px;
  border-bottom: 1px solid var(--hp-border);
}

/*
 * 153（她 10-23：「继续加宽标签宽度和底部色条宽度，尽可能对齐下方滚动条左侧」，红框圈住这一行）：
 * 两颗页签从「按内容宽 + 整组居中」改成**平分这一行**，右端让出收起把手那一格。
 *
 * 原来两侧各空 44px（页签 84px 一颗，落在 44→216），整条看着往中间缩，
 * 与下方一直顶到滚动条的列表不成形。现在两颗各 ~115px，
 * 下划线（色条）跟着从 60px 变到 ~99px。
 *
 * 为什么停在把手左缘（237）而不是滚动条左缘（~247）：那 22px 是「收起侧栏」的点击区，
 * 页签压上去就点不着了 —— 她说的是"尽可能"，这一格让得起。
 */
.sidebar__tabs {
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  gap: 8px;
  flex: 1;
  min-width: 0;
  /* 让出 `.sidebar__edge` 那一格（22px），两颗页签的右缘正好停在把手左边界 */
  padding-right: 22px;
}

/*
 * 127 第二批（她：「各自增加图标，这里再做得好看一点」）：
 * 页签从「圆角药丸 + 蓝底」换成**图标 + 文字 + 底部一条 accent 下划线**，
 * 并且整颗顶满这一行（40px）—— 下划线才能落在行自己的底边上，不会浮在半空。
 * 为什么换：这一行的语义是「你现在看的是哪一页」，不是「按下去会执行什么」；
 * 药丸读起来像按钮，两颗并排的蓝药丸还在这一栏里抢注意力。
 * 图标是画的 SVG（时钟 / 缩进列表），不用 emoji —— 齿轮与主题开关都为此返工过。
 */
.sidebar__tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  padding: 0 12px;
  border: 0;
  background: transparent;
  color: var(--hp-text-weak);
  font-size: 13px;
}

.sidebar__tab svg {
  flex: 0 0 auto;
}

.sidebar__tab:hover {
  background: var(--hp-hover);
  color: var(--hp-text);
}

.sidebar__tab.is-active {
  color: var(--hp-accent);
  font-weight: 600;
}

.sidebar__tab.is-active::after {
  content: "";
  position: absolute;
  /* 153：色条跟着页签一起加宽（左右各缩 8px，原来是 12px —— 页签本身已经宽了近一半，
     再留 12px 会显得这条线"没跟着长"） */
  right: 8px;
  bottom: 0;
  left: 8px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--hp-accent);
}

/**
 * 收起把手：贴着栏的右侧边的一条竖把手，与栏的右框线对齐。
 * 高度只占头部那一格（不是整栏），这样正文滚动条区域仍是干净的直线。
 */
.sidebar__edge {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 22px;
  padding: 0;
  border: 0;
  border-left: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--hp-text-weak);
  font-size: 12px;
}

.sidebar__edge:hover {
  background: var(--hp-hover);
  border-left-color: var(--hp-border);
  color: var(--hp-accent);
}

.sidebar__body {
  flex: 1;
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
}

.sidebar__foot {
  width: 100%;
  margin-top: 6px;
  color: var(--hp-text-weak);
  font-size: 12px;
}

.recent {
  margin: 0;
  padding: 0;
  list-style: none;
}

/*
 * 127 第二批（她逐条点的）：一行只剩文件名，所以整行按**居中对齐**排；
 * 目录与时间那行删了（要路径就悬停看 title 或右键复制）。
 */
.recent__item {
  display: flex;
  align-items: center;
  border-radius: 5px;
}

.recent__item:hover {
  background: var(--hp-hover);
}

.recent__main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0; /* 关键：不给这条 0，名字会把右边两颗按钮挤出去 */
  height: 28px;
  padding: 0 4px 0 8px;
  text-align: left;
}

.recent__item.is-bad .recent__name {
  color: var(--hp-text-weak);
}

/* 名字这一列：截断的是它，不是按钮 */
.recent__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

/*
 * 悬停 1 秒后滚出全名（只对**真的被截断**的行启用，见脚本里的 `溢出 <= 1` 就 return）。
 * 位移与时长走 CSS 变量：每行截掉多少不一样，写死一个 -40px 会把只截一点的滚过头。
 * `prefers-reduced-motion` 下不滚 —— 动不了也不亏，完整路径一直在 `title` 里。
 *
 * **平时必须是 `display: inline`，只有滚起来那一刻才 `inline-block`**：
 * `text-overflow: ellipsis` 只作用在容器自己的**行内内容**上，
 * 里面若常驻一个 inline-block 的子盒子，超出部分会被直接裁掉（截图上就是「没有省略号、字被切一半」）；
 * 而 `transform` 又不作用于非替换的 inline 元素，动画那一下必须 inline-block。
 * 所以两种显示状态分开：静止 = 有省略号，滚动 = 能平移。
 */
.recent__text {
  display: inline;
  white-space: nowrap;
}

.recent__name.is-scrolling .recent__text {
  display: inline-block;
  animation: hp-marquee var(--hp-dur, 4s) ease-in-out infinite alternate;
}

@keyframes hp-marquee {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(var(--hp-shift, -40px));
  }
}

@media (prefers-reduced-motion: reduce) {
  .recent__name.is-scrolling .recent__text {
    animation: none;
  }
}

.recent__flag {
  flex: 0 0 auto;
  color: #d08a17;
  font-size: 11px;
}

.recent__flag.is-bad {
  color: var(--hp-error);
}

/*
 * 操作列**常驻占位**（透明而不是 display:none）：
 * 原来 hover 才 display:flex，鼠标一进一行名字就突然变短、还会顺手触发跑马灯 —— 抖。
 * 现在宽度不变，只有透明度跟着 hover 走。
 */
.recent__ops {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding-right: 4px;
}

/* 140：淡出从容器挪到**每颗按钮**上 —— 容器淡出时"已置顶"那颗也没法常驻，
   只能靠行内再插一枚星标，而那枚星标正是把整行推歪的元凶 */
.recent__ops button {
  opacity: 0;
  transition: opacity 120ms ease;
}

.recent__item:hover .recent__ops button,
.recent__ops button:focus-visible,
.recent__ops button.is-on {
  opacity: 1;
}

.recent__ops button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--hp-text-weak);
  font-size: 13px;
  line-height: 1;
}

.recent__ops button:hover {
  background: var(--hp-border);
  color: var(--hp-text);
}

.recent__ops button.is-on {
  color: #d08a17;
}

/* 右键菜单：与标签栏那份同一形状（作用域在组件内，各留一份比互相 import 组件省事） */
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

.recent__ops button {
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--hp-text-weak);
  font-size: 12px;
}

.outline {
  margin: 0;
  padding: 0;
  list-style: none;
}

.outline__row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 4px;
}

.outline__row.is-active {
  background: var(--hp-selected);
}

.outline__row.is-active .outline__link {
  color: var(--hp-accent);
  font-weight: 600;
}

.outline__twist {
  width: 16px;
  padding: 0;
  color: var(--hp-text-weak);
  font-size: 10px;
}

.outline__twist.is-blank {
  visibility: hidden;
}

.outline__link {
  flex: 1;
  min-width: 0;
  padding: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  text-align: left;
}

.rail {
  /* 优化：收起后这条窄栏原来 26px，还是太宽（收起的目的就是把版面还给正文）。
     18px 是「一条边 + 一个能点中的箭头」的下限，再窄就误触了。 */
  flex: 0 0 18px;
  width: 18px;
  padding: 0;
  border-right: 1px solid var(--hp-border);
  background: var(--hp-surface);
  color: var(--hp-text-weak);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.rail:hover {
  background: var(--hp-hover);
  color: var(--hp-accent);
}
</style>
