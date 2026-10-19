import { Fragment, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { addRowAfter, deleteRow } from "prosemirror-tables";
import { describe, expect, it } from "vitest";
import { parseMd } from "../../src/kernel/md";
import { serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { applyChanges } from "../../src/kernel/pm/patches";
import { hpSchema } from "../../src/kernel/pm/schema";
import {
  commandApplies,
  insertColumn,
  insertRowBefore,
  moveColumn,
  moveRow,
  removeColumn,
  toggleFirstRowHeader,
} from "../../src/kernel/pm/tableCommands";
import { tableMenuEntries, type Entry } from "../../src/kernel/pm/tableMenu";

/**
 * 112：表格结构操作。
 *
 * 移动行列是自己实现的，插删行与设表头包了一层 GFM 形状约束，所以全靠断言钉住：
 * 内容完整、顺序对、边界返回 false 让菜单置灰，而且**结果写回 Markdown 后仍是合法
 * GFM**（这才是 112 的验收标准 —— PM 内部 `doc.check()` 过了不代表 GFM 装得下）。
 */

const TBL = "# 表\n\n| 模式 | 快捷键 |\n| :--- | ---: |\n| 阅读 | Ctrl+1 |\n| 源码 | Ctrl+3 |\n\n末段。\n";

const kids = (n: PMNode): PMNode[] => {
  const o: PMNode[] = [];
  n.forEach((c) => o.push(c));
  return o;
};

/** 表格所在块的源区间（断言块外逐字节不变用） */
const tableBlock = (md: string) => topBlocks(md).find((b) => b.node.type === "table")!;

/** 第 index 个单元格（0,1 表头；2,3 第一数据行；4,5 第二数据行） */
function cellPos(doc: PMNode, index: number): number {
  let seen = -1;
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      seen++;
      if (seen === index) {
        found = pos + 1;
        return false;
      }
    }
    return true;
  });
  if (found < 0) throw new Error("找不到第 " + index + " 个单元格");
  return found;
}

/**
 * 光标落到第 cellIndex 个格子。
 *
 * 用 `TextSelection.near` 而不是 `create`：`cellPos` 指到 cell 开标签之后，
 * 那里不是 inline 容器，`create` 会报「endpoint not pointing into a node with inline content」。
 */
function stateOf(doc: PMNode, cellIndex: number): EditorState {
  const base = EditorState.create({ doc, schema: hpSchema });
  return base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(cellPos(doc, cellIndex)))));
}

const stateAt = (md: string, cellIndex: number) => stateOf(mdastToDoc(md, hpSchema), cellIndex);

/** 表格各行文字，断言行序 / 列序 */
function rowTexts(doc: PMNode): string[] {
  const table = kids(doc).find((n) => n.type.name === "table");
  return table ? kids(table).map((r) => r.textContent) : [];
}

/** 表格每行的格子类型，断言表头位置与「首行混排」 */
function rowCellTypes(doc: PMNode): string[][] {
  const table = kids(doc).find((n) => n.type.name === "table")!;
  return kids(table).map((r) => kids(r).map((c) => c.type.name));
}

/** 跑命令并返回事务；返回 false 视为失败（= 菜单会置灰） */
function step(cmd: Command, state: EditorState): PMNode {
  let out: PMNode | null = null;
  expect(cmd(state, (tr) => (out = tr.doc)), "命令返回 false（菜单会置灰）").toBe(true);
  return out!;
}

/** 命令结果按 104 的回写口径落到 Markdown 全文 */
function writtenMd(md: string, cmd: Command, cellIndex: number): string {
  const state = stateAt(md, cellIndex);
  return applyChanges(md, state.doc, step(cmd, state)).text;
}

/** 写回的 Markdown 再解析，返回表格每行的格数（数组长度 = 行数） */
function tableShape(md: string): number[] {
  const table = parseMd(md).children.find((n) => n.type === "table") as
    | { children: { children: unknown[] }[] }
    | undefined;
  if (!table) throw new Error("写回后解析不到表格：\n" + md);
  return table.children.map((r) => r.children.length);
}

describe("移动行", () => {
  it("下移一行：两条数据行顺序交换，表头不动", () => {
    expect(rowTexts(step(moveRow(1), stateAt(TBL, 2)))).toEqual([
      "模式快捷键",
      "源码Ctrl+3",
      "阅读Ctrl+1",
    ]);
  });

  it("上移一行：同样只动数据行", () => {
    expect(rowTexts(step(moveRow(-1), stateAt(TBL, 4)))).toEqual([
      "模式快捷键",
      "源码Ctrl+3",
      "阅读Ctrl+1",
    ]);
  });

  it("移动后写回 Markdown 仍是合法表格（行数、每行格数不变）", () => {
    const out = writtenMd(TBL, moveRow(1), 2);
    expect(tableShape(out)).toEqual([2, 2, 2]);
    expect(out).toContain("源码");
    expect(out).toContain("阅读");
  });

  it("块外逐字节不变（只动表格这一块）", () => {
    const table = tableBlock(TBL);
    const out = writtenMd(TBL, moveRow(1), 2);
    expect(out.slice(0, table.from)).toBe(TBL.slice(0, table.from));
    expect(out.slice(out.length - (TBL.length - table.to))).toBe(TBL.slice(table.to));
  });

  it("边界返回 false —— 菜单据此置灰，而不是点了没反应", () => {
    const last = stateAt(TBL, 4);
    expect(commandApplies(moveRow(1), last)).toBe(false); // 最后一行不能再下移
    expect(commandApplies(moveRow(-1), last)).toBe(true);
    expect(commandApplies(moveRow(-1), stateAt(TBL, 0))).toBe(false); // 表头行上面没有行
  });

  it("表头行不许离开首位（GFM 只认第一行是表头）", () => {
    expect(commandApplies(moveRow(1), stateAt(TBL, 0))).toBe(false); // 表头不能下移
    expect(commandApplies(moveRow(-1), stateAt(TBL, 2))).toBe(false); // 数据行不能顶掉表头位
  });

  it("移动行后光标落在搬走那一格的字首，不跑回原位、也不插进字中间", () => {
    const state = stateAt(TBL, 2); // 「阅读」所在格
    let next: EditorState | null = null;
    moveRow(1)(state, (tr) => (next = state.apply(tr)));
    const $to = next!.selection.$from;
    expect($to.parent.textContent).toBe("阅读");
    expect($to.parentOffset).toBe(0);
  });
});

describe("移动列", () => {
  it("右移一列：每一行的同一列一起搬，内容不串", () => {
    expect(rowTexts(step(moveColumn(1), stateAt(TBL, 0)))).toEqual([
      "快捷键模式",
      "Ctrl+1阅读",
      "Ctrl+3源码",
    ]);
  });

  it("移动列后对齐标记跟着走", () => {
    // 原：列0 左对齐（`:---`）、列1 右对齐（`---:`）→ 右移后右对齐那列排在第 0 位
    const sep = writtenMd(TBL, moveColumn(1), 0)
      .split("\n")
      .find((l) => /^\|[\s:|-]+\|$/.test(l.trim()))!;
    const cells = sep.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    expect(cells[0].endsWith(":")).toBe(true);
    expect(cells[1].startsWith(":")).toBe(true);
    expect(cells[1].endsWith(":")).toBe(false);
  });

  it("到边界返回 false", () => {
    expect(commandApplies(moveColumn(1), stateAt(TBL, 1))).toBe(false);
    expect(commandApplies(moveColumn(-1), stateAt(TBL, 0))).toBe(false);
  });

  it("带行内代码 / 链接 / 转义竖线的格子，移动列后内容原样", () => {
    const src = "| 甲 | 乙 |\n| --- | --- |\n| `code` | [链](https://e.com) \\| 尾 |\n";
    const out = writtenMd(src, moveColumn(1), 0);
    expect(out).toContain("`code`");
    expect(out).toContain("[链](https://e.com)");
    expect(out).toContain("\\|");
    expect(tableShape(out)).toEqual([2, 2]);
    // 首列现在是原第二列
    expect(out.split("\n")[2]).toMatch(/^\|\s*\[链\]/);
  });
});

describe("插入列 / 删除列", () => {
  it("右侧插入列：列数 +1、行数不变，表头行同步补格（不留混排首行）", () => {
    const state = stateAt(TBL, 0);
    const result = step(insertColumn(1), state);
    expect(rowCellTypes(result)[0]).toEqual(["table_header", "table_header", "table_header"]);
    const out = applyChanges(TBL, state.doc, result).text;
    expect(tableShape(out)).toEqual([3, 3, 3]);
  });

  it("左侧插入列：同样补在表头行，且对齐数组长度跟列数一致", () => {
    const out = writtenMd(TBL, insertColumn(-1), 0);
    expect(tableShape(out)).toEqual([3, 3, 3]);
    const sep = out.split("\n").find((l) => /^\|[\s:|-]+\|$/.test(l.trim()))!;
    expect(sep.split("|").map((c) => c.trim()).filter(Boolean)).toHaveLength(3);
  });

  it("删除本列：列数 -1，剩下的是另一列的内容", () => {
    expect(rowTexts(step(removeColumn(), stateAt(TBL, 0)))).toEqual(["快捷键", "Ctrl+1", "Ctrl+3"]);
  });

  it("插入列后光标落在新那格 —— 空格子也落得进去", () => {
    const state = stateAt(TBL, 0);
    let next: EditorState | null = null;
    insertColumn(1)(state, (tr) => (next = state.apply(tr)));
    const $to = next!.selection.$from;
    expect($to.parent.type.name).toBe("paragraph");
    expect($to.parent.textContent).toBe("");
    expect($to.parentOffset).toBe(0);
  });

  it("删除本列后对齐标记跟着少一格，剩下的列不错位", () => {
    // 删掉左对齐的「模式」列，剩下的「快捷键」列仍右对齐
    const out = writtenMd(TBL, removeColumn(), 0);
    const sep = out.split("\n").find((l) => /^\|[\s:|-]+\|$/.test(l.trim()))!;
    const cells = sep.split("|").map((c) => c.trim()).filter(Boolean);
    expect(cells).toHaveLength(1);
    expect(cells[0].endsWith(":")).toBe(true);
  });

  it("只剩一列时删除本列返回 false", () => {
    expect(commandApplies(removeColumn(), stateAt("| 模式 |\n| :--- |\n| 阅读 |\n", 0))).toBe(false);
  });
});

describe("插入行 / 删除行", () => {
  it("下方插入行：行数 +1，每行格数不变，插入的是空格子", () => {
    const out = writtenMd(TBL, addRowAfter, 2);
    expect(tableShape(out)).toEqual([2, 2, 2, 2]);
    expect(out).not.toMatch(/null/);
    // 序列化后的表格块 = 4 个表格行 + 1 条分隔行
    expect(serializeBlock(tableBlock(out).node).split("\n")).toHaveLength(5);
  });

  it("表头行上方插入行返回 false（否则空行会顶掉真表头）", () => {
    expect(commandApplies(insertRowBefore(), stateAt(TBL, 0))).toBe(false);
    expect(tableShape(writtenMd(TBL, insertRowBefore(), 2))).toEqual([2, 2, 2, 2]);
  });

  it("删除本行：行数 -1；只剩一行时返回 false", () => {
    expect(tableShape(writtenMd(TBL, deleteRow, 2))).toEqual([2, 2]);
    expect(commandApplies(deleteRow, stateAt("| 模式 | 快捷键 |\n| :--- | ---: |\n", 0))).toBe(false);
  });

  it("删除表头行：下一行顶上来当表头，仍是合法表格", () => {
    const out = writtenMd(TBL, deleteRow, 0);
    expect(tableShape(out)).toEqual([2, 2]);
    expect(out).not.toContain("模式");
    expect(out).toContain("阅读");
  });
});

describe("设为表头 / 取消表头", () => {
  it("取消首行表头：首行变普通格，行数与格数不变", () => {
    const state = stateAt(TBL, 0);
    const result = step(toggleFirstRowHeader(), state);
    expect(rowCellTypes(result)[0]).toEqual(["table_cell", "table_cell"]);
    expect(tableShape(applyChanges(TBL, state.doc, result).text)).toEqual([2, 2, 2]);
  });

  it("取消后设回来：首行又成表头（可来回切）", () => {
    const once = step(toggleFirstRowHeader(), stateAt(TBL, 0));
    expect(rowCellTypes(once)[0]).toEqual(["table_cell", "table_cell"]);
    const twice = step(toggleFirstRowHeader(), stateOf(once, 0));
    expect(rowCellTypes(twice)[0]).toEqual(["table_header", "table_header"]);
  });

  it("非首行返回 false —— GFM 里只有首行能当表头", () => {
    expect(commandApplies(toggleFirstRowHeader(), stateAt(TBL, 2))).toBe(false);
  });
});

describe("结构操作之后文档仍然合法", () => {
  it("移动 / 插删 / 设表头后 doc.check() 都通过", () => {
    for (const [cmd, cell] of [
      [moveRow(1), 2],
      [moveColumn(1), 0],
      [addRowAfter, 2],
      [insertColumn(1), 1],
      [removeColumn(), 0],
      [toggleFirstRowHeader(), 0],
    ] as const) {
      expect(step(cmd, stateAt(TBL, cell)).check()).toBeUndefined();
    }
  });

  it("每个结构操作只派发**一个**事务（117『一步撤销』的前提）", () => {
    for (const [cmd, cell] of [
      [moveRow(1), 2],
      [moveColumn(1), 0],
      [addRowAfter, 2],
      [insertColumn(-1), 1],
      [removeColumn(), 0],
      [deleteRow, 4],
      [toggleFirstRowHeader(), 0],
    ] as const) {
      let calls = 0;
      expect(cmd(stateAt(TBL, cell), () => calls++)).toBe(true);
      expect(calls).toBe(1);
    }
  });

  it("含跨格（colspan>1）的表拒绝移动，不静默搬出错位", () => {
    const doc = mdastToDoc("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n", hpSchema);
    const table = doc.child(0);
    const firstRow = table.child(0);
    const wide = firstRow.child(0).type.create(
      { ...firstRow.child(0).attrs, colspan: 2 },
      firstRow.child(0).content
    );
    const rows: PMNode[] = [firstRow.copy(Fragment.from([wide]))];
    table.forEach((r, i) => {
      if (i > 0) rows.push(r);
    });
    const state = stateOf(doc.copy(Fragment.from([table.copy(Fragment.from(rows))])), 0);
    expect(commandApplies(moveColumn(1), state)).toBe(false);
    expect(commandApplies(moveRow(1), state)).toBe(false);
    expect(commandApplies(insertColumn(1), state)).toBe(false);
  });

  it("结构操作只重写表格块，块外（标题 / 末段）逐字节不变", () => {
    const table = tableBlock(TBL);
    const out = writtenMd(TBL, addRowAfter, 4);
    expect(out.slice(0, table.from)).toBe(TBL.slice(0, table.from));
    expect(out.slice(out.length - (TBL.length - table.to))).toBe(TBL.slice(table.to));
    expect(topBlocks(out).find((b) => b.node.type === "table")!.node.children).toHaveLength(4);
  });
});

/**
 * 菜单置灰表。
 *
 * 直接拿 `TABLE_MENU_ENTRIES`（菜单真正用的那份）跑 `commandApplies`：
 * 断言「哪几项在哪个位置该是灰的」，这样 UI 层与命令层的边界条件不会各写一套。
 */
describe("右键菜单的置灰规则", () => {
  const labels = (state: EditorState): string[] =>
    tableMenuEntries().filter(
      (e): e is Extract<Entry, { kind: "item" }> => e.kind === "item" && !commandApplies(e.command, state)
    ).map((e) => e.label);

  it("表头行的首列：行相关操作全灰，列操作与删行/设表头可用", () => {
    expect(labels(stateAt(TBL, 0))).toEqual([
      "上方插入行",
      "上移一行",
      "下移一行",
      "左移一列",
    ]);
  });

  it("末行的末列：下移与右移灰，其余可用（含设表头→非首行也灰）", () => {
    expect(labels(stateAt(TBL, 5))).toEqual(["下移一行", "右移一列", "设为表头 / 取消表头"]);
  });

  it("一列一行的表：除「下方插入行」「左右插入列」「取消表头」外全灰，删行删列不许点", () => {
    const tiny = "| 模式 |\n| :--- |\n";
    expect(labels(stateAt(tiny, 0))).toEqual([
      "上方插入行",
      "上移一行",
      "下移一行",
      "左移一列",
      "右移一列",
      "删除本行",
      "删除本列",
    ]);
  });

  it("菜单项共 11 条 + 2 条分隔线，不含「设置列宽」（D9 明确不做）", () => {
    const items = tableMenuEntries().filter((e): e is Extract<Entry, { kind: "item" }> => e.kind === "item").map(
      (e) => e.label
    );
    expect(items).toHaveLength(11);
    expect(tableMenuEntries().filter((e) => e.kind === "sep")).toHaveLength(2);
    expect(items.join(",")).not.toContain("列宽");
  });
});
