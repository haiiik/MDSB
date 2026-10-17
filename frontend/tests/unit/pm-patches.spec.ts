import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { patch, serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { roundTrip } from "../../src/kernel/roundtrip";
import { parseMd } from "../../src/kernel/md";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { blockToMdast } from "../../src/kernel/pm/docToMdast";
import { hpSchema } from "../../src/kernel/pm/schema";
import { applyChanges, changedBlocks } from "../../src/kernel/pm/patches";

/**
 * 103：源区间贯穿 + 块级差异。
 *
 * 这一份是 D23 的机制性证明：`changedBlocks` 只点名真变了的块，
 * 未改动的块连序列化器都进不去。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures");
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".md") && !f.endsWith(".roundtrip.md"))
  .sort();

const kidsOf = (doc: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  doc.forEach((n) => out.push(n));
  return out;
};

/** 替换第 i 个顶层块 */
function replaceChild(doc: PMNode, i: number, node: PMNode): PMNode {
  const arr = kidsOf(doc);
  arr[i] = node;
  return doc.copy(Fragment.from(arr));
}

/** 在第 i 个位置插入一个新块（无源区间，模拟粘贴 / 回车新建） */
function insertChild(doc: PMNode, i: number, node: PMNode): PMNode {
  const arr = kidsOf(doc);
  arr.splice(i, 0, node);
  return doc.copy(Fragment.from(arr));
}

function removeChild(doc: PMNode, i: number): PMNode {
  const arr = kidsOf(doc);
  arr.splice(i, 1);
  return doc.copy(Fragment.from(arr));
}

const para = (text: string) => hpSchema.nodes.paragraph.create(null, hpSchema.text(text));
const paraWithRange = (text: string, from: number, to: number) =>
  hpSchema.nodes.paragraph.create({ srcFrom: from, srcTo: to }, hpSchema.text(text));

describe("源区间落在顶层块上", () => {
  it.each(fixtures)("%s：每个顶层块的区间能 slice 出该块原文", (name) => {
    const md = readFileSync(join(fixtureDir, name), "utf8");
    const doc = mdastToDoc(md);
    const blocks = topBlocks(md);
    const kids = kidsOf(doc);
    expect(kids.length).toBe(blocks.length);
    kids.forEach((n, i) => {
      expect(n.attrs.srcFrom).toBe(blocks[i].from);
      expect(n.attrs.srcTo).toBe(blocks[i].to);
      // 区间确实指向这一块，不是别的块
      expect(md.slice(n.attrs.srcFrom, n.attrs.srcTo).trim().length).toBeGreaterThan(0);
    });
  });

  it("不透明块把原文逐字节存在 raw 上（编辑别处时能原样写回）", () => {
    const md = "---\ntitle: 甲\n---\n\n# 标题\n\n<div class=\"x\">内容</div>\n\n段落\n";
    const doc = mdastToDoc(md);
    const opaques = kidsOf(doc).filter((n) => n.type.name === "opaque_block");
    expect(opaques.length).toBe(2); // yaml + html
    for (const o of opaques) {
      expect(md.slice(o.attrs.srcFrom, o.attrs.srcTo)).toBe(o.attrs.raw);
    }
    expect(opaques.map((o) => o.attrs.raw)).toContain('<div class="x">内容</div>');
  });
});

describe("changedBlocks 只点名真变了的块", () => {
  const md = "# 标题\n\n段落甲\n\n段落乙\n\n段落丙\n\n段落丁\n";

  it("未改动 → 零个 patch，文本恒等", () => {
    const doc = mdastToDoc(md);
    expect(changedBlocks(doc, doc, md)).toHaveLength(0);
    expect(applyChanges(md, doc, doc).text).toBe(md);
  });

  it("改一个段落 → 恰好一个 patch，区间就是那一块", () => {
    const doc = mdastToDoc(md);
    const blocks = topBlocks(md);
    const next = replaceChild(doc, 1, paraWithRange("段落甲改过了", blocks[1].from, blocks[1].to));
    const patches = changedBlocks(doc, next, md);
    expect(patches).toHaveLength(1);
    expect(patches[0].from).toBe(blocks[1].from);
    expect(patches[0].to).toBe(blocks[1].to);
    const out = patch(md, patches);
    expect(out).toContain("段落甲改过了");
    // 块外逐字节不变
    expect(out.slice(0, blocks[1].from)).toBe(md.slice(0, blocks[1].from));
    expect(out.slice(out.length - (md.length - blocks[1].to))).toBe(md.slice(blocks[1].to));
  });

  it("两处分散修改 → 两个 patch，中间的块不被卷进重排", () => {
    const doc = mdastToDoc(md);
    const blocks = topBlocks(md);
    let next = replaceChild(doc, 1, paraWithRange("段落甲改过", blocks[1].from, blocks[1].to));
    next = replaceChild(next, 3, paraWithRange("段落丙改过", blocks[3].from, blocks[3].to));
    const patches = changedBlocks(doc, next, md);
    expect(patches).toHaveLength(2);
    expect(patches.map((p) => [p.from, p.to])).toEqual([
      [blocks[1].from, blocks[1].to],
      [blocks[3].from, blocks[3].to],
    ]);
    const out = patch(md, patches);
    // 段落乙 / 段落丁 一个字节没动
    expect(out).toContain(md.slice(blocks[2].from, blocks[2].to));
    expect(out).toContain(md.slice(blocks[4].from, blocks[4].to));
  });

  it("拆块（段落中间回车）→ 一个 patch 覆盖原块区间", () => {
    const doc = mdastToDoc(md);
    const blocks = topBlocks(md);
    // 一个段落拆成两段：第一段保留原区间，第二段无源（新内容）
    let next = replaceChild(doc, 1, paraWithRange("段落甲前半", blocks[1].from, blocks[1].to));
    next = insertChild(next, 2, para("段落甲后半"));
    const patches = changedBlocks(doc, next, md);
    expect(patches).toHaveLength(1);
    expect(patches[0].from).toBe(blocks[1].from);
    expect(patches[0].to).toBe(blocks[1].to);
    const out = patch(md, patches);
    expect(out).toContain("段落甲前半");
    expect(out).toContain("段落甲后半");
    expect(out.slice(0, blocks[1].from)).toBe(md.slice(0, blocks[1].from));
  });

  it("中间插入新块 → 零长度区间，不吞掉邻居", () => {
    const doc = mdastToDoc(md);
    const next = insertChild(doc, 2, para("新插进来的一段"));
    const patches = changedBlocks(doc, next, md);
    expect(patches).toHaveLength(1);
    expect(patches[0].from).toBe(patches[0].to);
    const out = patch(md, patches);
    expect(out).toContain("新插进来的一段");
    // 邻居块仍在且各自区间内容原样
    const blocks = topBlocks(md);
    for (const b of blocks) expect(out).toContain(md.slice(b.from, b.to));
    // 插入块与前后各隔一个空行
    expect(out).toMatch(/段落甲\n\n新插进来的一段\n\n段落乙/);
  });

  it("删除整块 → 不留一串无意义空行", () => {
    const doc = mdastToDoc(md);
    const next = removeChild(doc, 2); // 删掉「段落乙」
    const out = applyChanges(md, doc, next).text;
    expect(out).not.toContain("段落乙");
    expect(out).not.toMatch(/\n{3,}/);
    expect(topBlocks(out).length).toBe(4);
  });

  it("改完再改回来 → 文本与原文逐字节相同（脏判定的前提）", () => {
    const doc = mdastToDoc(md);
    const blocks = topBlocks(md);
    const changed = replaceChild(doc, 1, paraWithRange("改了又", blocks[1].from, blocks[1].to));
    const back = replaceChild(changed, 1, paraWithRange("段落甲", blocks[1].from, blocks[1].to));
    expect(applyChanges(md, doc, back).text).toBe(md);
  });
});

describe("反向映射覆盖所有内容类型", () => {
  /**
   * 这条测的是「**内容不丢**」，不是「字节与整篇序列化一致」。
   *
   * 原先按字节比，红了 3 份夹具，逐条查下去确认全是外观级差异，且都只发生在
   * 「把每一块都改名」这种人工场景（真实编辑只会碰一两块，块外由 patch 逐字节拷回）：
   * - 02-inline：`***粗斜体***` 经 PM 变成 `**_粗斜体_**`（mark 嵌套顺序被 schema 规范化）
   * - 05-code / 07-block：相邻代码围栏之间、相邻脚注定义之间，remark 的**文档级**
   *   序列化不加空行，而逐块 patch 是按「块 + 空行」拼的
   * 字节级的局部性保证由上面那组用例负责，这里不重复主张。
   */
  it.each(fixtures)("%s：整篇走「解析→PM→逐块序列化→patch(全部块)」后内容等价", (name) => {
    const md = readFileSync(join(fixtureDir, name), "utf8");
    const doc = mdastToDoc(md);
    const blocks = topBlocks(md);
    const patches = blocks.map((b, i) => ({
      from: b.from,
      to: b.to,
      md: serializeBlock(blockToMdast(kidsOf(doc)[i]) as Parameters<typeof serializeBlock>[0]),
    }));
    const out = patch(md, patches);

    // 1) 结构与文字必须等价
    expect(normalize(out)).toEqual(normalize(roundTrip(md)));
    // 2) 幂等：再走一遍不继续漂移
    expect(normalize(roundTrip(out))).toEqual(normalize(roundTrip(md)));
  });
});

/**
 * 去掉 position，并把 `***x***` 的两种嵌套写法归一。
 *
 * 归一是必须的，不是和稀泥：ProseMirror 的 mark 是**按 schema 排序的集合**，
 * 不记录「strong 包 em」还是「em 包 strong」。所以 `***粗斜体***` 经编辑模式
 * 往返必然变成 `**_粗斜体_**` —— 渲染结果相同，是模型层面的既定代价，
 * 已记进 106 工单与 README 已知坑。
 */
function normalize(md: string): unknown {
  return collapse(stripPositions(parseMd(md)) as MdNode);
}

type MdNode = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

function stripPositions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "position") continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return node;
}

const WRAPPERS = new Set(["strong", "emphasis", "delete"]);

/**
 * 把「单孩子包裹链」压成与顺序无关的形式。
 *
 * 为什么必须归一而不是修代码：ProseMirror 的 mark 是**按 schema 排序的集合**，
 * 不记录「strong 包 delete」还是「delete 包 strong」。所以 `***粗斜体***`
 * 经编辑模式往返会变成 `**_粗斜体_**`、`**~~删掉~~**` 会变成 `~~**删掉**~~`。
 * 渲染结果相同，属模型层面的既定代价（已记进 106 与 README），不是待修 bug。
 *
 * 注意：这条**只豁免包裹顺序**，不豁免内容 —— 上面那个「行内代码被写空」的
 * 真丢内容 bug 不会被这个归一掩盖，因为它改的是 children 结构而不是顺序。
 */
function collapse(node: MdNode): MdNode {
  if (Array.isArray(node)) return node.map(collapse) as MdNode;
  if (!node || typeof node !== "object") return node;

  const chain: string[] = [];
  let cur = node as Record<string, unknown>;
  while (WRAPPERS.has(String(cur.type))) {
    const ch = (cur.children as Record<string, unknown>[]) ?? [];
    if (ch.length !== 1) break;
    chain.push(String(cur.type));
    cur = ch[0];
  }
  if (chain.length > 1) {
    return { markSet: [...chain].sort(), inner: collapse(cur) };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = collapse(v as MdNode);
  return out;
}
