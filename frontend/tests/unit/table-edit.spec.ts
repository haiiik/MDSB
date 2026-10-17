import { Fragment, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { parseMd } from "../../src/kernel/md";
import { serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { blockToMdast } from "../../src/kernel/pm/docToMdast";
import { applyChanges } from "../../src/kernel/pm/patches";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 111：表格单元格直接编辑的保真路径。
 *
 * 表格是「一个表格 = 一个块」，所以改一格会重排整块 ——
 * 这颗的职责是把「重排时不许丢东西」逐条钉住：对齐标记、`|` 转义、
 * 空单元格、行内代码、链接、畸形列数。
 */

const kids = (n: PMNode): PMNode[] => {
  const o: PMNode[] = [];
  n.forEach((c) => o.push(c));
  return o;
};

function replaceDeep(n: PMNode, from: string, to: string): PMNode {
  if (n.isText && n.text === from) return hpSchema.text(to, n.marks);
  if (!n.childCount) return n;
  return n.copy(Fragment.from(n.children.map((c) => replaceDeep(c, from, to))));
}

const editCell = (doc: PMNode, from: string, to: string): PMNode => replaceDeep(doc, from, to);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "position") continue;
      o[k] = strip(v);
    }
    return o;
  }
  return node;
}

describe("改一格：块外逐字节不变", () => {
  const src = "# 表\n\n| 模式 | 快捷键 |\n| :--- | ---: |\n| 阅读 | Ctrl+1 |\n| 源码 | Ctrl+3 |\n\n末段不动。\n";

  it("落盘只差那一格，标题/末段/对齐标记都不动", () => {
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, editCell(doc, "Ctrl+1", "Ctrl+2")).text;
    const table = topBlocks(src)[1];
    // 块外逐字节
    expect(out.slice(0, table.from)).toBe(src.slice(0, table.from));
    expect(out.slice(out.length - (src.length - table.to))).toBe(src.slice(table.to));
    expect(out).toContain("Ctrl+2");
    expect(out).toContain("Ctrl+3");
  });

  it("对齐标记编辑后保持左/右，不统一成默认", () => {
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, editCell(doc, "阅读", "阅读模式")).text;
    // 断言的是「对齐语义还在」，不是破折号数量 —— 补齐列宽会改变 dash 数
    // 分隔行长这样：`| :--- | -----: |` —— 含内部竖线，正则要允许
    const sep = out.split("\n").find((l) => /^\|\s*[:\-]+\s*(\|\s*[:\-]+\s*)+\|$/.test(l.trim()))!;
    expect(sep, "没找到表格分隔行").toBeTruthy();
    const cells = sep.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    expect(cells[0].startsWith(":")).toBe(true); // 第一列仍左对齐
    expect(cells[1].endsWith(":")).toBe(true); // 第二列仍右对齐
  });

  it("钉住代价：改过的表格会被补齐列宽（remark 行为，关不掉）", () => {
    const tight = "| 甲 | 乙乙乙乙 |\n| --- | --- |\n| 1 | 2 |\n";
    const doc = mdastToDoc(tight);
    const out = applyChanges(tight, doc, editCell(doc, "1", "11")).text;
    // 实测值（CJK 按几个字符宽由 remark 决定，别猜，钉住它）：
    // 分隔行与数据行都被撑到与该列最宽单元格同宽
    expect(out).toBe("| 甲  | 乙乙乙乙 |\n| -- | ---- |\n| 11 | 2    |\n");
  });
});

describe("单元格内容不塌陷", () => {
  it("单元格内的 `|` 转义在编辑别处后仍是转义形式，不错列", () => {
    const src = "| 列 | 内容 |\n| --- | --- |\n| 甲 | 含竖线 \\| 转义 |\n| 乙 | 尾部 \\| |\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, editCell(doc, "甲", "甲改过")).text;
    expect(out).toContain("\\|");
    // 列数仍是 2：每行的未转义竖线数一致
    for (const line of out.split("\n").filter((l) => l.trim())) {
      const unescaped = line.replace(/\\\|/g, "");
      expect((unescaped.match(/\|/g) ?? []).length).toBe(3);
    }
  });

  it("空单元格 / 行内代码 / 链接 三种内容往返结构等价", () => {
    const src =
      "| 甲 | 乙 | 丙 | 丁 |\n| --- | --- | --- | --- |\n|  | `code` | [链](https://e.com) | **粗** |\n";
    const doc = mdastToDoc(src);
    const ast = parseMd(src) as unknown as { children: unknown[] };
    expect(strip(blockToMdast(kids(doc)[0]))).toEqual(strip(ast.children[0]));
  });

  it("含 `<br>` 的单元格不被抹掉（103 修过的回归，别再退回去）", () => {
    const src = "| 列 | 内容 |\n| --- | --- |\n| 多行 | 第一行<br>第二行 |\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, editCell(doc, "多行", "多行改过")).text;
    expect(out).toContain("第一行<br>第二行");
  });
});

describe("畸形表格不丢行", () => {
  it("列数不一致的原文：编辑后行数不减、文字不丢", () => {
    const src = "| 甲 | 乙 |\n| --- | --- |\n| 只有一格 |\n| 一 | 二 | 三 |\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, editCell(doc, "一", "壹")).text;
    const rows = out.split("\n").filter((l) => l.trim().startsWith("|"));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const t of ["只有一格", "三", "壹", "二"]) expect(out).toContain(t);
  });

  it("整表往返结构等价（列数一致的正常表）", () => {
    const src = "| A | B |\n| :--- | :-: |\n| 1 | 2 |\n";
    const doc = mdastToDoc(src);
    const ast = parseMd(src) as unknown as { children: unknown[] };
    expect(strip(blockToMdast(kids(doc)[0]))).toEqual(strip(ast.children[0]));
  });
});

describe("表格在 PM 文档里合法", () => {
  it("表头行是 table_header，数据行是 table_cell", () => {
    const doc = mdastToDoc("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n", hpSchema);
    const table = kids(doc)[0];
    expect(kids(table)[0].child(0).type.name).toBe("table_header");
    expect(kids(table)[1].child(0).type.name).toBe("table_cell");
  });
});
