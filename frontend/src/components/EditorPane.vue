<script setup lang="ts">
import { t } from "../i18n";
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import { hydrate } from "../kernel/hydrate";
import { domTopAnchor, ratioOf, scrollTopFor, scrollDomToAnchor, type 锚 } from "../kernel/anchors";
import { mountRender, type WidthPreset } from "../kernel/render";
import type { Host } from "../host/types";
import {
  activeTab,
  createUntitled,
  getHost,
  globalError,
  tabError,
  tabs,
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
import OutputActions from "./OutputActions.vue";
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

/** 各档的滚动容器（读几何要用，别只记 scrollTop） */
function scrollerOf(mode: Mode): HTMLElement | null {
  if (mode === "read") return readScroller.value;
  if (mode === "source") return source.value?.scrollDOM() ?? null;
  return edit.value?.scrollDOM() ?? null;
}

/**
 * 每个标签**在每一档最后一次可见时的几何**（内容高 / 视口高）。
 * 换档那一刻旧档的 DOM 往往已经没了，所以不能到时候才去量 —— 滚动事件里顺手记。
 * 键是「标签 + 档」而不是只有档：三档的容器在标签之间是复用的，
 * 只按档记的话，甲篇滚出来的锚点会被乙篇的换档用掉（140 那条时序用例实测就是这个）。
 */
const geom = new Map<string, { content: number; view: number }>();
/** 这篇文档上一次停在哪一档（按标签记，切标签不该做位置换算） */
const lastMode = new Map<string, Mode>();

/**
 * 各档「视口顶端那一段」的锚点 —— 换档后要找回来的是**内容位置**，不是像素。
 * 150 起它是「哪一块 + 块内滚过了多少」，只记文字前缀会把停在高块里的位置整段丢掉。
 */
const anchorByMode = new Map<string, 锚 | null>();

/** 「标签 × 档」这把复合键：锚点与几何都得按篇分，理由见上面那条注释 */
const gk = (tabId: string, mode: Mode) => tabId + "|" + mode;

/**
 * 阅读档的块选择器。渲染容器就在本组件的模板里（不是懒加载档位），
 * 所以这条留在外壳；编辑/源码两档的选择器**归各自组件**，
 * 免得这些内部类名被写进主入口 chunk（冷启动分包那条判据按内容查，泄漏一次红一次）。
 */
const READ_BLOCK_SEL = ".hp-doc > *";
/** 150：顶层块配不上时的第二级候选（源码档一行 = 一块，键对不上整张表） */
const READ_FALLBACK_SEL = ".hp-doc tr, .hp-doc li";

/** 问某一档「你视口顶端是哪一段、那块内部滚过了多少」；档位组件还没挂上就返回 null（换档那刻走比例兜底） */
function topAnchor(mode: Mode): 锚 | null {
  if (mode === "read") return domTopAnchor(readScroller.value, READ_BLOCK_SEL);
  if (mode === "edit") return edit.value?.topAnchor() ?? null;
  return source.value?.topAnchor() ?? null;
}

/** 把「顶端那一段字」所在的那一块滚到上沿（带块内偏移）；`near` 是比例预测的位置，用来在同名块里挑最近的那个 */
function applyAnchor(mode: Mode, a: 锚 | null, near: number): boolean {
  if (!a || !a.键) return false;
  if (mode === "read")
    return scrollDomToAnchor(readScroller.value, READ_BLOCK_SEL, a, near, READ_FALLBACK_SEL);
  if (mode === "edit") return edit.value?.applyAnchor(a, near) ?? false;
  return source.value?.applyAnchor(a, near) ?? false;
}

/**
 * 记一次「这一档此刻的几何 + 视口顶端那段字」。
 *
 * 两个都**同步**做完，不留到下一帧：140 第一版把锚点改成 rAF 合并（省得每帧遍历块做
 * getBoundingClientRect），真壳里立刻红 —— WebView2 里滚动是平滑动画、rAF 又可能被节流，
 * 换档那一刻读到的锚点是**动画中途**那一段（探针实测：阅读档停在铺垫 30，源码档落到铺垫 22）。
 * 正确性优先：换档时用户能接受的代价是几毫秒的遍历，不是落错段。
 */
function noteGeom(mode: Mode): void {
  const tab = activeTab.value;
  const el = scrollerOf(mode);
  if (!tab || !el) return;
  geom.set(gk(tab.id, mode), { content: el.scrollHeight, view: el.clientHeight });
  if (el.clientHeight > 0) anchorByMode.set(gk(tab.id, mode), topAnchor(mode));
}

/**
 * 一次「刚换档」的定位请求：**优先按内容锚点**（顶端那一段字），比例只兜底。
 *
 * 为什么不能只用比例：三档内容高度不同（渲染 DOM / PM / 源码行），
 * 比例换算在真壳里实测差到 3 段（浏览器 E2E 恰好看不出来 —— 桌面第 19 段先红的）。
 *
 * 为什么要留着而不是当场算完就丢：目标档的 DOM 常常还没测准 ——
 * 编辑/源码是异步组件（第一次回位时 ref 还是 null）、CM 首帧按**估算行高**建 heightmap
 * （实测「设 150 停在 266」）、阅读档 hydrate 完图片与 Mermaid 还会撑高。
 * 所以一笔换档最多兑现 4 帧（每帧都重新按文字找一次落点），用户自己滚一下就作废。
 */
let pending: { tabId: string; mode: Mode; 锚: 锚; ratio: number; applied: number } | null = null;

/** 换档后补的那几帧 */
const RESTORE_FRAMES = 4;

/**
 * 下一帧再落一次：**必须认得当初那张档**。
 * rAF 排出去到执行之间用户可能已经切了标签，那时 `activeTab` 是别的文档，
 * 拿旧 needle 去换算就是「落到上上次的位置」（review 抓的这条泄漏）。
 */
function scheduleSecondFrame(tabId: string, mode: Mode): void {
  requestAnimationFrame(() => {
    if (activeTab.value?.id !== tabId) {
      pending = null;
      return;
    }
    restoreScroll(mode);
  });
}

function restoreScroll(mode: Mode) {
  const tab = activeTab.value;
  if (!tab) return;
  /*
   * 146：查找条开着且有当前项时，**位置由那一处说了算**。
   * 换档那一刻新适配器注册会自己把当前项滚进视野（`apply(..., reveal=true)`），
   * 这时再按「视口顶端那一段」的锚点落一次，就把正看着的那一带推出了视野 ——
   * 原始诉求：「查找功能查找后，切换模式时，显示位置发生变化了」。
   * 140 那套锚点管的是"没开查找时换档落在同一段"，两件事不冲突：查找条一关就恢复走锚点。
   */
  if (searchState.open && searchState.current >= 0 && scrollerOf(mode)) {
    lastMode.set(tab.id, mode);
    return;
  }
  const from = lastMode.get(tab.id);
  const el = scrollerOf(mode);
  let v = tab.scroll[mode];
  if (pending && pending.tabId === tab.id && pending.mode === mode && el) {
    // ① 换算还没兑现完：按**当前**几何与**当前**顶端那段字再落一次
    const near = scrollTopFor(pending.ratio, el.scrollHeight, el.clientHeight);
    v = applyAnchor(mode, pending.锚, near) ? el.scrollTop : near;
    tab.scroll[mode] = v;
    pending.applied++;
    /*
     * 「落点两次一样就收」在源码档不成立：CM **没滚到过的区域一直用估算行高**，
     * 估算值稳定地错（本机 175% 缩放下每行差不到 1px，攒到第 60 行就是 8 段的偏差），
     * 稳定 ≠ 测准了。所以固定补满几帧：每帧重新按文字找一次落点，
     * CM 测准之后自然落到真正的那一行；重复应用同一个值不花钱。
     */
    if (pending.applied >= RESTORE_FRAMES) pending = null;
    else scheduleSecondFrame(tab.id, mode);
  } else if (from && from !== mode && el) {
    // ② 换档那一刻：新事务开始，上一笔没兑现完的一律作废
    pending = null;
    const g = geom.get(gk(tab.id, from));
    const a = anchorByMode.get(gk(tab.id, from)) ?? null;
    const r = g ? ratioOf(tab.scroll[from], g.content, g.view) : 0;
    const near = scrollTopFor(r, el.scrollHeight, el.clientHeight);
    if (applyAnchor(mode, a, near)) {
      pending = { tabId: tab.id, mode, 锚: a!, ratio: r, applied: 1 };
      v = el.scrollTop;
      // 目标档的 DOM 这会儿常常还没测准（CM 首帧按估算行高建 heightmap、
      // 阅读档 hydrate 完图还会撑高），所以补第二帧 —— 放在这里而不是 `if (!v)` 之后，
      // 否则「锚点落在文档第一块（v=0）」那条早退路径会把第二帧吞掉
      scheduleSecondFrame(tab.id, mode);
    } else {
      // 没有可用锚点（比如顶端那块是图片）：比例一次算完，不再补第二帧
      v = near;
    }
    tab.scroll[mode] = v;
  }
  // 目标档还没挂上时**不推进** lastMode，等异步组件挂载后补的那一次回位再来
  if (el) lastMode.set(tab.id, mode);
  if (!v) {
    /*
     * 落点是 0，但容器**不停在 0** 时也要真的落下去。
     * 阅读/编辑/源码那三个容器在标签之间是**复用**的：甲篇滚到 700，再打开乙篇（乙自己记的是 0），
     * 原来「没值就 return」会让视口停在 700 —— 用户看到的就是「新打开的文档一上来就在半空中」。
     * （140 那条「换档当帧切标签」的时序用例抓到的就是它。）
     * 已经贴在顶上时什么都不做：那就不必开 350ms 的回位窗口，免得把用户紧接着的那一下滚动吞掉。
     */
    const el2 = scrollerOf(mode);
    if (el2 && el2.scrollTop > 0) {
      beginRestoring();
      if (mode === "read") readScroller.value!.scrollTop = 0;
      if (mode === "source") source.value?.setScrollTop(0);
      if (mode === "edit") edit.value?.setScrollTop(0);
    }
    noteGeom(mode);
    return;
  }
  beginRestoring();
  if (mode === "read" && readScroller.value) readScroller.value.scrollTop = v;
  if (mode === "source") source.value?.setScrollTop(v);
  if (mode === "edit") edit.value?.setScrollTop(v);
  noteGeom(mode);
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
      noteGeom("source");
      // 用户自己滚了（不在回位窗口里）→ 那次跨档换算就作废
      if (!restoring) pending = null;
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
      noteGeom("edit");
      if (!restoring) pending = null;
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
 * 报的「按住 Ctrl 滚轮缩放时内容上下移动」根因就在这儿，不在补偿公式上。
 * 所以内容身份没变时只改样式，DOM 一个节点都不换。
 */
let renderedKey = "";

/** 只改样式能不能覆盖这次变化？能就返回 true（DOM 不动，滚动位置天然不动） */
function patchReadStyles(zoom: number, width: WidthPreset): boolean {
  const el = documentRoot.value?.firstElementChild as HTMLElement | null;
  if (!el) return false;
  el.style.zoom = String(clampZoom(zoom));
  el.dataset.width = width;
  // 130：阅读档**不再吃「基础字号」** —— 指出那颗与缩放重复，已从设置里删掉，
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
  focusEmptyDoc();
});

/**
 * 141：新建未命名档时，光标要**真的在文档里**。
 *
 * 之前点「+」之后焦点还留在按钮上，工具栏显示着「正文」但文档里没有光标，
 * 而空白处又点不进去（见 EditView 那条样式注释）—— 用户就只能干看着。
 * EditView 是异步组件，刚切过去时 ref 还是 null，所以按帧重试；
 * 只在「一个字没写过 + 编辑档」这两个条件同时成立时才抢焦点，
 * 别的场合（打开有字的文档、切标签、切模式）一律不动用户现有的焦点与位置。
 *
 * 142 把条件里的「未命名」去掉了：**打开一篇空文件是同一条路径**。
 * 桌面与浏览器实测都一样 —— 底栏那颗「编辑」按钮点完焦点还在按钮上，
 * 空档里第一个字打不出去，而接着按 Enter / Tab 会**把模式按钮再点一次**（模式当场跳走）。
 */
function focusEmptyDoc(tries = 12): void {
  const t = activeTab.value;
  if (!t || t.markdown !== "" || t.mode !== "edit") return;
  if (edit.value?.focusStart()) return;
  if (tries > 0) requestAnimationFrame(() => focusEmptyDoc(tries - 1));
}

/**
 * 换标签就是一次新的阅读，不是换档 —— 上一张档没兑现完的那笔换算必须作废，
 * 否则它会在这一张档上按**别的文档的**文字去找落点（`scheduleSecondFrame` 里那条
 * tabId 守卫挡的是回调，这里挡的是「下一次 restoreScroll 撞上旧 pending」）。
 */
watch(
  () => activeTab.value?.id,
  () => {
    focusEmptyDoc();
    pending = null;
    // 关掉的标签不该继续占着几何与锚点：按现存的标签集合裁一次
    const 活着 = new Set(tabs.list.map((t) => t.id));
    for (const key of [...geom.keys(), ...anchorByMode.keys()]) {
      if (!活着.has(key.split("|")[0])) {
        geom.delete(key);
        anchorByMode.delete(key);
      }
    }
  }
);

function onReadScroll() {
  const tab = activeTab.value;
  if (tab && readScroller.value && !restoring) {
    tab.scroll.read = readScroller.value.scrollTop;
    pending = null; // 同上：人已经自己滚了，就别再按旧比例回拉
  }
  // 几何要**无条件**记：换档前最后一帧往往还在回位窗口里，跳过就拿着旧高度去换算位置
  noteGeom("read");
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
 * Ctrl + 滚轮 = 本篇缩放（018）。三件事都得做，少一件就是报来的那个现象：
 *
 * ① **接管三种模式**。原来这个监听只挂在阅读模式的滚动容器上，
 *    编辑/源码里 Ctrl+滚轮 直接落到 WebView2 的整页缩放 ——
 *    状态栏百分比没动、画面却变了，两边对不上。
 * ② **preventDefault**。那一下同时掐掉原生滚动和浏览器整页缩放。
 *    怀疑的「同时触发了上下滑动和缩放」，实际是下面这条造成的视觉位移，不是两条滚动逻辑打架。
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
   * 那是缩放本身的定义（越靠下摊得越开），可肉眼看到的就是「内容上下移动」。
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
 127：错误提示要能自己关掉（要求：「做个叉放右边，点击关闭当前这个错误提示」）。
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
 127：空态页给**两颗**按钮。这句话里「新增一个创建按钮」是要在这张页上有个入口，
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

    </div>

    <!-- 阅读模式 -->
    <template v-else-if="activeTab.mode === 'read'">
      <!--
 147（要求：「阅读模式那个地方也应该有个栏，即使空着，也能让阅读模式和编辑模式的
        初始高度一致」）：编辑档顶上那条工具栏占一行，阅读档以前没有这一行，
        于是同一篇文档切个模式，正文整体上下跳一行（144 修的是块内上边距，这一行是容器偏移，两回事）。
        这里补一条**同高的**栏：盒模型（内边距 / 下框线 / 底色 / 字号）与编辑档那条
        取自同一批 `:root` 变量，里面的按钮与工具栏按钮同一个盒子（同样的上下内边距 + 1px 边框 + 同一行高），
        所以两边的高度都由"字体 + 行高 + 内边距 + 边框"算出来，不是硬写一个 px 数。
        2026-10-26 起这条栏不再是空的：右端放 154/155/156 三颗动作（打印 / 导出 HTML / 导出 PDF），
        位置就按截图圈的那一条。
      -->
      <div class="edit-toolbar edit-toolbar--ghost" data-testid="read-toolbar-ghost">
        <OutputActions />
      </div>
      <div
        ref="readScroller"
        class="pane__scroller"
        data-testid="read-mode"
        @scroll="onReadScroll"
      >
        <div ref="documentRoot" data-testid="document-root" />
      </div>
    </template>

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

/* 关闭这条提示的叉：靠右放（要求），尺寸够点但不抢正文 */
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

/*
 * 147：阅读档顶上那条栏。盒模型与编辑档的 `.edit-toolbar` 逐项一致，
 * 尺寸全部取自 :root 那批变量（两档同一份来源，改一处两边跟着走）。
 * 栏里的三颗动作（`OutputActions.vue`）用的是与工具栏按钮同一批内边距 / 边框 / 行高，
 * 所以两边的高度都由"字体 + 行高 + 内边距 + 边框"算出来，不是硬写一个 px 数。
 * （以前这里是一个 `.edit-toolbar__sizer` 空格占位元素 —— 2026-10-26 那条栏放上了动作，占位不再需要。
 *  留个记录：占位时期踩过"空 `<span>` 没有行盒、行高不起作用、那条栏矮 16px"的坑。）
 */
.edit-toolbar--ghost {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: var(--hp-toolbar-pad-y) var(--hp-toolbar-pad-x);
  border-bottom: 1px solid var(--hp-border);
  background: var(--hp-bg);
  font-size: var(--hp-toolbar-font);
  /* 与编辑档那条工具栏同一个行高来源（写在容器上，理由见 EditToolbar.vue 那条注释） */
  line-height: var(--hp-toolbar-line);
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

</style>
