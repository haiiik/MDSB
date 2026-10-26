import { Fragment, type Node as PMNode } from "prosemirror-model";
import { lift, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { hpSchema } from "./schema";

/**
 * 113：工具栏的块类型 / 行内标记命令与状态读取。
 *
 * 工具栏与输入规则**共用同一套 schema 命令**，不另起写回路径 —— 转换后照样走
 * 104 的按块回写，块外逐字节不变。
 *
 * 全部做成纯函数（吃 EditorState、返回 Command），单测不用起浏览器就能断言
 * 「按钮点了会变成什么」；按钮的高亮/置灰由 `toolbarState` 读同一个 state 得出，
 * 两边共用判定，不会出现「亮着却点了没反应」。
 */

const n = hpSchema.nodes;

/** 工具栏能切到的块类型 */
export type BlockTarget =
  | { kind: "paragraph" }
  | { kind: "heading"; level: number }
  | { kind: "quote" }
  | { kind: "code" }
  | { kind: "bullet" }
  | { kind: "ordered" }
  | { kind: "task" };

export type ToolbarState = {
  /** 光标所在**顶层块**的类型 */
  block: "paragraph" | "heading" | "blockquote" | "code" | "list" | "table" | "other";
  level: number | null;
  /** 所在列表的记号（不在列表里为 null） */
  list: "bullet" | "ordered" | null;
  /** 任务项：null = 不是任务项 */
  checked: boolean | null;
  bold: boolean;
  italic: boolean;
  /** 代码块里：块级与行内标记按钮不适用（Markdown 里代码内没有标记语义） */
  inCode: boolean;
  inTable: boolean;
};

/** 选区覆盖到的顶层块下标区间 [first, last] */
function coveredBlocks(state: EditorState): { first: number; last: number } {
  const { $from, $to } = state.selection;
  return { first: $from.index(0), last: Math.max($from.index(0), $to.indexAfter(0) - 1) };
}

export function toolbarState(state: EditorState): ToolbarState {
  const { $from } = state.selection;
  // 夹一下：选区锚点落在文档边界（如 Ctrl+A、整块 NodeSelection）时 index(0) 可能等于 childCount，
  // 直接 doc.child(...) 会抛 RangeError —— 工具栏每次选区变化都要重算，不能因为它炸编辑器
  const top = state.doc.child(Math.min($from.index(0), state.doc.childCount - 1));
  const name = top.type.name;

  let block: ToolbarState["block"] = "other";
  if (name === "paragraph") block = "paragraph";
  else if (name === "heading") block = "heading";
  else if (name === "blockquote") block = "blockquote";
  else if (name === "code_block") block = "code";
  else if (name === "bullet_list" || name === "ordered_list") block = "list";
  else if (name === "table") block = "table";

  let list: ToolbarState["list"] = null;
  let checked: boolean | null = null;
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name;
    if (t === "bullet_list") list = "bullet";
    else if (t === "ordered_list") list = "ordered";
    else if (t === "list_item" && checked === null) checked = $from.node(d).attrs.checked ?? null;
    if (list) break;
  }

  const has = (m: string) => $from.marks().some((x) => x.type.name === m);

  return {
    block,
    level: block === "heading" ? (top.attrs.level as number) : null,
    list,
    checked,
    bold: has("strong"),
    italic: has("em"),
    inCode: $from.parent.type.spec.code === true,
    inTable: block === "table",
  };
}

/** 选区覆盖的顶层块起点 / 终点（文档坐标） */
function coveredRange(state: EditorState): { from: number; to: number } {
  const { $from, $to } = state.selection;
  return { from: $from.before(1), to: $to.after(1) };
}

/**
 * 把选区覆盖的顶层块整块换成某种类型。
 *
 * 逐块调用 `setBlockType`（而不是拿跨块的整段区间一次换）：一次换会把块与块之间的
 * 边界当成内容合并掉，多块选区会塌成一块。
 */
function replaceTopBlocks(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  type: PMNode["type"],
  attrs: Record<string, unknown> | null
): boolean {
  const { first, last } = coveredBlocks(state);
  const tr = state.tr;
  let pos = coveredRange(state).from;
  for (let i = first; i <= last; i++) {
    const node = state.doc.child(i);
    const end = pos + node.nodeSize;
    // 已经是目标类型 + 同 attrs 的块跳过：多块选区里只换该换的
    if (node.type !== type || !sameAttrs(node.attrs, attrs)) {
      tr.setBlockType(pos, end - 1, type, attrs);
    }
    pos = end;
  }
  if (!tr.docChanged) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
}

function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown> | null): boolean {
  if (!b) return false;
  return Object.entries(b).every(([k, v]) => a[k] === v);
}

/** 光标所在 list_item 的位置（不在列表项里返回 null） */
function itemPos($from: EditorState["selection"]["$from"]): number | null {
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === n.list_item) return $from.before(d);
  return null;
}

/**
 * 工具栏的块级命令。
 *
 * 再点一次同一个按钮 = 撤回原样（正文 → 标题 → 正文、列表 → 提出），
 * 不做叠加（点三下引用不会套出三层 blockquote）。
 */
export function blockCommand(target: BlockTarget): Command {
  return (state, dispatch) => {
    const view = toolbarState(state);

    if (target.kind === "quote") {
      if (view.block === "blockquote") return lift(state, dispatch);
      return wrapIn(n.blockquote)(state, dispatch);
    }

    if (target.kind === "bullet" || target.kind === "ordered") {
      const listType = target.kind === "bullet" ? n.bullet_list : n.ordered_list;
      const sameKind = view.list === target.kind;
      // 同种列表再点一次：把这一项从列表里提出来
      if (sameKind) return liftListItem(n.list_item)(state, dispatch);
      // 无序 ↔ 有序：外层 list 换个类型，内容与层级都不动
      if (view.list) {
        const $from = state.selection.$from;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type === n.bullet_list || node.type === n.ordered_list) {
            if (!dispatch) return true;
            dispatch(
              state.tr.setNodeMarkup($from.before(d), listType, {
                order: listType === n.ordered_list ? 1 : null,
              })
            );
            return true;
          }
        }
      }
      return wrapInList(listType)(state, dispatch);
    }

    if (target.kind === "task") {
      const $from = state.selection.$from;
      const pos = itemPos($from);
      if (pos !== null) {
        const item = state.doc.nodeAt(pos);
        if (!item) return false;
        // 已是任务项 → 取消勾选（回到普通列表项）
        const next = item.attrs.checked === null ? false : null;
        if (!dispatch) return true;
        dispatch(state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: next }));
        return true;
      }
      // 不在列表里：整块变成「一个未勾选的任务项」（与 113 的 `[ ] ` 输入规则同一形状）
      if (!dispatch) return true;
      return makeTaskFromBlocks(state, dispatch);
    }

    const type =
      target.kind === "heading" ? n.heading : target.kind === "code" ? n.code_block : n.paragraph;
    const attrs =
      target.kind === "heading"
        ? { level: target.level }
        : target.kind === "code"
          ? { language: null }
          : null;
    // 已经是同一种块 → 回落到正文（代码块/标题的「再点一次」）
    const alreadySame =
      (target.kind === "paragraph" && view.block === "paragraph") ||
      (target.kind === "heading" && view.block === "heading" && view.level === target.level) ||
      (target.kind === "code" && view.block === "code");
    return replaceTopBlocks(state, dispatch, alreadySame ? n.paragraph : type, alreadySame ? null : attrs);
  };
}

/** 把选区覆盖的顶层块包成 bullet_list > list_item(checked=false) > 原块 */
function makeTaskFromBlocks(
  state: EditorState,
  dispatch: (tr: Transaction) => void
): boolean {
  const { first, last } = coveredBlocks(state);
  const rangeFrom = coveredRange(state).from;
  const tr = state.tr;
  // 从后往前包，前面的位置才不会被后面的替换挪走
  for (let i = last; i >= first; i--) {
    let blockStart = rangeFrom;
    for (let k = 0; k < i; k++) blockStart += state.doc.child(k).nodeSize;
    const node = state.doc.child(i);
    if (node.type !== n.paragraph && node.type !== n.heading) continue;
    const item = n.list_item.create({ checked: false }, Fragment.from(node));
    tr.replaceWith(blockStart, blockStart + node.nodeSize, n.bullet_list.create(null, Fragment.from(item)));
  }
  if (!tr.docChanged) return false;
  dispatch(tr.scrollIntoView());
  return true;
}

export function toggleBold(): Command {
  return toggleMark(hpSchema.marks.strong);
}

export function toggleItalic(): Command {
  return toggleMark(hpSchema.marks.em);
}

/**
 * 加链接；空 URL = 取消链接。
 *
 * basicSchema 里 `link` 是 **mark**，所以走 addMark/removeMark，不是插入节点。
 */
export function linkCommand(href: string): Command {
  const mark = hpSchema.marks.link;
  return (state, dispatch) => {
    const { from, to } = state.selection;
    if (from === to) return false;
    const hasLink = state.doc.rangeHasMark(from, to, mark);
    const tr = state.tr;
    if (hasLink && !href.trim()) tr.removeMark(from, to, mark);
    else tr.addMark(from, to, mark.create({ href, title: null }));
    if (!tr.docChanged) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/**
 * 137：在光标处插入一条**文档链接**。
 *
 * 与 `linkCommand` 的分工：那条要求有选区（给选中的文字加链接 mark），
 * 而"插入文档链接"最常见的场景是**光标停在那儿、什么也没选** ——
 * 这时插入文件名并加 link mark。有选区时不覆盖选中的字：
 * 把选中的文字变成链接（和 `linkCommand` 一致），而不是拿文件名去替换。
 *
 * 插入的是**带 mark 的节点**，不是 `[文字](路径)` 这串字面文本 ——
 * 后者会在编辑模式里显示成裸括号，切到源码模式才发现不对。
 * 落盘时由 106 那套 mark→Markdown 的反向映射自动写成 `[文字](路径)`。
 */
export function insertDocLinkCommand(text: string, href: string): Command {
  const mark = hpSchema.marks.link;
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    if (from === to) {
      if (!text) return false;
      tr.insertText(text, from);
      tr.addMark(from, from + text.length, mark.create({ href, title: null }));
    } else {
      // 有选区：只加 mark，不动选中的文字
      tr.addMark(from, to, mark.create({ href, title: null }));
    }
    if (!tr.docChanged) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/* ---------- 下面两个只给单测用：省掉每个用例手写位置 ---------- */
/** 拼一个文档 */
export function testDoc(...blocks: PMNode[]): PMNode {
  return n.doc.create(null, Fragment.from(blocks));
}

/** 光标放进第 i 个顶层块的文字开头 */
export function cursorIn(doc: PMNode, i: number): EditorState {
  const base = EditorState.create({ doc, schema: hpSchema });
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(pos + 1), 1)));
}

/** 选区覆盖第 first..last 个顶层块 */
export function selectBlocks(doc: PMNode, first: number, last: number): EditorState {
  const base = EditorState.create({ doc, schema: hpSchema });
  let from = 0;
  for (let k = 0; k < first; k++) from += doc.child(k).nodeSize;
  let to = from;
  for (let k = first; k <= last; k++) to += doc.child(k).nodeSize;
  return base.apply(
    base.tr.setSelection(TextSelection.create(doc, from + 1, to - 1))
  );
}
