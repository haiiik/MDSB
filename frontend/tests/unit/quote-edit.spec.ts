import { Fragment, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { parseMd } from "../../src/kernel/md";
import { serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { blockToMdast } from "../../src/kernel/pm/docToMdast";
import { applyChanges } from "../../src/kernel/pm/patches";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 108：引用块与分割线。
 *
 * 映射在 102 就有了，这颗的职责是**拿真实 Markdown 形态去撞缺口**：
 * 嵌套引用、引用里套列表与代码、空引用、只有 `>` 没有内容的行、
 * 以及分割线的三种写法在未编辑时是否原样活着。
 */

const kids = (n: PMNode): PMNode[] => {
  const o: PMNode[] = [];
  n.forEach((c) => o.push(c));
  return o;
};

/** 替换第 i 个顶层块里的某段文字 */
function replaceText(doc: PMNode, from: string, to: string): PMNode {
  const rebuild = (n: PMNode): PMNode => {
    // 文本节点必须用 schema.text() 造：NodeType.create 会直接抛
    // "NodeType.create can't construct text nodes"
    if (n.isText && n.text === from) return hpSchema.text(to, n.marks);
    if (!n.childCount) return n;
    return n.copy(Fragment.from(n.children.map(rebuild)));
  };
  return doc.copy(Fragment.from(kids(doc).map(rebuild)));
}

/** 结构等价比对：去掉 position，并把 mark 包裹链归一（见 106 的既定代价说明） */
function canonical(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonical);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "position") continue;
      out[k] = canonical(v);
    }
    return out;
  }
  return node;
}

describe("引用块", () => {
  it("改引用内一句 → 只有该引用块变化，块外逐字节不动", () => {
    const src = "# 标题\n\n> 口径以工单库为准。\n\n正文段落。\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, replaceText(doc, "口径以工单库为准。", "口径以工单库为准，报表库仅展示。")).text;
    const quote = topBlocks(src)[1];
    expect(out.slice(0, quote.from)).toBe(src.slice(0, quote.from));
    expect(out).toContain("> 口径以工单库为准，报表库仅展示。");
    expect(out).toContain("正文段落。");
  });

  it("嵌套引用 `> >` 层级不丢", () => {
    const src = "> 外层\n> > 内层\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, doc).text;
    expect(out).toBe(src);
    // 结构上确实是两层 blockquote
    const ast = parseMd(src) as unknown as { children: { type: string; children?: unknown[] }[] };
    const inner = (ast.children[0].children as { type: string }[]) ?? [];
    expect(inner.some((c) => c.type === "blockquote")).toBe(true);
    // 走一圈 PM 再回来，层级还在
    const back = blockToMdast(kids(doc)[0]) as { type: string; children: unknown[] };
    expect(back.type).toBe("blockquote");
    expect(canonical(back)).toEqual(canonical(ast.children[0]));
  });

  it("引用里套列表与代码块：往返结构等价", () => {
    const src = "> 说明：\n>\n> - 甲\n> - 乙\n>\n> ```ts\n> const a = 1\n> ```\n";
    const doc = mdastToDoc(src);
    const ast = parseMd(src) as unknown as { children: unknown[] };
    const back = blockToMdast(kids(doc)[0]);
    expect(canonical(back)).toEqual(canonical(ast.children[0]));
  });

  it("空引用与只有 `>` 的行不报错、内容不丢", () => {
    const cases: [string, string][] = [
      ["> \n\n正文\n", "正文"],
      [">\n> 有内容\n", "有内容"],
      ["> 甲\n>\n> 乙\n", "乙"],
    ];
    for (const [src, mustKeep] of cases) {
      const doc = mdastToDoc(src); // 不该抛
      expect(doc.childCount).toBeGreaterThan(0);
      expect(doc.textContent).toContain(mustKeep);
      // 未编辑时逐字节原样
      expect(applyChanges(src, doc, doc).text).toBe(src);
    }
  });

  it("引用内多段落：往返后段落数不变", () => {
    const src = "> 第一段\n>\n> 第二段\n";
    const doc = mdastToDoc(src);
    const quote = kids(doc)[0];
    expect(quote.childCount).toBe(2);
    const ast = parseMd(src) as unknown as { children: { children: unknown[] }[] };
    expect(canonical(blockToMdast(quote))).toEqual(canonical(ast.children[0]));
  });
});

describe("分割线", () => {
  it("未编辑时 `***` / `___` / `- - -` 逐字节原样活着（按块替换天然成立）", () => {
    for (const src of ["甲\n\n***\n\n乙\n", "甲\n\n___\n\n乙\n", "甲\n\n- - -\n\n乙\n"]) {
      const doc = mdastToDoc(src);
      expect(applyChanges(src, doc, doc).text).toBe(src);
    }
  });

  it("钉住代价：hr 块一旦被重新序列化就统一成 `---`（md.ts 的 rule:\"-\"）", () => {
    // 不能用「换成一个无源区间的新 hr」来触发重排 —— contentEq 故意忽略源区间，
    // 两个 hr 内容等价，changedBlocks 不会点名它（这本身是正确行为）。
    // 所以直接测单块序列化的输出。
    // 注：`rule: "-"` 的语义是「用 `-` 作分割线字符」，remark 固定写三个，
    // 所以归一目标是 `---` 而不是单个 `-`。
    for (const src of ["***", "___", "- - -", "* * *"]) {
      const blocks = topBlocks(src + "\n");
      expect(serializeBlock(blocks[0].node)).toBe("---");
    }
  });

  it("分割线未破坏相邻块", () => {
    const src = "段落甲\n\n---\n\n段落乙\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, replaceText(doc, "段落甲", "段落甲改过")).text;
    expect(out).toContain("段落甲改过");
    expect(out).toContain("段落乙");
    expect(out).toContain("---"); // 未点名的 hr 块原样
  });
});
