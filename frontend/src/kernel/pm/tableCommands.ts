import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { addRowBefore, isInTable, selectedRect, toggleHeaderRow } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import type { TableRect } from "prosemirror-tables";
import { cellBreak } from "./mdastToDoc";

/**
 * 112：表格结构操作（移动行列 / 插删行列 / 设表头）。
 *
 * 两件事决定了这里的写法：
 *
 * 1. **移动行列不用库里的 `moveTableRow`/`moveTableColumn`**。它们确实是公开 API
 *    （`index.d.ts:505` / `:536`，先前我误记成「内部助手」），但重建表格走
 *    `createChecked(tableNode.attrs, …)`（`index.cjs:934`）——**表格 attrs 原样不动**。
 *    我们的列对齐存在 `table.attrs.align` 上（103），搬列时 `align` 不跟着换序，
 *    结果就是「内容挪了、`---:` 还留在老列上」。所以列移动必须自己实现，行移动同处一份代码保持对称。
 * 2. **GFM 的表格只有一种形状**：第一行是表头、紧跟分隔行、无跨格。通用表格模型允许
 *    「表头不在第一行」，所以凡是可能造出 GFM 表达不出的形状的操作一律返回 false
 *    （菜单置灰），而不是先让文档坏掉、下一次 `setNodeMarkup` 才炸（107/109 的教训）。
 *
 * 列对齐（`:---:` / `---:`）存在 `table.attrs.align` 上，所以**任何改变列序或列数的
 * 操作都必须同步搬 `align` 数组**，否则 `docToMdast` 的长度校验会把整表对齐退化成默认值。
 */

/** 该表是否含跨格（colspan/rowspan > 1）。GFM 表达不了，含跨格时一律拒绝结构操作 */
function hasSpan(table: PMNode): boolean {
  let span = false;
  table.forEach((row) =>
    row.forEach((cell) => {
      if ((cell.attrs.colspan ?? 1) > 1 || (cell.attrs.rowspan ?? 1) > 1) span = true;
    })
  );
  return span;
}

/** 首行是否整行为表头格（= 带表头的 GFM 表格） */
function firstRowIsHeader(table: PMNode): boolean {
  if (!table.childCount) return false;
  const row = table.child(0);
  let all = row.childCount > 0;
  row.forEach((cell) => {
    if (cell.type.name !== "table_header") all = false;
  });
  return all;
}

/** 取表格对齐数组的副本，长度补齐到 cols（对齐缺失时以默认值兜底） */
function alignOf(table: PMNode, cols: number): (string | null)[] {
  const stored = Array.isArray(table.attrs.align) ? (table.attrs.align as (string | null)[]) : [];
  const out = stored.slice(0, cols);
  while (out.length < cols) out.push(null);
  return out;
}

/**
 * 表格**节点**在文档里的位置。
 *
 * `rect.tableStart` 是表格**内容**的起点（`$pos.start(-1)`），节点要再往前一格。
 * 拿 `tableStart` 当节点位置会差一格：删掉表尾再插回，新表会套进旧表里面。
 */
const tableNodeStart = (rect: TableRect): number => rect.tableStart - 1;

/** 用新的行 + 对齐数组重建表格节点，其余 attrs（srcFrom/srcTo）原样保留 */
function rebuildTable(table: PMNode, rows: Fragment, align: (string | null)[]): PMNode {
  const node = table.type.create({ ...table.attrs, align }, rows);
  // 先自检：内容不合法就当场抛，别把坏表塞进文档、等下一次 setNodeMarkup 才炸
  node.check();
  return node;
}

/**
 * 计算 (row, col) 单元格内容的起点（可直接放光标）。
 *
 * 位置逐层是：`tableStart` = **第一行节点的位置**（表格内容起点）→ 行开标签占一格
 * → 单元格位置 = 行位置 + 1 → 单元格里的段落位置 = 单元格位置 + 1 → 段落内容起点
 * 再 + 1。所以是 `cellPos + 2`。
 *
 * 少加一格（指到段落之前）或多加都会让 `TextSelection.create` 报
 * 「endpoint not pointing into a node with inline content (table_cell/table_header)」
 * 并**静默不落光标**；空单元格（nodeSize=2）时尤其容易落到边界外。
 */
function cellContentStart(tableStart: number, table: PMNode, row: number, col: number): number | null {
  let pos = tableStart; // 第一行节点的位置
  let rowIndex = 0;
  let found: number | null = null;
  table.forEach((rowNode) => {
    if (found !== null) return;
    if (rowIndex === row) {
      let inner = pos + 1; // 第一个单元格节点的位置
      let colIndex = 0;
      rowNode.forEach((cell) => {
        if (found !== null) return;
        if (colIndex === col) {
          found = inner + 2;
          return;
        }
        inner += cell.nodeSize;
        colIndex++;
      });
    }
    pos += rowNode.nodeSize;
    rowIndex++;
  });
  return found;
}

/** 整表替换 + 把光标安置到 (row, col) + 派发 */
function dispatchTable(
  state: EditorState,
  dispatch: NonNullable<Parameters<Command>[1]>,
  rect: TableRect,
  newTable: PMNode,
  row: number,
  col: number
): void {
  const tr = state.tr;
  const start = tableNodeStart(rect);
  tr.replaceWith(start, start + rect.table.nodeSize, newTable);
  const focus = cellContentStart(rect.tableStart, newTable, row, col);
  if (focus != null) tr.setSelection(TextSelection.create(tr.doc, focus));
  dispatch(tr.scrollIntoView());
}

/** 上下移动当前行；表头行不许离开首位 */
export function moveRow(dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (hasSpan(rect.table)) return false;
    const from = rect.top;
    const to = from + dir;
    if (to < 0 || to >= rect.map.height) return false;
    if (firstRowIsHeader(rect.table) && (from === 0 || to === 0)) return false;

    const rows: PMNode[] = [];
    rect.table.forEach((r) => rows.push(r));
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    if (!dispatch) return true;

    // 行移动不改列，align 原样留着
    dispatchTable(state, dispatch, rect, rect.table.copy(Fragment.from(rows)), to, rect.left);
    return true;
  };
}

/** 左右移动当前列（逐行搬同一列的格子，`align` 数组跟着换序） */
export function moveColumn(dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (hasSpan(rect.table)) return false;
    const from = rect.left;
    const to = from + dir;
    if (to < 0 || to >= rect.map.width) return false;

    const rows: PMNode[] = [];
    rect.table.forEach((r) => {
      const cells: PMNode[] = [];
      r.forEach((c) => cells.push(c));
      const [moved] = cells.splice(from, 1);
      cells.splice(to, 0, moved);
      rows.push(r.copy(Fragment.from(cells)));
    });
    if (!dispatch) return true;

    const align = alignOf(rect.table, rect.map.width);
    const [movedAlign] = align.splice(from, 1);
    align.splice(to, 0, movedAlign);

    dispatchTable(state, dispatch, rect, rebuildTable(rect.table, Fragment.from(rows), align), rect.top, to);
    return true;
  };
}

/**
 * 在光标所在列的左/右侧插入一列。
 *
 * 空格子的类型取**同行的邻居**：`addColumnBefore` 的参照列逻辑在表头行上会插成普通格，
 * 首行变成「表头 + 普通」混排，写回 Markdown 时长得不像表格。
 */
export function insertColumn(dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (hasSpan(rect.table)) return false;
    const at = dir === -1 ? rect.left : rect.right;

    const rows: PMNode[] = [];
    for (let r = 0; r < rect.table.childCount; r++) {
      const row = rect.table.child(r);
      const cells: PMNode[] = [];
      row.forEach((c) => cells.push(c));
      const ref = cells[at] ?? cells[at - 1] ?? cells[0];
      const filler = ref?.type.createAndFill();
      if (!filler) return false;
      cells.splice(at, 0, filler);
      rows.push(row.copy(Fragment.from(cells)));
    }
    if (!dispatch) return true;

    const align = alignOf(rect.table, rect.map.width);
    align.splice(at, 0, null);

    dispatchTable(state, dispatch, rect, rebuildTable(rect.table, Fragment.from(rows), align), rect.top, at);
    return true;
  };
}

/** 删除光标所在列；只剩一列时返回 false（表格不能没有列） */
export function removeColumn(): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (hasSpan(rect.table)) return false;
    if (rect.map.width <= 1) return false;
    const at = rect.left;

    const rows: PMNode[] = [];
    rect.table.forEach((row) => {
      const cells: PMNode[] = [];
      row.forEach((c) => cells.push(c));
      cells.splice(at, 1);
      rows.push(row.copy(Fragment.from(cells)));
    });
    if (!dispatch) return true;

    const align = alignOf(rect.table, rect.map.width);
    align.splice(at, 1);
    // 删的是最后一列时，光标落到左边那一列
    const target = Math.min(at, rect.map.width - 2);

    dispatchTable(state, dispatch, rect, rebuildTable(rect.table, Fragment.from(rows), align), rect.top, target);
    return true;
  };
}

/**
 * 在光标所在行**上方**插入行。
 *
 * `addRowBefore` 直接用在表头行上会插出一行普通格、把原表头挤到第二行 ——
 * 写回 Markdown 时空行成了表头，真表头沉底。GFM 没有这个形状，拒绝。
 */
export function insertRowBefore(): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (rect.top === 0 && firstRowIsHeader(rect.table)) return false;
    // `addRowBefore(state, dispatch?)` 只收两个参数，第三个（view）传不进去
    return addRowBefore(state, dispatch);
  };
}

/**
 * 把首行设为表头 / 取消首行表头。
 *
 * `toggleHeaderRow` 作用在**光标所在行**，在非首行上跑会造出「表头在第 N 行」的表。
 * 只有首行能当表头，所以非首行返回 false（菜单置灰）。
 */
export function toggleFirstRowHeader(): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (selectedRect(state).top !== 0) return false;
    return toggleHeaderRow(state, dispatch);
  };
}

/**
 * 菜单置灰判定：命令「在这儿能不能用」。
 *
 * **必须传一个空函数当 dispatch，不能传 `undefined`**：`prosemirror-tables` 的命令把
 * 边界判断写在 `if (dispatch) { … }` 里，不传 dispatch 时无条件返回 true
 * （表现为只剩一列时「删除本列」仍可点）。传空函数则真正的 tr 被丢弃、无副作用。
 */
export function commandApplies(cmd: Command, state: EditorState, view?: EditorView): boolean {
  return cmd(state, () => {}, view);
}

/**
 * 115：光标在表格里、粘贴的内容又是一张表 → **并入这张表**，而不是嵌套或另起一块。
 *
 * 规则（都是「不许悄悄丢字」逼出来的）：
 * - 粘进来的行插在**光标所在行下面**；
 * - 列数不一致时把**两边都补到最大列数**（补空格子），谁的内容都不丢；
 * - 宿主表的第一行仍是表头，粘进来的行一律降级成数据行
 *   （GFM 只有一行表头；粘进来的表头文字照样在，只是不再加粗）。
 *
 * 只在「粘贴内容恰好是一张表」时由 `pastePlugin` 调用；含跨格时不并（GFM 表达不了跨格）。
 */
export function mergePastedTable(state: EditorState, pasted: PMNode): Transaction | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  if (hasSpan(rect.table) || hasSpan(pasted)) return null;
  if (!pasted.childCount || !rect.table.childCount) return null;

  const headerType = state.schema.nodes.table_header;
  const cellType = state.schema.nodes.table_cell;
  let pastedCols = 0;
  pasted.forEach((r) => (pastedCols = Math.max(pastedCols, r.childCount)));
  const cols = Math.max(rect.map.width, pastedCols);
  if (cols === 0) return null;

  /** 补齐到 cols 列；`demote` 把表头格降级成普通格 */
  const fit = (row: PMNode, demote: boolean): PMNode => {
    const cells: PMNode[] = [];
    row.forEach((c) => {
      cells.push(demote && c.type === headerType ? cellType.create(c.attrs, c.content) : c);
    });
    const base = (cells[0] ?? cellType).type;
    while (cells.length < cols) cells.push(base.createAndFill() ?? base.create());
    return row.copy(Fragment.from(cells));
  };

  const rows: PMNode[] = [];
  rect.table.forEach((r) => rows.push(fit(r, false)));
  const insertAt = rect.bottom; // 光标所在行的下一行
  for (let i = 0; i < pasted.childCount; i++) rows.splice(insertAt + i, 0, fit(pasted.child(i), true));

  const newTable = rebuildTable(rect.table, Fragment.from(rows), alignOf(rect.table, cols));
  const tr = state.tr;
  const start = tableNodeStart(rect);
  tr.replaceWith(start, start + rect.table.nodeSize, newTable);
  const focus = cellContentStart(
    rect.tableStart,
    newTable,
    Math.min(insertAt, newTable.childCount - 1),
    Math.min(rect.left, cols - 1)
  );
  if (focus != null) tr.setSelection(TextSelection.create(tr.doc, focus));
  return tr.scrollIntoView();
}

/**
 * 115：粘贴内容全是段落（= 只有行内内容）时，把它**投行内**到当前选区。
 *
 * 段落之间的分隔用**单元格换行的既定表示**（`cellBreak`，落盘是 `<br>`），
 * 不是 `hard_break` —— 实测 hard_break 从单元格里序列化出来是**一个空格**，换行就丢了
 * （`docToMdast` 把 hard_break 写成 mdast `break`，而 GFM 表格里表达不了真换行）。
 * 只要有任何一个非段落节点就返回 null：单元格装不下块级结构。
 */
function inlineOfParagraphs(nodes: PMNode[]): Fragment | null {
  if (!nodes.length) return null;
  const pieces: PMNode[] = [];
  for (const n of nodes) {
    if (n.type.name !== "paragraph") return null;
    if (pieces.length) {
      const br = cellBreak(n.type.schema);
      if (br) pieces.push(br);
    }
    n.forEach((child) => pieces.push(child));
  }
  return pieces.length ? Fragment.fromArray(pieces) : null;
}

/**
 * 115：**光标在表格里时**，粘贴的内容该落在哪。
 *
 * 这条是桌面实测抓出来的真缺陷（不是测试洁癖）：直接 `replaceSelection(闭合的块 Slice)`
 * 会让 PM 把**宿主表从光标那一行劈成两张表**，下半截还被安上一个新表头 ——
 * `doc.check()` 说合法、序列化照样落盘，用户的表格结构就这么静默坏了（违反 D23）。
 * 所以这里按「能不能塞进单元格」分三条路：
 *
 * 1. 恰好一张表 → 并进去（`mergePastedTable`）；
 * 2. 全是段落（纯行内内容）→ 行内投进当前格子，段落之间用 `<br>`；
 * 3. 其余（标题 / 列表 / 代码块 / 表格混在里面的多块）→ **整组插到那张表的下面**，
 *    表格一个字节都不动，光标跟到第一块里。
 *
 * 光标不在表格里返回 null，由调用方走普通的整块插入。
 */
export function placePastedBlocks(state: EditorState, nodes: PMNode[]): Transaction | null {
  if (!nodes.length || !isInTable(state)) return null;

  if (nodes.length === 1 && nodes[0].type.name === "table") {
    return mergePastedTable(state, nodes[0]);
  }

  const inline = state.selection instanceof TextSelection ? inlineOfParagraphs(nodes) : null;
  if (inline) {
    return state.tr.replaceSelection(new Slice(inline, 0, 0)).scrollIntoView();
  }

  const rect = selectedRect(state);
  const tr = state.tr;
  // 选中的是格子里的一段文字时先删掉，再算表尾位置（表尾在选区之后，会被上面的删除映射）
  if (!tr.selection.empty) tr.deleteSelection();
  const end = tr.mapping.map(tableNodeStart(rect) + rect.table.nodeSize);
  tr.insert(end, Fragment.from(nodes));
  const first = tr.doc.resolve(end);
  tr.setSelection(TextSelection.near(first, 1));
  return tr.scrollIntoView();
}

