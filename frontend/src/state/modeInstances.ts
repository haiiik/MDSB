import { ref, type Ref } from "vue";
import type { EditorState as PMState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorState as CMState } from "@codemirror/state";

/**
 * 119：三模式来回切时，**编辑器实例按标签持有**。
 *
 * 外壳是 `v-if` 切的（三种模式三个组件，异步分包），切走就是卸载 ——
 * 卸载会把 PM 的 `EditorState` 和 CM 的 `EditorState` 一起丢掉，
 * 而**撤销栈恰好就存在这两个 state 里**（`prosemirror-history` / `@codemirror/commands`
 * 的 history 都是 StateField）。所以「切回来还能 Ctrl+Z」这件事
 * 不是靠组件常驻，而是靠这张表把 state 对象跨挂载传回去。
 *
 * 这张表还得多存三样东西（`EditInstance` 的 `sourceText` / `sourceDoc` / `emitted`）：
 * 104 的回写基准。它们是「这份 PM 文档是从哪份文本解析出来的」，
 * 只把 state 传回来而基准丢了，下一次 `changedBlocks` 就会拿新文本当基准切块 ——
 * 那是 104 已经钉过的错法（实测症状：每敲一次字吞回上一次）。
 *
 * 运行时**只 import 类型**（`import type`），编译后擦除：
 * 这个模块会被 `documents.ts`（主包）引用，不能把 ProseMirror / CodeMirror 拖进主包，
 * 024 的冷启动基线就是靠「阅读模式不加载它们」成立的。
 */

export type EditInstance = {
  /** PM 的完整状态：文档 + 选区 + history（含所有 state plugins） */
  state: PMState;
  /** 104：这份文档被解析自的那份文本，重建前不滚动 */
  sourceText: string;
  /** 与 `sourceText` 配对的解析产物，`changedBlocks` 的左半边 */
  sourceDoc: PMNode;
  /** 最后一次回写出去的工作文本 —— 判据就读它 */
  emitted: string;
};

const editInstances = new Map<string, EditInstance>();
const sourceInstances = new Map<string, CMState>();

export function stashEdit(tabId: string, inst: EditInstance): void {
  editInstances.set(tabId, inst);
}

export function peekEdit(tabId: string): EditInstance | null {
  return editInstances.get(tabId) ?? null;
}

export function dropEdit(tabId: string): void {
  editInstances.delete(tabId);
}

export function stashSource(tabId: string, state: CMState): void {
  sourceInstances.set(tabId, state);
}

export function peekSource(tabId: string): CMState | null {
  return sourceInstances.get(tabId) ?? null;
}

export function dropSource(tabId: string): void {
  sourceInstances.delete(tabId);
}

/** 关标签：两份历史一起清。重开同一份文件撤销栈是空的（009 的会话恢复口径） */
export function dropTab(tabId: string): void {
  editInstances.delete(tabId);
  sourceInstances.delete(tabId);
}

/**
 * 能不能接着用这份实例 —— 判据是**逐字节相等**，不做「差不多」。
 *
 * 不相等意味着另一头改过内容（源码模式改了文本、或自动保存/崩溃恢复整篇换过），
 * 此时旧栈指向的是一段已经不存在的文档结构，复用等于给用户一个会乱撤的栈。
 * 处理方式见口径 Q4 的 A 案：**重建 + 清栈 + 给一次轻提示**。
 */
export function canReuseEdit(inst: EditInstance | null, markdown: string): inst is EditInstance {
  return inst !== null && inst.emitted === markdown;
}

export function canReuseSource(inst: CMState | null, markdown: string): inst is CMState {
  return inst !== null && inst.doc.toString() === markdown;
}

/* ---------- 轻提示（Q4 的 A 案：清栈要说话，不然用户以为撤销坏了） ---------- */

/** 展示时长；和 117 的合并窗口一样只有一个来源 */
export const MODE_HINT_TTL_MS = 4000;

export const HINT_SOURCE_TO_EDIT = "源码模式改过内容，编辑模式的撤销栈已重新开始。";
export const HINT_EDIT_TO_SOURCE = "所见即所得改过内容，源码模式的撤销栈已重新开始。";

export const modeHint: Ref<string> = ref("");

let hintTimer: ReturnType<typeof setTimeout> | null = null;

/** 后一条必须重置计时：否则前一条的定时器会把刚显示出来的新提示提前抹掉 */
export function pushModeHint(text: string): void {
  modeHint.value = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    modeHint.value = "";
    hintTimer = null;
  }, MODE_HINT_TTL_MS);
}

export function clearModeHint(): void {
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
  modeHint.value = "";
}

/** 只在测试里用得上：把表清空，避免用例之间串味 */
export function __resetModeInstances(): void {
  editInstances.clear();
  sourceInstances.clear();
  clearModeHint();
}
