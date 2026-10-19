<script setup lang="ts">
import { t } from "../i18n";
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import { hydrate } from "../kernel/hydrate";
import { mountRender, type WidthPreset } from "../kernel/render";
import type { Host } from "../host/types";
import {
  activeTab,
  createUntitled,
  getHost,
  globalError,
  tabError,
  updateMarkdown,
  type Mode,
} from "../state/documents";
import { view } from "../state/view";
import { settings } from "../state/settings";
import { clampZoom, setZoom } from "../state/documents";
import { ZOOM_STEP } from "../kernel/render";
import { perf } from "../kernel/perf";
import { jumpToHeading, registerReadView, setHeadingJumper, syncActiveHeading } from "../state/viewport";
import { makeDomAdapter } from "../kernel/searchDom";
import SearchBar from "./SearchBar.vue";
import {
  closeSearch,
  openSearch,
  registerSearchAdapter,
  search as searchState,
  unregisterSearchAdapter,
} from "../state/search";

/**
 * CodeMirror 只在进源码模式时才需要。异步加载把它从主包（约 500KB）里拆出去，
 * 直接改善冷启动（D19）—— 阅读模式根本不该付这份钱。
 */
const SourceView = defineAsyncComponent(() => import("./SourceView.vue"));

/**
 * 102：ProseMirror 同理拆包。
 * 阅读/源码模式不加载 PM，否则 024 的冷启动基线（前端挂载 ~84ms）会被拖垮。
 */
const EditView = defineAsyncComponent(() => import("./EditView.vue"));

const props = defineProps<{ host: Host | null }>();
defineEmits<{ open: [] }>();

const documentRoot = ref<HTMLElement | null>(null);
const readScroller = ref<HTMLElement | null>(null);
const source = ref<InstanceType<typeof SourceView> | null>(null);
const edit = ref<InstanceType<typeof EditView> | null>(null);

/**
 * 118：阅读模式的查找适配器。
 * 阅读模式没有编辑器实例可注册，宿主就是这块渲染出来的 DOM，
 * 所以由本组件在「进阅读模式」时注册、离开时注销 ——
 * 编辑 / 源码两种模式的适配器由各自的组件注册（它们才有 view 实例）。
 */
let domAdapter: ReturnType<typeof makeDomAdapter> | null = null;

function ensureDomAdapter(active: boolean): void {
  if (active) {
    if (!domAdapter) domAdapter = makeDomAdapter(() => documentRoot.value, () => readScroller.value);
    registerSearchAdapter(domAdapter);
  } else if (domAdapter) {
    unregisterSearchAdapter(domAdapter);
  }
}

type CheckState = "idle" | "running" | "pass" | "fail";
const state = ref<CheckState>("idle");
const detail = ref("");

/** 宿主自检：走状态袋做一次「写-读-删」往返，两种宿主都必须可用 */
async function runSelfCheck(h: Host) {
  state.value = "running";
  const key = "selfcheck.v1";
  const probe = "hp-" + Date.now();
  try {
    await h.setState(key, probe);
    const back = await h.getState(key);
    await h.setState(key, "");
    state.value = back === probe ? "pass" : "fail";
    // i18n-allow: 宿主自检面板的诊断文本（回读值原样打印出来给人看形状），不是给她读的界面文案
    detail.value = back === probe ? "getState / setState 往返正常" : `回读不一致：${JSON.stringify(back)}`;
  } catch (e) {
    state.value = "fail";
    detail.value = e instanceof Error ? e.message : String(e);
  }
}

const currentError = computed(() => {
  const t = activeTab.value;
  return (t ? tabError.get(t.id) ?? null : null) || globalError.value || null;
});

/** 关掉当前这条错误提示：两边的来源都要清，否则清了一边另一边的还挂着 */
function dismissError(): void {
  const t = activeTab.value;
  if (t) tabError.delete(t.id);
  globalError.value = "";
}

/**
 * 回位期间暂停记录滚动。
 *
 * 内容还没撑开时设 scrollTop 会被夹小，浏览器随即发一个 scroll 事件，
 * 把夹小后的值写回标签——下一次恢复就拿到错值，位置逐次退化。
 */
let restoring = false;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

function restoreScroll(mode: Mode) {
  const tab = activeTab.value;
  if (!tab) return;
  const v = tab.scroll[mode];
  if (!v) return;
  beginRestoring();
  if (mode === "read" && readScroller.value) readScroller.value.scrollTop = v;
  if (mode === "source") {
    source.value?.setScrollTop(v);
    // CM 首帧的 heightmap 是按**估算行高**建的，测准之后会把滚动位置重新换算一遍
    // （实测：设 150 结果停在 266）。和阅读模式「hydrate 撑高后再回位一次」同一类问题，
    // 所以这里也补一帧：等到真实测量完成再钉一次位置。
    requestAnimationFrame(() => source.value?.setScrollTop(v));
  }
  // 119：编辑模式也有一份滚动（`scroll.edit` 这一槽 M1 009 就留好了，一直没接线）
  if (mode === "edit") edit.value?.setScrollTop(v);
}

/**
 * 开一段「回位窗口」：这期间滚动事件不回写标签。
 *
 * 这套闸门 M1 009 就为阅读模式立了（内容还没撑开时设 scrollTop 会被夹小，
 * 浏览器随即发一个 scroll 把夹小后的值写回标签，位置逐次退化）。
 * 124 的发现是：**源码与编辑模式那两个监听当时漏了这道闸**，
 * 所以缩放补偿在真壳里被自己夹小的值盖回去（浏览器 E2E 量不到，只差 2px；
 * WebView2 上实测漂 21px）。现在三个模式共用同一个窗口。
 */
function beginRestoring(): void {
  restoring = true;
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => (restoring = false), 350);
}

// 滚动位置**持续**记在标签上（而不是切换时抓一次）：
// 切换发生在 DOM 更新前，那时读到的还是上一篇的滚动条，容易存错标签。
function attachSourceScroll() {
  const dom = source.value?.scrollDOM();
  if (!dom || dom.dataset.hpBound === "1") return;
  dom.dataset.hpBound = "1";
  dom.addEventListener(
    "scroll",
    () => {
      const tab = activeTab.value;
      if (tab) tab.scroll.source = dom.scrollTop;
    },
    { passive: true }
  );
}

/** 119：编辑模式的滚动绑在 PM 外面的滚动容器上（不是 .ProseMirror 本身） */
function attachEditScroll() {
  const dom = edit.value?.scrollDOM();
  if (!dom || dom.dataset.hpBound === "1") return;
  dom.dataset.hpBound = "1";
  dom.addEventListener(
    "scroll",
    () => {
      const tab = activeTab.value;
      if (tab) tab.scroll.edit = dom.scrollTop;
    },
    { passive: true }
  );
}

/**
 * 上一次「真正重画」所对应的内容身份（标签 + 正文 + 主题）。
 *
 * 为什么要记这个：**缩放、正文宽度、基准字号都只是 `.hp-doc` 上的 CSS**，
 * 改它们却走一遍 `mountRender`（重新 `mdToHtml` 解析 + 整块换 DOM），
 * 既白付 ~150ms（94KB 文档实测），更要命的是换 DOM 那一瞬滚动位置会被夹掉 ——
 * 她报的「按住 Ctrl 滚轮缩放时内容上下移动」根因就在这儿，不在补偿公式上。
 * 所以内容身份没变时只改样式，DOM 一个节点都不换。
 */
let renderedKey = "";

/** 只改样式能不能覆盖这次变化？能就返回 true（DOM 不动，滚动位置天然不动） */
function patchReadStyles(zoom: number, width: WidthPreset): boolean {
  const el = documentRoot.value?.firstElementChild as HTMLElement | null;
  if (!el) return false;
  el.style.zoom = String(clampZoom(zoom));
  el.dataset.width = width;
  // 130：阅读档**不再吃「基础字号」** —— 她指出那颗与缩放重复，已从设置里删掉，
  // 字号改成编辑工具栏里的一颗、只作用编辑档。阅读档回到 CSS 默认（`reading.css` 的 15px）。
  return true;
}

// 渲染：内容或视图变化时重画阅读视图并做异步增强
watch(
  [
    () => activeTab.value?.markdown,
    () => activeTab.value?.id,
    () => activeTab.value?.mode,
    () => view.theme,
    () => activeTab.value?.zoom,
    () => activeTab.value?.width,
    // 语言也是渲染输入：阅读模式正文里那些由 JS 注入的文案（脚注标题、代码块工具条、
    // 图片失效占位）是**一次性烘进 DOM 的**，不重画就永远停在旧语言。
    // 133 那轮 i18n 只覆盖了 Vue 模板，这条是它留下的洞 —— 136-A 的判据把它钉住了。
    () => settings.lang,
    () => props.host,
  ],
  async () => {
    await nextTick();
    const tab = activeTab.value;
    const h = props.host ?? getHost();
    if (!tab || !h) return;
    if (tab.mode === "read" && documentRoot.value) {
      // 缓存键必须含**所有会烘进 DOM 的输入**。136-A 之前少了语言：watch 被 settings.lang 触发了，
      // 但这个键没变 -> 走「只补样式」的快路径直接 return，脚注标题这类 JS 注入的文案
      // 就永远停在旧语言。只在 watch 列表里加语言是不够的，键也要加。
      const key = `${tab.id}\u0000${tab.markdown}\u0000${view.theme}\u0000${settings.lang}`;
      if (key === renderedKey && patchReadStyles(tab.zoom, tab.width)) {
        syncActiveHeading();
        return;
      }
      renderedKey = key;
      const t0 = performance.now();
      mountRender(documentRoot.value, tab.markdown, {
        theme: view.theme,
        width: tab.width,
        zoom: tab.zoom,
        // 130：不再传 baseFontSize —— 字号只归编辑档的工具栏管，阅读档用默认字号 + 缩放
      });
      perf.renderMs = performance.now() - t0;
      registerReadView(readScroller.value, documentRoot.value);
      // 127：三档各自注册导航跳转器（阅读按标题 id 找 DOM）
      setHeadingJumper((h) => jumpToHeading(h.id));
      restoreScroll("read");
      syncActiveHeading();
      // 118：渲染产物换过了，适配器要重新注册并重算（DOM 是整块重建的，旧 Range 全废）
      ensureDomAdapter(true);
      // 图片与 Mermaid 出图会撑高内容：此刻再回位一次，
      // 否则会话恢复的滚动位置会被提前夹小（实测存 933 却停在顶部）
      void hydrate(documentRoot.value, { theme: view.theme, sourcePath: tab.path, host: h }).then(() => {
        if (activeTab.value?.id === tab.id && tab.mode === "read") {
          restoreScroll("read");
          syncActiveHeading();
        }
      });
    } else if (tab.mode === "source") {
      registerReadView(null, null);
      // 127：源码模式按「第 n 个 markdown 标题行」定位
      setHeadingJumper((h) => source.value?.jumpToHeadingIndex(h.index) ?? false);
      ensureDomAdapter(false);
      attachSourceScroll();
      restoreScroll("source");
    } else if (tab.mode === "edit") {
      // 编辑模式的 DOM 不归阅读渲染管：大纲跳转与滚动跟随要先解绑，
      // 否则会指着上一篇文档的旧节点（M1 014 就踩过这个坑）
      registerReadView(null, null);
      // 127：但导航照样要能用 —— 按「第 n 个标题 DOM」定位（PM 的标题没有 id）
      setHeadingJumper((h) => edit.value?.jumpToHeadingIndex(h.index) ?? false);
      ensureDomAdapter(false);
      // 119：编辑模式自己那份滚动 —— 组件是异步的，首帧 ref 可能还是 null，
      // 所以这里绑一次、`watch(edit)` 再兜一次
      attachEditScroll();
      restoreScroll("edit");
    }
  },
  { immediate: true }
);

watch(
  () => props.host,
  (h) => {
    if (h) void runSelfCheck(h);
  }
);

// SourceView / EditView 是异步组件，首帧可能还没实例化；等 ref 到位再绑滚动与回位
watch(source, (el) => {
  if (!el) return;
  attachSourceScroll();
  restoreScroll("source");
});

watch(edit, (el) => {
  if (!el) return;
  attachEditScroll();
  restoreScroll("edit");
});

function onReadScroll() {
  const tab = activeTab.value;
  if (tab && readScroller.value && !restoring) tab.scroll.read = readScroller.value.scrollTop;
  syncActiveHeading();
}

/**
 * 当前模式真正在滚的那个容器。
 * 缩放要按它做锚点补偿，所以三种模式都得拿到（原来只有阅读模式接了滚轮，
 * 编辑/源码模式下 Ctrl+滚轮 被 WebView2 当成整页缩放 —— 和状态栏的百分比对不上）。
 */
function activeScroller(): HTMLElement | null {
  const mode = activeTab.value?.mode;
  if (mode === "read") return readScroller.value;
  if (mode === "edit") return edit.value?.scrollDOM() ?? null;
  if (mode === "source") return source.value?.scrollDOM() ?? null;
  return null;
}

/**
 * Ctrl + 滚轮 = 本篇缩放（018）。三件事都得做，少一件就是她报的那个现象：
 *
 * ① **接管三种模式**。原来这个监听只挂在阅读模式的滚动容器上，
 *    编辑/源码里 Ctrl+滚轮 直接落到 WebView2 的整页缩放 ——
 *    状态栏百分比没动、画面却变了，两边对不上。
 * ② **preventDefault**。那一下同时掐掉原生滚动和浏览器整页缩放。
 *    她怀疑的「同时触发了上下滑动和缩放」，实际是下面这条造成的视觉位移，不是两条滚动逻辑打架。
 * ③ **缩放后按比例补偿滚动位置，而且必须先写进标签再改 zoom**。
 *    `zoom` 改的是布局高度，`scrollTop` 数值不变 = 视口顶端锚在别的内容上，看着就是内容上下跑。
 *    关键是**顺序**：阅读模式改 zoom 会整块重渲染，重渲染之后那次 `restoreScroll`
 *    读的是 `tab.scroll[mode]`；先 `setZoom` 再补 DOM 的话，两边各写一次、旧值还会盖回来，
 *    现象就是「一跳一跳」。所以补偿值先进标签（新渲染的回位自然拿到它），再顺手设一次 DOM
 *    （编辑模式不重渲染，靠这一次）。
 *
 * 源码模式**故意不补偿**：那一档目前不吃 `zoom`（状态栏的 +/- 也一样，是 M1 遗留的既成事实），
 * 布局没缩放却按比值改 scrollTop 只会凭空漂走一段。要连源码模式一起缩放是另一件事，
 * 已记进 124 的遗留清单，不在这里顺手改。
 */
function onWheel(e: WheelEvent) {
  const tab = activeTab.value;
  if (!e.ctrlKey || !tab) return;
  e.preventDefault();
  const step = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  const next = clampZoom(tab.zoom + step);
  if (next === tab.zoom) return;
  const dom = activeScroller();
  if (!dom || tab.mode === "source") {
    setZoom(next);
    return;
  }
  /*
   * 锚点选在**光标那一行**，不是视口顶边 —— 这是浏览器自己 Ctrl+滚轮 的做法，
   * 也是「内容没上下跑」的正确定义。
   *
   * 我第一版写的是 `scrollTop *= 新/旧`（等价于锚住视口顶边），真壳实测被判据抓出来不对：
   * 顶边锚住时，光标下方 217px 的元素按 1.1 倍必然走到 238px ——
   * 那是缩放本身的定义（越靠下摊得越开），可她看到的就是「内容上下移动」。
   * 设视口顶边的内容坐标为 C_top = scrollTop / zoom，光标处的内容坐标
   * C_cursor = (scrollTop + y) / zoom；要它缩放前后不变，就得
   * scrollTop' = C_cursor × zoom' − y = (scrollTop + y) × 比值 − y。
   */
  const y = e.clientY - dom.getBoundingClientRect().top;
  const want = Math.round((dom.scrollTop + y) * (next / tab.zoom) - y);
  beginRestoring();
  tab.scroll[tab.mode] = want;
  setZoom(next);
  // 等一帧再钉：这一帧之后新布局才量得到，设上去不会被夹
  requestAnimationFrame(() => {
    dom.scrollTop = want;
  });
}
</script>

<template>
  <main class="pane" @wheel="onWheel">
    <!-- 118：查找条浮在本篇正文右上角，三种模式共用同一个实例 -->
    <SearchBar />
    <!--
      127：错误提示要能自己关掉（她：「做个叉放右边，点击关闭当前这个错误提示」）。
      关掉只清**当前这一条**：下一次真出错照样会显示，不是把提示机制哑掉。
    -->
    <div v-if="currentError" class="pane__error" data-testid="open-error">
      {{ currentError }}
      <button
        class="pane__error-close"
        :title="t('status.closeHint')"
        :aria-label="t('status.closeHint')"
        data-testid="open-error-close"
        @click="dismissError"
      >
        ×
      </button>
    </div>

    <!-- 无标签：空态 -->
    <div v-if="!activeTab" class="pane__empty">
      <h2 class="pane__title">{{ t("empty.noDoc") }}</h2>
      <!--
        127：空态页给**两颗**按钮。她这句话里「新增一个创建按钮」是要在这张页上有个入口，
        而标签栏那颗 + 已经改成「新增标签」了 —— 两条路都调同一个 `createUntitled`，
        行为（含「复用没动过的空标签」）不会走岔。
      -->
      <div class="pane__empty-actions">
        <button class="pane__open" data-testid="new-button" @click="createUntitled">{{ t("empty.new") }}</button>
        <button class="pane__open pane__open--ghost" data-testid="open-button" @click="$emit('open')">
          {{ t("empty.open") }}
        </button>
      </div>
      <p class="placeholder">{{ t("empty.hint") }}</p>

      <ul class="pane__checks">
        <li :class="['check', 'check--' + state]">
          <span class="check__label">{{ t("empty.hostSelfCheck") }}</span>
          <span class="check__state">
            {{
              state === "pass"
                ? t("check.pass")
                : state === "fail"
                  ? t("check.fail")
                  : state === "running"
                    ? t("check.running")
                    : t("check.waiting")
            }}
          </span>
          <span v-if="detail" class="check__detail">{{ detail }}</span>
        </li>
      </ul>
    </div>

    <!-- 阅读模式 -->
    <div
      v-else-if="activeTab.mode === 'read'"
      ref="readScroller"
      class="pane__scroller"
      data-testid="read-mode"
      @scroll="onReadScroll"
    >
      <div ref="documentRoot" data-testid="document-root" />
    </div>

    <!-- 源码模式（127：回写不再经这里 —— SourceView 按标签 id 直接写 store，见其注释） -->
    <div v-else-if="activeTab.mode === 'source'" class="pane__source" data-testid="source-mode">
      <SourceView
        ref="source"
        :tab-id="activeTab.id"
        :model-value="activeTab.markdown"
        :dark="view.theme === 'dark'"
      />
    </div>

    <!-- 所见即所得（102 渲染外壳 · 104 起按块回写） -->
    <EditView
      v-else
      ref="edit"
      :tab-id="activeTab.id"
      :markdown="activeTab.markdown"
      :theme="view.theme"
      :width="activeTab.width"
      :zoom="activeTab.zoom"
      :base-font-size="settings.baseFontSize"
      @fontsize="(v: number) => (settings.baseFontSize = v)"
      @update:model-value="updateMarkdown"
    />
  </main>
</template>

<style scoped>
.pane {
  position: relative; /* 118：查找条浮层的定位基准 */
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--hp-bg);
}

.pane__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.pane__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.pane__open {
  margin-top: 4px;
  padding: 6px 18px;
  border: 1px solid var(--hp-accent);
  border-radius: 6px;
  background: var(--hp-accent);
  color: var(--hp-on-accent);
}

.pane__open:hover {
  background: #1f3d64;
}

/* 127：空态页两颗按钮 —— 「新建」是主动作，「打开文件」退成描边，免得两张实心按钮打架 */
.pane__open--ghost {
  background: transparent;
  color: var(--hp-accent);
}

.pane__open--ghost:hover {
  background: var(--hp-hover);
}

.pane__empty-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.pane__error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--hp-error-border);
  background: var(--hp-error-bg);
  color: var(--hp-error);
  font-size: 13px;
}

/* 关闭这条提示的叉：靠右放（她的要求），尺寸够点但不抢正文 */
.pane__error-close {
  margin-left: auto;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.pane__error-close:hover {
  border-color: var(--hp-error-border);
  background: var(--hp-hover);
}

.pane__scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.pane__source {
  flex: 1;
  min-height: 0;
  background: var(--hp-surface);
}

.pane__checks {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  width: min(420px, 90%);
}

.check {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: baseline;
  padding: 8px 10px;
  border: 1px solid var(--hp-border);
  border-radius: 6px;
  background: var(--hp-surface);
  font-size: 13px;
}

.check__state {
  color: var(--hp-text-weak);
}

.check--pass .check__state {
  color: #2e7d46;
}

.check--fail .check__state {
  color: var(--hp-error);
}

.check__detail {
  color: var(--hp-text-weak);
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
