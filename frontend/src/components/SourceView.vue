<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { makeCmAdapter, searchHighlightExtension } from "../kernel/searchCm";
import { registerSearchAdapter, recomputeIfOpen, unregisterSearchAdapter } from "../state/search";
import {
  HINT_EDIT_TO_SOURCE,
  canReuseSource,
  dropSource,
  peekSource,
  pushModeHint,
  stashSource,
} from "../state/modeInstances";
import { setTabMarkdown } from "../state/documents";

/**
 * 源码模式：CodeMirror 6 直接编辑原始 Markdown。
 *
 * 119：每标签一份 EditorState，存在 `state/modeInstances.ts` 的表里 ——
 * **不是存在本组件里**。组件是 `v-if` 挂的（切到阅读/编辑就卸载），
 * 存在组件内等于每次切回来重建，而 CM 的撤销栈就在那个 state 里。
 * 重建编辑器会清空历史，所以历史跟着表走、不跟着组件走。
 */

const props = defineProps<{
  tabId: string;
  modelValue: string;
  dark: boolean;
}>();

/**
 * 127：**没有 `update:modelValue` 这条 emit**。回写走 `setTabMarkdown(props.tabId, …)` 直接进 store ——
 * 原因见下面 `extensions()` 前那段注释（跨挂载复用的 state 带着已卸载实例的闭包，emit 会打进空气）。
 * 父组件事后也不该再往这里回灌同一个字符串：`modelValue` 变化时先比过内容，等价就不动。
 */

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
/** 当前视图代表哪个标签。切标签时 props 已经指向新标签，旧 state 要靠它找到主人 */
let mountedTabId: string | null = null;

/** 由外部写入文档（崩溃恢复、模式回写）时置真，避免把这次替换再 emit 回去 */
let applyingExternal = false;

/**
 * 127：**为什么这里的回写不走 `emit`**（修的是一个会静默丢内容的真 bug）。
 *
 * `<script setup>` 里那些「看着像模块级」的 `let`（`view`、`applyingExternal`、连 `emit` 本身）
 * 其实都在编译出来的 `setup()` 函数体内 —— **每个组件实例一份**。
 * 而 CM 的 `updateListener` 是**建 state 那一刻**绑进闭包的，state 又会被 `stashSource`
 * 存进表里跨挂载复用（119 的撤销栈就靠这个复用）。于是「切走 → 再切回源码档」之后，
 * 触发的是**上一个已卸载实例**的监听，它闭包里的 `emit` 属于那个实例 —— 调用等于打进空气：
 * 屏幕上字在（doc 真变了），工作副本没跟上 → 脏点不亮、Ctrl+S 存的是旧内容、
 * 关标签不提示直接丢。桌面实测连打四批全被吞，第五批才回写（探针日志 `sink=空` 抓到的）。
 *
 * 修法是不经过组件，直接按标签 id 写 store（`setTabMarkdown`）：
 * 监听只要 `props.tabId` + 新文本就能把事办对，跨实例、跨卸载都不受影响，
 * 而且按 id 写天然不会把 A 标签的内容写进 B。
 * `setTabMarkdown` 内部「文本没变就 return」，所以外部写入触发的回声也自然被吃掉，
 * 不再依赖 `applyingExternal` 那个同样按实例分配的旗子。
 */
function extensions(): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    // 118：查找高亮（命中由 kernel/search.ts 判，与另两种模式同一份语义）
    searchHighlightExtension(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.darkTheme.of(props.dark),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged || applyingExternal) return;
      // 127：按标签 id 直接写 store，不走 `emit` —— 见上面那段注释
      stashSource(props.tabId, u.state);
      setTabMarkdown(props.tabId, u.state.doc.toString());
      recomputeIfOpen();
    }),
  ];
}

/**
 * 装载某个标签的 CM state。判据同编辑模式（见 `state/modeInstances.ts`）：
 * 文本逐字节没变才复用 —— 变了说明另一头改过，旧历史指向的是一篇已经不是这样的文档。
 */
function mountState(tabId: string, doc: string) {
  // 换标签时先把**旧标签**的 state 存回去：只移动光标不会产生 docChanged，
  // 光靠 updateListener 会漏，而视图此刻已经要跟着 props 走了
  if (view && mountedTabId && mountedTabId !== tabId) stashSource(mountedTabId, view.state);
  const cached = peekSource(tabId);
  let state: EditorState;
  if (canReuseSource(cached, doc)) {
    state = cached;
  } else {
    if (cached) pushModeHint(HINT_EDIT_TO_SOURCE);
    dropSource(tabId);
    state = EditorState.create({ doc, extensions: extensions() });
  }
  stashSource(tabId, state);
  mountedTabId = tabId;
  if (view) view.setState(state);
  else view = new EditorView({ state, parent: host.value! });
}

let cmAdapter: ReturnType<typeof makeCmAdapter> | null = null;

onMounted(() => {
  mountState(props.tabId, props.modelValue);
  // 118：源码模式的查找适配器。`getView` 用 getter 传，
  // 因为切标签会换 view，适配器本身不需要跟着重建。
  cmAdapter = makeCmAdapter(() => view);
  registerSearchAdapter(cmAdapter);
});

// 切标签 -> 换 state
watch(
  () => props.tabId,
  (id) => mountState(id, props.modelValue)
);

// 外部改内容 -> 在现有 state 上替换整篇（保留历史栈）
watch(
  () => props.modelValue,
  (text) => {
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === text) return;
    applyingExternal = true;
    view.dispatch({
      changes: { from: 0, to: cur.length, insert: text },
      annotations: [],
    });
    applyingExternal = false;
    if (mountedTabId) stashSource(mountedTabId, view.state);
  }
);

// 主题切换 -> 扩展里带了 darkTheme，重建 state（历史无法跨 extensions 迁移，
// 但内容不变，且主题切换是低频动作）
watch(
  () => props.dark,
  () => {
    if (!view || !mountedTabId) return;
    const doc = view.state.doc.toString();
    dropSource(mountedTabId);
    mountState(mountedTabId, doc);
  }
);

onBeforeUnmount(() => {
  // 119：切走 = 卸载，但 state 留在表里（撤销栈就在它里面）
  if (view && mountedTabId) stashSource(mountedTabId, view.state);
  if (cmAdapter) unregisterSearchAdapter(cmAdapter);
  cmAdapter = null;
  view?.destroy();
  view = null;
});

defineExpose({
  focus: () => view?.focus(),
  scrollTop: () => view?.scrollDOM.scrollTop ?? 0,
  setScrollTop: (v: number) => {
    if (view) view.scrollDOM.scrollTop = v;
  },
  scrollDOM: () => view?.scrollDOM ?? null,
  /**
   * 127：源码模式没有「标题 DOM」，导航只能按**第 i 个 markdown 标题行**定位。
   * 判据与阅读/编辑两档同一个序号来源（`buildHeadingTree` 给扁平标题列表编的号），
   * 所以三档点同一条导航落的是同一处。
   */
  jumpToHeadingIndex: (i: number): boolean => {
    if (!view) return false;
    const st = view.state;
    let seen = -1;
    let inFence = false;
    for (let line = 1; line <= st.doc.lines; line++) {
      const text = st.doc.line(line).text;
      // 代码围栏里的 `#` 不是标题：跟着 ``` 计数跳过（和大纲的取法一致）
      if (/^\s*(```|~~~)/.test(text)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !/^#{1,6}\s+\S/.test(text)) continue;
      seen++;
      if (seen === i) {
        // 用 `lineBlockAt` 直接摆 scrollTop，不用 `EditorView.scrollIntoView`：
        // 后者是"确保可见"语义，目标行已经在视口里时**一动也不动**，
        // 于是"点导航定位到那一行"会变成"点了没反应"（e2e 实测 scrollTop 恒为 0）。
        const top = view.lineBlockAt(st.doc.line(line).from).top;
        view.scrollDOM.scrollTop = Math.max(0, top - 12);
        return true;
      }
    }
    return false;
  },
});
</script>

<template>
  <div ref="host" class="source-view" data-testid="source-view" />
</template>

<style scoped>
.source-view {
  height: 100%;
  overflow: hidden;
}

.source-view :deep(.cm-editor) {
  height: 100%;
  font-size: 0.95em;
}

.source-view :deep(.cm-scroller) {
  font-family: var(--hp-font-md);
}
</style>
