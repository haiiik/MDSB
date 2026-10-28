<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Node as PMNode } from "prosemirror-model";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import type { DirectEditorProps } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";
import { patch } from "../kernel/blockPatch";
import { domTopAnchor, scrollDomToAnchor, type 锚 } from "../kernel/anchors";
import { mdastToDoc } from "../kernel/pm/mdastToDoc";
import { codeBlockNodeView, mathBlockNodeView, codeFoldWatchPlugin } from "../kernel/pm/nodeViews";
import { hpInputRules } from "../kernel/pm/inputRules";
import { HISTORY_GROUP_DELAY_MS, isTypingTransaction } from "../kernel/pm/history";
import { richPastePlugin } from "../kernel/pm/pastePlugin";
import { undoInputRule } from "prosemirror-inputrules";
import {
  documentShapePlugin,
  ensureTrailingParagraph,
  footnoteJumpPlugin,
  listKeymap,
  tableEnterKeymap,
  tabKeymap,
  taskListPlugin,

} from "../kernel/pm/plugins";
import { tableMenuPlugin } from "../kernel/pm/tableMenu";
import { changedBlocks } from "../kernel/pm/patches";
import { hpSchema } from "../kernel/pm/schema";
import {
  blockCommand,
  insertDocLinkCommand,
  linkCommand,
  toggleBold,
  toggleItalic,
  toolbarState,
  type BlockTarget,
  type ToolbarState,
} from "../kernel/pm/toolbar";
import { noteEditCommit, noteEditMount } from "../kernel/perf";
import { resolveImages } from "../kernel/hydrate";
import { clampZoom, type ThemeName, type WidthPreset } from "../kernel/render";
import { makePmAdapter, searchHighlightPlugin } from "../kernel/pm/searchHighlight";
import { getHost } from "../host";
import { activePath, globalError } from "../state/documents";
import { savePastedImage } from "../state/images";
import {
  HINT_SOURCE_TO_EDIT,
  canReuseEdit,
  dropEdit,
  peekEdit,
  pushModeHint,
  stashEdit,
} from "../state/modeInstances";
import {
  recomputeSearch,
  registerSearchAdapter,
  search as searchState,
  unregisterSearchAdapter,
} from "../state/search";
import DocLinkPicker from "./DocLinkPicker.vue";
import EditToolbar from "./EditToolbar.vue";

/**
 * 102 渲染外壳 + 104 的工作文本回写口径（作者 2026-10-14 采纳）。
 *
 * 口径四句话：
 * 1. `tab.markdown` 仍是唯一真源，保存链路与脏判定一律不碰（那是 M1 006 的保真闸门）；
 * 2. 每次 PM 事务：`changedBlocks(旧doc, 新doc)` 找出真变了的块；
 * 3. 以**上一版工作文本**为基准做 `patch`（不是磁盘原文 —— 否则前一次改动会被覆盖）；
 * 4. patch 结果回写 `tab.markdown`。未编辑的块永远不进序列化器。
 *
 * 异步组件：ProseMirror 只在进这个模式时才加载，阅读/源码模式不付这份钱
 * （024 的冷启动基线依赖这一点）。
 */

const props = defineProps<{
  /** 119：撤销栈按标签持有，所以要知道自己是哪个标签的 */
  tabId: string;
  markdown: string;
  theme: ThemeName;
  width: WidthPreset;
  zoom: number;
  baseFontSize?: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [text: string];
  /** 130：字号从设置里搬进编辑工具栏，值仍存在上层（settings），这里只做中转 */
  fontsize: [px: number];
}>();

/* ---------- 113：工具栏（按钮的语义全在 kernel/pm/toolbar.ts，这里只接线） ---------- */

/**
 * PM 的 state 不是响应式的，工具栏的高亮/置灰要跟着选区与文档变，
 * 所以每次事务后把这个计数器 +1，`tbState` 靠它重算。
 */
const tbRev = ref(0);

const IDLE: ToolbarState = {
  block: "paragraph",
  level: null,
  list: null,
  checked: null,
  bold: false,
  italic: false,
  inCode: false,
  inTable: false,
};

const tbState = computed<ToolbarState>(() => {
  void tbRev.value; // 依赖只是「刷一次」的信号，值本身不参与计算
  return view ? toolbarState(view.state) : IDLE;
});

function runCommand(cmd: Command) {
  if (!view) return;
  if (cmd(view.state, (tr) => view?.dispatch(tr))) view.focus();
}

function onBlock(target: BlockTarget) {
  runCommand(blockCommand(target));
}

function onMark(which: "bold" | "italic") {
  runCommand(which === "bold" ? toggleBold() : toggleItalic());
}

function onLink(href: string) {
  runCommand(linkCommand(href));
}

/** 137：「插入文档链接」弹层。开合状态放这一层，弹层自己只管选人、不管光标 */
const doclinkOpen = ref(false);

function onDocLinkInsert(payload: { text: string; href: string }) {
  doclinkOpen.value = false;
  runCommand(insertDocLinkCommand(payload.text, payload.href));
  // 弹层关掉后焦点必须回编辑器，否则接着打字会打到窗口上（EditToolbar 那排按钮同理）
  view?.focus();
}

const scroller = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
let article: HTMLElement | null = null;
let mountPoint: HTMLElement | null = null;
let view: EditorView | null = null;
let pmAdapter: ReturnType<typeof makePmAdapter> | null = null;

/**
 * 119：这份视图现在代表哪个标签。
 * 切标签时 `tabId` 与 `markdown` **同时**变，只看后者会把「换标签」
 * 误判成「外部改了内容」，于是把上一个标签的撤销栈当脏数据重建掉。
 */
let mountedTabId: string | null = null;

/**
 * 回写基准。
 *
 * **基准不滚动**：`sourceText` 是「当前 PM 文档是从哪份文本解析出来的」，
 * 在它被重建之前一直不变。块区间（`srcFrom/srcTo`）是那份文本的字符偏移，
 * 一旦拿它去切「已经回写过一次」的文本，偏移就全体错位 ——
 * 实测症状是每敲一次字都把上一次的插入吞回来一份，写成 `（补一句）（补一句（补一（补（`。
 *
 * `lastEmitted` 单独存在，是为了让 emit 出去又绕回来的那一次 prop 变化
 * 不触发重建（重建会打掉光标和撤销栈）。
 */
let sourceText = props.markdown;
let sourceDoc: PMNode | null = null;
let lastEmitted = props.markdown;

/** 与阅读模式同一套外壳：`.hp-doc` + data-theme/data-width + CSS zoom */
function syncShell() {
  if (!article) return;
  article.dataset.theme = props.theme;
  article.dataset.width = props.width;
  article.style.zoom = String(clampZoom(props.zoom));
  if (props.baseFontSize) article.style.setProperty("--hp-font-base", props.baseFontSize + "px");
}

/**
 * 一次事务落定后回写。
 *
 * 关键：**不整篇序列化**。`changedBlocks` 没点名任何块时直接返回，
 * 这样「进编辑模式但什么都没改」不会让文档变脏（104 的恒等判据）。
 */
function commit() {
  if (!view || !sourceDoc) return;
  const t0 = performance.now();
  const patches = changedBlocks(sourceDoc, view.state.doc, sourceText);
  noteEditCommit(performance.now() - t0);
  // **无条件**算一遍：0 个 patch 时 `patch` 恒等返回基准文本。
  // 不能在这里提前 return —— 用户把改动删回原样后 patches 变空，
  // 若不发 emit，`tab.markdown` 会停在脏的那一版，脏点永远熄不掉（实测踩过）。
  const text = patch(sourceText, patches);
  if (text === lastEmitted) return;
  lastEmitted = text;
  emit("update:modelValue", text);
}

function buildState(md: string) {
  return EditorState.create({
    schema: hpSchema,
    // 142：末尾补一行「能写字的行」，**必须在 `sourceDoc = state.doc` 之前**做完。
    // 只靠插件的 appendTransaction 补，它就落在 sourceDoc 之外 ——
    // 于是打开一篇以表格结尾的文件、只改一个错别字，也会在文件末尾多出两行空白
    // （空段落作为「相对基准的新块」按纯插入回写）。104 的恒等判据不允许这样。
    doc: ensureTrailingParagraph(mdastToDoc(md, hpSchema)),
    // 105 的教训：只给 schema + doc 是**不能用的编辑器**。
    // 打字能进是靠 beforeinput，而 Enter 拆块、Backspace 合并块这些是**命令**，
    // 没有 keymap 就没人绑定，表现成「按回车没反应」且完全不报错。
    // 顺序有讲究：listKeymap 必须在 baseKeymap 之前，否则 Enter 先被它吃掉。
    plugins: [
      // 118：查找高亮。走 decorations 而不是改文档 —— 查找是视图状态，
      // 进了模型就会被回写进 .md 文件。
      searchHighlightPlugin(),
      // 117：撤销/重做。`prosemirror-history` 从 M1 起就躺在依赖里，
      // 但**从没进过 state** —— 所以此前 Ctrl+Z 完全没反应（baseKeymap 里没有 undo，
      // 那是 example-setup 的活）。合并窗口见 `kernel/pm/history.ts` 的注释。
      history({ newGroupDelay: HISTORY_GROUP_DELAY_MS }),
      hpInputRules(),
      // 116：剪贴板里的图片先落盘（同级 assets/、时间戳序号、按字节哈希去重），
      // 再作为行内图片插进选区。失败要说给用户，不能悄悄吞一张图。
      richPastePlugin({ saveImage: savePastedImage, onImageError: (m) => (globalError.value = m) }),
      // 113：两条抢在 baseKeymap 之前的键位。
      // - Backspace：刚被输入规则转换过的块按退格撤回原样（插件自带的 undoInputRule，
      //   与 117 的 Ctrl+Z 是两回事）。命令返回 false 时 PM 继续往下找 keymap，普通退格不受影响。
      // - Ctrl+B / Ctrl+I：**baseKeymap 里没有行内标记的快捷键**（那是 example-setup 的活），
      //   不绑的话工具栏提示就成了假话。
      keymap({
        Backspace: undoInputRule,
        "Mod-b": toggleMark(hpSchema.marks.strong),
        "Mod-i": toggleMark(hpSchema.marks.em),
        // 117：同上，`Mod-z` 也不在 baseKeymap 里，不绑就等于没有撤销。
        // Ctrl+Y 一起绑：Windows 用户习惯重做是 Ctrl+Y，只给 Ctrl+Shift+Z 会被当成「没反应」。
        "Mod-z": undo,
        "Mod-Shift-z": redo,
        "Mod-y": redo,
      }),
      listKeymap(hpSchema.nodes.list_item),
      // 142：表格与 Tab 的键位，同样必须在 baseKeymap 之前 ——
      // 否则 Enter 先被 `splitBlock` 吃掉（格子里拆第二段、落盘把「甲」「乙」并成「甲乙」）；
      // 而 Tab 在 baseKeymap 里**根本没有绑定**，浏览器默认行为是把焦点移走，
      // 接着打的字全落在页面背景上（实测空档按 Tab，activeElement 变成底栏的模式按钮）。
      tableEnterKeymap(),
      tabKeymap(),
      taskListPlugin(),
      footnoteJumpPlugin(),
      tableMenuPlugin(),
      keymap(baseKeymap),
      // 145：选区一变就重算每个代码块的收起/展开（NodeView 自己没有「选区变了」的回调）
      codeFoldWatchPlugin(),
      // 142：文档形状的两条不变式（末尾留一行能写字的 + 把 PM 自动填空掉出来的空占位块换回段落）。
      // 放在最后一项：它守的是「所有事务落定之后」的形状，前面的键位与粘贴各写各的。
      documentShapePlugin(),
    ],
  });
}

/** 编辑器配置。119 后它可以在「换标签 / 外部改内容」时被反复重建，所以抽成函数 */
function editorProps(state: EditorState): DirectEditorProps {
  return {
    state,
    editable: () => true,
    // 109：代码块用 NodeView 承载语言下拉。
    // 下拉的事件放行写在 NodeView 自己的 `stopEvent` 里（那是 NodeView 的成员，
    // 编辑器 props 上没有这个字段）。
    nodeViews: {
      // 第三个参数 getPos 是 PM 给 NodeView 的「我自己在文档里的位置」回调，
      // 必须传下去 —— 自己拿 posAtDOM 猜偏移会打到隔壁节点上。
      // theme 用 getter 传，让 Mermaid 重绘跟着当前深浅档走（D3），而不是建视图时定死。
      code_block: (node, editorView, getPos) =>
        codeBlockNodeView(
          editorView,
          node,
          getPos as () => number | undefined,
          () => props.theme,
          // 146-A：每张图的缩放倍率按「标签页 + 源区间」存，换档回来还是调过的那一档
          () => props.tabId ?? "",
        ),
      // 138-B：块级公式「上面排版、下面改源码」，与 code_block 同一套路（防抖 + 去重 + 降级）
      math_block: (node, editorView, getPos) =>
        mathBlockNodeView(editorView, node, getPos as () => number | undefined),
    },
    // 自己接管事务分发：每次文档变化后按 104 的口径回写工作文本。
    // 注意字段名是 config 里的 `dispatchTransaction`（`EditorProps`），
    // 不是实例上的 `dispatch`（`DirectEditorProps`）—— 写成 dispatch 会被静默忽略，
    // 表现就是「字进了 PM 但永远不回写 markdown」。
    dispatchTransaction: (tr: Transaction) => {
      if (!view) return;
      // 117：**打字交给 PM 按时间合并，结构操作自成一步。**
      // PM 的合并条件是「相邻 + 没超过 newGroupDelay」，对打字正好，对结构操作不够：
      // 粘完一张表马上在同一个位置打字，会被并进同一步，Ctrl+Z 一次撤掉两件事。
      // 所以结构操作前后各补一个 closeHistory：前面那个让它自己开一组，
      // 后面那个（空事务）让下一笔打字不再并进这一组。
      const structural = tr.docChanged && !isTypingTransaction(tr);
      if (structural) closeHistory(tr);
      view.updateState(view.state.apply(tr));
      if (structural) view.dispatch(closeHistory(view.state.tr));
      if (tr.docChanged) {
        commit();
        // 116：新插进来的图片要在这一帧之后才有 DOM 节点可解析
        revealImages();
        // 118：查找条开着时，文档一变就重算 —— 计数与高亮必须始终一致（验收第一条）。
        // 放在 docChanged 分支里而不是每次事务：光标移动的事务不该触发全文重扫。
        if (searchState.open) recomputeSearch(false);
      }
      // 工具栏的高亮与置灰要跟着选区走，所以**只移动光标的事务也要刷**
      if (tr.docChanged || tr.selectionSet || tr.storedMarksSet) tbRev.value++;
    },
  };
}

/** 119：把当前视图连同 104 的回写基准一起收进表里（**基准必须跟着 state 走**） */
function stashCurrent(): void {
  if (!view || !mountedTabId || !sourceDoc) return;
  stashEdit(mountedTabId, { state: view.state, sourceText, sourceDoc, emitted: lastEmitted });
}

function disposeView(): void {
  if (pmAdapter) unregisterSearchAdapter(pmAdapter);
  pmAdapter = null;
  view?.destroy();
  view = null;
  mountedTabId = null;
}

function attach(tabId: string, state: EditorState, parseMs = 0): void {
  if (!mountPoint) return;
  // 121：分两段打点 —— 解析（mdast→PM，纯计算）与建视图（DOM + NodeView + 首帧排版）。
  // 「要不要分块懒挂载」的结论按这两段的占比下，所以不能只记一个总数。
  const t0 = performance.now();
  view = new EditorView(mountPoint, editorProps(state));
  noteEditMount(parseMs, performance.now() - t0);
  mountedTabId = tabId;
  // 118：查找适配器绑的是 view 实例，视图换过就要换一个（旧的按身份注销，见 state/search.ts）
  pmAdapter = makePmAdapter(view);
  registerSearchAdapter(pmAdapter);
  tbRev.value++;
  revealImages();
  if (searchState.open) recomputeSearch(false);
}

/**
 * 119：装载某个标签的编辑器。
 *
 * 能复用就复用（撤销栈、选区、文档结构原样回来），不能复用才重建。
 * 判据只有一条：`tab.markdown` 与这份实例最后一次回写出去的文本**逐字节相等**。
 * 不相等 = 另一头（源码模式）改过内容，旧栈指向的是一段已不存在的结构 ——
 * 按**口径 Q4 的 A 案**处理：重建 + 清栈 + 给一次轻提示（B 案要做跨结构的整篇替换事务，
 * 代价明显更高，作者若要另开工单，见本颗工单末尾）。
 */
function loadFor(tabId: string, md: string): void {
  if (view) {
    stashCurrent();
    disposeView();
  }
  const stashed = peekEdit(tabId);
  if (stashed && canReuseEdit(stashed, md)) {
    sourceText = stashed.sourceText;
    sourceDoc = stashed.sourceDoc;
    lastEmitted = stashed.emitted;
    // 复用那条路没有解析开销，但**建视图照样要跑一次**（121 的两段口径要可比）
    attach(tabId, stashed.state, 0);
    return;
  }
  if (stashed) pushModeHint(HINT_SOURCE_TO_EDIT);
  dropEdit(tabId);
  sourceText = md;
  lastEmitted = md;
  const tParse = performance.now();
  const state = buildState(md);
  const parseMs = performance.now() - tParse;
  sourceDoc = state.doc;
  attach(tabId, state, parseMs);
}

function mount() {
  if (!host.value || view) return;
  article = document.createElement("article");
  article.className = "hp-doc";
  host.value.replaceChildren(article);
  syncShell();

  mountPoint = document.createElement("div");
  mountPoint.className = "hp-edit";
  article.appendChild(mountPoint);

  loadFor(props.tabId, props.markdown);
}

/**
 * 116：编辑模式里让图片真的显示出来。
 *
 * 阅读模式那套（`hydrate`）会把加载失败的 `<img>` **换成一个占位 span**，
 * 这里不能照抄：那张 img 是 PM 的叶子节点 DOM，把它从父节点里拆走，
 * 编辑器立刻找不到自己的节点（选区、坐标全乱）。
 * 所以只做两件事：相对路径 → 宿主 URL（021 的解析），失败就打 `data-broken`，
 * 由 `.hp-doc img[data-broken]` 的样式提示（阅读模式的整块占位仍在阅读模式给出）。
 */
function revealImages() {
  if (!article) return;
  const imgs = Array.from(article.querySelectorAll<HTMLImageElement>("img"));
  if (!imgs.length) return;
  for (const img of imgs) {
    if (img.dataset.hpEditBound !== "1") {
      img.dataset.hpEditBound = "1";
      img.addEventListener("error", () => {
        img.dataset.broken = "true";
      });
    }
  }
  void getHost().then((h) => {
    if (article)
      void resolveImages(article, {
        theme: props.theme,
        sourcePath: activePath.value,
        host: h,
        // 161：这一份用的是与阅读档 `hydrate` 同一个标签页标识（图片增强不吃它，Mermaid 的倍率吃）
        tabKey: props.tabId ?? "",
      });
  });
}

/**
 * 挂载时机：必须等 `onMounted`。
 * 早先写成 `watch(..., { immediate: true })`，那会在 setup 阶段执行，
 * 此时模板 ref 还是 null，`mount()` 直接 return，而 markdown 之后并不变化，
 * 于是编辑器永远不出现（E2E 表现为 `.ProseMirror` 元素找不到）。
 */
onMounted(() => mount());

watch(
  () => [props.tabId, props.markdown] as const,
  ([id, md]) => {
    // 切标签：两个 prop 同时变，先按标签判，别让「换了个文档」被当成「改了内容」
    if (id !== mountedTabId) {
      loadFor(id, md);
      return;
    }
    // 外部真改了才重建。自己 emit 出去又绕回来的那一次必须跳过，
    // 否则每敲一个字都会重建文档、把光标和撤销栈打掉。
    if (md !== lastEmitted) loadFor(id, md);
  }
);

watch(
  () => [props.theme, props.width, props.zoom, props.baseFontSize],
  () => syncShell()
);

onBeforeUnmount(() => {
  // 119：切走 = 卸载（三种模式三个异步组件），但**撤销栈不能跟着卸载一起没** ——
  // 先把 state 和 104 的回写基准收进按标签持有的表里，下一次挂载按它决定复用还是重建。
  stashCurrent();
  disposeView();
  article = null;
  mountPoint = null;
});

defineExpose({
  scrollDOM: () => scroller.value,
  setScrollTop: (v: number) => {
    if (scroller.value) scroller.value.scrollTop = v;
  },
  getScrollTop: () => scroller.value?.scrollTop ?? 0,
  /**
   * 141：新建未命名档时把光标真的放进文档里。
   * 点「+」之后焦点还停在那颗按钮上，工具栏显示着「正文」但文档里没有光标，
   * 用户的第一反应是「那我在页面上点一下」—— 而空白处点了也没用（见上面那条样式注释）。
   * 两处一起修：这里负责落光标，样式负责让整页可点。
   */
  focusStart: () => {
    if (!view) return false;
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    return true;
  },
  editorView: () => view,
  /**
   * 127：导航点第 `i` 个标题就跳到它。
   * PM 渲染出的标题没有阅读模式那套 `id`，所以按**文档顺序的序号**取，
   * 重复标题也不会跳错。
   */
  jumpToHeadingIndex: (i: number): boolean => {
    const sc = scroller.value;
    if (!sc) return false;
    const heads = sc.querySelectorAll<HTMLElement>(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6");
    const el = heads.item(i);
    if (!el) return false;
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    sc.scrollTop = Math.max(0, el.getBoundingClientRect().top - base - 12);
    return true;
  },
  /**
   * 140：跨模式定位的两个口子（同 SourceView 那一对，理由也一样的那条不再写一遍）。
   * 编辑档的块就是 PM 文档的顶层节点，选择器是它自己的事。
   */
  topAnchor: () => domTopAnchor(scroller.value, ".ProseMirror > *"),
  applyAnchor: (a: 锚 | null, near = -1) =>
    scrollDomToAnchor(scroller.value, ".ProseMirror > *", a, near, ".ProseMirror tr, .ProseMirror li"),
});
</script>

<template>
  <div class="edit-pane" data-testid="edit-mode">
    <EditToolbar
      :state="tbState"
      :font-size="baseFontSize ?? 15"
      @block="onBlock"
      @mark="onMark"
      @link="onLink"
      @doclink="doclinkOpen = true"
      @fontsize="(v: number) => emit('fontsize', v)"
    />
    <DocLinkPicker
      v-if="doclinkOpen"
      @close="doclinkOpen = false; view?.focus()"
      @insert="onDocLinkInsert"
    />
    <div ref="scroller" class="edit-pane__scroll">
      <div ref="host" class="edit-pane__host" />
    </div>
  </div>
</template>

<style scoped>
.edit-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--hp-bg);
  /* 137：「插入文档链接」弹层是绝对定位的，锚点必须是这一层
     （锚到更外面会跟着窗口滚动跑，锚到 .edit-pane__scroll 会被裁切） */
  position: relative;
}

/* 滚动的是内层，工具栏留在原位（sticky 需要滚动容器，这里直接把它挪出容器更简单） */
.edit-pane__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.edit-pane__host {
  min-height: 100%;
  /*
   * 141：新建一篇没字的文档时，可编辑区原本只有「一行高」（26px），
   * 下面半屏的空白不属于 contenteditable —— 点那里等于点了页面背景，
   * 光标不落进去、键盘也打不出字（实测：点 y=516 的空白后 activeElement 变成 BODY）。
   * 所以把高度沿 host → .hp-doc → .hp-edit 一路传下去，整页都是可编辑区。
   * 用 flex 而不是百分比 min-height：百分比要父级有确定高度才生效，这里父级是 auto。
   */
  display: flex;
  flex-direction: column;
}

.edit-pane :deep(.hp-doc) {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  /*
   * `width: 100%` 不是多余的：`.hp-doc` 带着 `margin: 0 auto` 做居中，
   * 而它现在是一个**纵向 flex 容器的子项** —— 交叉轴上有 auto 边距时浏览器不再拉伸它，
   * 于是整篇塌成「只剩内边距」的 64px 宽（实测），可编辑区宽度直接归零。
   * 给了显式宽度后 `max-width: 900px` + auto 边距照常居中。
   */
  width: 100%;
}

/*
 * 挂载点 `.hp-edit` 只是容器，**真正可编辑的是它里面 PM 自己的 `.ProseMirror`**
 * （实测链：.ProseMirror 26px 在 .hp-edit 469px 里 —— 只把外层撑高没用，
 * 点空白仍然落在外层 div 上，光标进不去）。所以两层都要铺满。
 */
.edit-pane :deep(.hp-edit) {
  outline: none;
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
}

.edit-pane :deep(.hp-edit > .ProseMirror) {
  flex: 1 0 auto;
  /*
   * 142：把 `.hp-doc` 那 96px 的页底留白**搬进可编辑区里面**。
   * 留白在 article 的 padding 上时不属于 contenteditable，
   * 最后一段下面那一条点了没反应（141 只把容器撑满，没管这条）；
   * 搬进来之后「点正文下方空白 = 光标落到最后一行」，视觉上的留白一分不少。
   */
  padding-bottom: 96px;
}

.edit-pane :deep(.hp-doc) {
  padding-bottom: 0;
}

/*
 * 144：`reading.css` 的 `.hp-doc > *:first-child { margin-top: 0 }` 在编辑档**没人命中**。
 * 编辑档多一层挂载点（`.hp-doc > .hp-edit > .ProseMirror > 块`），
 * 于是「首子元素」是 `.hp-edit` 这个不带外边距的 div，真正第一块的上边距没被抹掉。
 * 实测（浏览器 mock）：以 `# 标题` 开头的文档，正文第一行阅读档 29px、编辑档 75px，
 * 差的 46px 正好是 h1 的 `margin-top: 1.6em`（h1 字号 28.5px）。
 * 段落 / 列表本身 margin-top 为 0，所以只有标题开头会露出来 —— 三种开头都写了用例。
 */
.edit-pane :deep(.hp-edit > .ProseMirror > *:first-child) {
  margin-top: 0;
}

/*
 * 149-A（10-22：「编辑模式为什么会有奇怪的换行」）：
 * prosemirror-view 自带一条 `.ProseMirror { white-space: pre-wrap; white-space: break-spaces }`
 * —— 后一句是前一句的降级写法，Chrome 认 `break-spaces`，于是**源码里的软换行在编辑档真换了一行**。
 * 探针实测（同一段，源码两行、中间没有空行）：阅读档 26px、编辑档 53px，
 * 多出来那一整行还是行尾那个 `\n` 自己占的（`break-spaces` 连行尾空白都占一格）。
 * 阅读档走 HTML 默认 `normal`：软换行折成一个空格。两档要一致，只能统一到阅读档那条口径。
 *
 * **只改显示，不动文档**：PM 的 `whitespace` 解析规则本来就是 `normal`
 * （脚注定义块要显式 `code: true` 才保得住续行换行，正是同一件事的反面，见 `pm/schema.ts`），
 * 所以这里不会让打进去的字在落盘时变样。真需要原样保留的三处 —— 代码块 `pre`、
 * 脚注定义 `.hp-fndef`、公式源码 `.hp-mathblock__src` —— 各自都写了 `white-space`，
 * 继承不到这一条；表格格子由 `.hp-doc th/td` 那条带着，两档同一份，也不受影响。
 */
.edit-pane :deep(.hp-edit > .ProseMirror) {
  white-space: normal;
}

/*
 * 143：编辑档的**行间距与阅读档不一致**（两张图：同一篇文档，编辑档的表格行明显更高，
 * 任务项之间空出一大截，而且文字掉到方框下面一行去了）。
 *
 * 根因不是字号也不是行高，是**多出来的一层块**：
 * PM 的 `table_cell` / `list_item` 内容必须是块（`cellContent: "paragraph+"`、`list_item: "block+"`），
 * 于是每个格子、每一项里都包着一个 `<p>`，而 `.hp-doc p` 带着 `margin: 0 0 1em` ——
 * 阅读档的格子里是行内文字、没有这层段落，所以两边每行差出整整一个 1em。
 * 实测（浏览器 mock、100% 缩放）：任务项 26px → 53px，表格行 39px → 54px。
 * 段落外边距在**容器内部**没有意义（它撑的是行高，不是块间距），这里就地清零。
 */
.edit-pane :deep(.hp-doc th > p),
.edit-pane :deep(.hp-doc td > p) {
  margin: 0;
}

/*
 * 列表项里那层段落的外边距：见上面 143 那条注释里的同一根因。
 * 三种位置都要管：本项最后一段、以及**后面跟着嵌套列表**的那一段
 * （嵌套列表自己带 0.25em 间距，段落的 1em 再叠上去就是阅读档没有的 15px；
 *  任务项的那段在 `li > div` 里，所以两组都要写）。
 */
.edit-pane :deep(.hp-doc li > p:last-child),
.edit-pane :deep(.hp-doc li > div > p:last-child),
.edit-pane :deep(.hp-doc li > p:has(+ ul)),
.edit-pane :deep(.hp-doc li > p:has(+ ol)),
.edit-pane :deep(.hp-doc li > div > p:has(+ ul)),
.edit-pane :deep(.hp-doc li > div > p:has(+ ol)) {
  margin-bottom: 0;
}

/*
 * 任务项：PM 的 `toDOM` 是 `li > input + div`（那个 div 装着本项的全部内容），
 * div 是块级 → **文字整块掉到方框下面一行**；圆点也没关 ——
 * 阅读档靠 `li.task-list-item` 这个类关圆点，PM 渲染出来的是 `li[data-hp-task]`，没人认它。
 *
 * 修法：把方框**浮动**起来，让第一行被它挤短、后面的行回到本项左缘 ——
 * 这正是阅读档"方框是行内元素"时的换行形状，两档逐行一致。
 * 两条走过的弯路都记下来，别再试：
 * ① `div { display: inline }`（想让文字真的行内）：几何判据全绿，但**功能坏了** ——
 *    任务项转换的那一刻 PM 要在新 DOM 里重放光标，行内化的 contentDOM 让它放不准，
 *    「`- [ ] 买牛奶`」打出来只剩一个 `-`（`edit-input-rules.spec.ts` 那条两步规则红在这里）。
 * ② `li { display: flex }` + 基线对齐：方框与首行也对齐了，但整个文字列比方框那一列窄，
 *    同一项在阅读档折 2 行、在编辑档折 3 行，两档还是不一致。
 * 所以只能"保持块级结构 + 让方框浮动"，`::after` 清浮点是防止方框溢到下一项上。
 */
.edit-pane :deep(.hp-doc li[data-hp-task]) {
  list-style: none;
  margin-left: -1.4em;
}

.edit-pane :deep(.hp-doc li[data-hp-task] > input[type="checkbox"]) {
  float: left;
}

/*
 * 不额外清浮点：方框只有 13px 高，而本项最小一行是 26px，浮不出来。
 * 反倒**不能**加 `::after { clear: both }` —— 那会让本项的最后一段外边距不再与项自己的
 * 下边缘合并（清浮点的元素挡住了 margin collapsing），实测带嵌套列表的那一项因此
 * 比阅读档高 15px（正好一个 1em）。
 */

.edit-pane :deep(.hp-doc li[data-hp-task] > div > p:last-child) {
  margin-bottom: 0;
}
</style>
