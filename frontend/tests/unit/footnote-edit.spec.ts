import { describe, expect, it } from "vitest";
import { Fragment, Node as PMNode } from "prosemirror-model";
import { patch, serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { parseMd } from "../../src/kernel/md";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { blockToMdast } from "../../src/kernel/pm/docToMdast";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 136-B 的保真判据：脚注定义块从「不透明占位」升级成「可编辑节点」之后，
 * **没编辑时仍然逐字节不动**，编辑时只动那一块。
 *
 * 这两条是 Q27（已定：先不做跨块重排）能成立的唯一凭据 ——
 * 光靠"我们没写重排代码"不算证据，必须钉住落盘字节。
 */

const MD = [
  "正文一句[^a]，再来一句[^b]。",
  "",
  "中间段落，用来隔开两块脚注定义。",
  "",
  "[^a]: 第一个定义",
  "  两格缩进的续行",
  "",
  "[^b]:   第二个定义，冒号后三个空格",
  "",
].join("\n");

function kidsOf(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.forEach((n) => out.push(n));
  return out;
}

function findDef(doc: PMNode, label: string): PMNode {
  const hit = kidsOf(doc).find((n) => n.type.name === "footnote_def" && n.attrs.label === label);
  if (!hit) throw new Error(`文档里没有 [^${label}] 的定义块`);
  return hit;
}

/** 第 i 个顶层块的原文 */
function blockText(md: string, i: number): string {
  const ast = parseMd(md);
  const node = ast.children[i] as unknown as { position?: { start?: { offset?: number }; end?: { offset?: number } } };
  const from = node.position?.start?.offset ?? 0;
  const to = node.position?.end?.offset ?? md.length;
  return md.slice(from, to);
}

describe("136-B：脚注定义块升级成可编辑节点后的保真", () => {
  const doc = mdastToDoc(MD, hpSchema);

  it("解析后确实是 footnote_def / footnote_ref（不是又退回占位块）", () => {
    expect(findDef(doc, "a").type.name).toBe("footnote_def");
    expect(findDef(doc, "b").type.name).toBe("footnote_def");
    let refs = 0;
    doc.descendants((n) => {
      if (n.type.name === "footnote_ref") refs++;
      return true;
    });
    expect(refs).toBe(2);
  });

  it("不编辑时，定义块序列化回来逐字节等于原文", () => {
    const blocks = topBlocks(MD);
    for (const label of ["a", "b"]) {
      const node = findDef(doc, label);
      const i = kidsOf(doc).indexOf(node);
      const serialized = serializeBlock(blockToMdast(node) as Parameters<typeof serializeBlock>[0]);
      expect(serialized, `[^${label}]`).toBe(blockText(MD, i));
      // 顺带钉住"块区间也对得上"：patch 用它定位，指错就写错地方
      expect(MD.slice(blocks[i].from, blocks[i].to)).toBe(blockText(MD, i));
    }
  });

  it("整篇「只重序列化脚注块再 patch」= 原文一字不变", () => {
    const blocks = topBlocks(MD);
    const kids = kidsOf(doc);
    const patches = kids
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.type.name === "footnote_def")
      .map(({ n, i }) => ({
        from: blocks[i].from,
        to: blocks[i].to,
        md: serializeBlock(blockToMdast(n) as Parameters<typeof serializeBlock>[0]),
      }));
    expect(patches.length).toBe(2);
    expect(patch(MD, patches)).toBe(MD);
  });

  it("改一条定义的正文：只有那一块变，另一条与正文段落逐字节不动", () => {
    const blocks = topBlocks(MD);
    const kids = kidsOf(doc);
    const i = kids.indexOf(findDef(doc, "a"));
    const edited = kids[i].copy(Fragment.fromArray([hpSchema.text("改过的正文")]));
    const out = patch(MD, [
      {
        from: blocks[i].from,
        to: blocks[i].to,
        md: serializeBlock(blockToMdast(edited) as Parameters<typeof serializeBlock>[0]),
      },
    ]);
    expect(out).toContain("[^a]: 改过的正文");
    // 原文里那条的续行没了 —— 因为把整块正文换掉了，这是"这一块动过"的应有含义
    expect(out).toContain("[^b]:   第二个定义，冒号后三个空格");
    expect(out).toContain("正文一句[^a]，再来一句[^b]。");
    expect(out).toContain("中间段落，用来隔开两块脚注定义。");
    // 只有这一块被换掉：块数不变、其它块的字节区间内容不变
    const after = topBlocks(out);
    expect(after.length).toBe(blocks.length);
    for (let k = 0; k < blocks.length; k++) {
      if (k === i) continue;
      expect(out.slice(after[k].from, after[k].to)).toBe(MD.slice(blocks[k].from, blocks[k].to));
    }
  });

  it("引用节点按原文落地（改不了引用文字，就不该产生差异）", () => {
    const blocks = topBlocks(MD);
    const para = kidsOf(doc)[0];
    expect(serializeBlock(blockToMdast(para) as Parameters<typeof serializeBlock>[0])).toBe(
      MD.slice(blocks[0].from, blocks[0].to)
    );
  });
});
