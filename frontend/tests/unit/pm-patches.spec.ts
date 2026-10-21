import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { patch, serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { roundTrip } from "../../src/kernel/roundtrip";
import { parseMd } from "../../src/kernel/md";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { blockToMdast } from "../../src/kernel/pm/docToMdast";
import { hpSchema } from "../../src/kernel/pm/schema";
import { applyChanges, changedBlocks } from "../../src/kernel/pm/patches";
import { documentShapePlugin, ensureTrailingParagraph, needsTrailingParagraph } from "../../src/kernel/pm/plugins";

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

  /**
   * 142：**无源区间的旧块**不能拿邻居的边界当自己的边界。
   *
   * 两条都对应真路径：末尾那一行是 `ensureTrailingParagraph` 补出来的（没有原文），
   * 中间那一段是粘贴落盘的块（同样没有原文）。少掉「往外退时补回空行」这一步，
   * 写出来的就是 `| 采油 | 12 |补一句` 这种把下一段粘到表格最后一行上的坏文件。
   */
  it("142：末尾补的那一行被写进字 → 前后补回空行，末尾换行没被改掉", () => {
    const md = "# 口径\n\n正文一段。\n\n| 部门 | 慢单数 |\n| :--- | ---: |\n| 采油 | 12 |\n";
    const doc = mdastToDoc(md);
    const withTail = insertChild(doc, kidsOf(doc).length, hpSchema.nodes.paragraph.create());
    const typed = replaceChild(withTail, kidsOf(withTail).length - 1, para("补一句"));
    const out = applyChanges(md, withTail, typed).text;

    // 原文末尾那个换行保留，新段落与表格之间恰好一个空行
    expect(out).toBe("# 口径\n\n正文一段。\n\n| 部门 | 慢单数 |\n| :--- | ---: |\n| 采油 | 12 |\n\n补一句\n");
    // 表格仍是表格，新内容仍是独立的一段
    const blocks = topBlocks(out);
    expect(blocks.map((b) => b.node.type)).toEqual(["heading", "paragraph", "table", "paragraph"]);
  });

  it("142：改一个已落盘但没有源区间的块 → 邻居之间的空行不丢", () => {
    const md = "甲段\n\n乙段\n\n丙段\n";
    const 原块 = topBlocks(md);
    // 模拟「乙段」是上一轮粘贴写进去的：文本里有它，但它没有源区间
    const doc = hpSchema.nodes.doc.create(null, [
      paraWithRange("甲段", 原块[0].from, 原块[0].to),
      para("乙段"),
      paraWithRange("丙段", 原块[2].from, 原块[2].to),
    ]);
    const next = replaceChild(doc, 1, para("乙段改过"));
    const out = applyChanges(md, doc, next).text;
    expect(out).toBe("甲段\n\n乙段改过\n\n丙段\n");
    expect(out).not.toContain("甲段乙");
    expect(out).not.toContain("丙段乙");
  });

  /**
   * 142：区域两边**连着好几块都没有源区间**时，边界不能一路兜到文件头/文件尾。
   *
   * 旧写法（`from = prev.to ?? 0`、`to = next.from ?? source.length`）在这种情况下
   * 会把「区间外那些没原文的块」连它们的字节一起换掉 —— 那是**整块丢内容**。
   * 真路径很常见：连粘两段进来、再改其中一段；或改的就是末尾那一行旁边的一段。
   */
  describe("连续无源块：区间外的块要原样写回", () => {
    const md = "甲段\n\n乙段\n\n丙段\n";
    const 原块 = topBlocks(md);
    // 乙、丙都是粘贴进来的：文本里有字节，但指不出区间
    const doc = hpSchema.nodes.doc.create(null, [
      paraWithRange("甲段", 原块[0].from, 原块[0].to),
      para("乙段"),
      para("丙段"),
    ]);

    it("改前一块（乙）→ 后面的丙一个字节没丢，空行也没并掉", () => {
      const out = applyChanges(md, doc, replaceChild(doc, 1, para("乙段改过"))).text;
      expect(out).toBe("甲段\n\n乙段改过\n\n丙段\n");
      expect(topBlocks(out).length).toBe(3);
    });

    it("改后一块（丙）→ 前面的乙一个字节没丢", () => {
      const out = applyChanges(md, doc, replaceChild(doc, 2, para("丙段改过"))).text;
      expect(out).toBe("甲段\n\n乙段\n\n丙段改过\n");
      expect(out).not.toContain("甲段乙段");
      expect(topBlocks(out).length).toBe(3);
    });

    it("两块都改 → 两块的新内容都在，甲段仍逐字节不动", () => {
      let next = replaceChild(doc, 1, para("乙改"));
      next = replaceChild(next, 2, para("丙改"));
      const out = applyChanges(md, doc, next).text;
      expect(out).toBe("甲段\n\n乙改\n\n丙改\n");
    });

    /**
     * review 抓到的一条（我自己没测到）：**纯删除一个无源块时不许留下双空行**。
     *
     * 后导空行那条判据原来写的是 `md !== ""`，而上一行刚给 `md` 加过前导空行，
     * 于是"后面根本没有内容"的位置也被补了一段空行 → `甲段\n\n\n\n丙段`。
     * 判据改成看**这次到底有没有写下内容**（`段.length`）。
     */
    it("删掉中间那块无源块 → 只留一个空行，不是一串", () => {
      const 删掉 = hpSchema.nodes.doc.create(null, [doc.child(0), doc.child(2)]);
      const out = applyChanges(md, doc, 删掉).text;
      expect(out).toBe("甲段\n\n丙段\n");
      expect(out).not.toMatch(/\n{3,}/);
    });
  });
});

describe("142：文档末尾永远留一行能写字的", () => {
  const table = hpSchema.nodes.table.create(null, [
    hpSchema.nodes.table_row.create(null, [hpSchema.nodes.table_cell.createAndFill()!]),
  ]);
  const hr = hpSchema.nodes.horizontal_rule.create();
  const code = hpSchema.nodes.code_block.create(null, hpSchema.text("let a = 1;"));
  const quote = hpSchema.nodes.blockquote.create(null, para("引用的话。"));
  const list = hpSchema.nodes.bullet_list.create(null, [
    hpSchema.nodes.list_item.create(null, [para("第一项")]),
  ]);

  it.each([
    ["table", table],
    ["horizontal_rule", hr],
    ["code_block", code],
    ["blockquote", quote],
    ["bullet_list", list],
    ["heading", hpSchema.nodes.heading.create({ level: 2 }, hpSchema.text("收尾"))],
  ])("末尾是 %s → 补一个空段落", (_名, 块) => {
    const doc = hpSchema.nodes.doc.create(null, [para("上面一段。"), 块]);
    expect(needsTrailingParagraph(doc)).toBe(true);
    const next = ensureTrailingParagraph(doc);
    expect(kidsOf(next).map((n) => n.type.name)).toEqual(["paragraph", _名, "paragraph"]);
    // 补的那一行**不带源区间**：它没有原文，回写时按纯插入落地（见上面那两条 patch 用例）
    expect(kidsOf(next)[2].attrs.srcFrom).toBeNull();
    // 补完就不再缺落点，第二次调用必须原样返回（幂等，appendTransaction 才不会反复触发）
    expect(needsTrailingParagraph(next)).toBe(false);
    expect(ensureTrailingParagraph(next)).toBe(next);
  });

  it("末尾已经是普通段落 → 什么都不补（也不许复制出一份新文档）", () => {
    const doc = hpSchema.nodes.doc.create(null, [para("最后一句话。")]);
    expect(needsTrailingParagraph(doc)).toBe(false);
    expect(ensureTrailingParagraph(doc)).toBe(doc);
  });

  /**
   * 142：Ctrl+A 删到空，**不许剩下一个打不了字的占位块**。
   *
   * 根因不在我们的代码里：PM 自动填空用 `ContentMatch.defaultType`，
   * 它取「这个位置第一个不是文本、又没有必填属性的类型」，而这张 schema 的 block 组
   * 排到第一的是 `opaque_block` —— 于是删干净之后文档变成「此内容编辑模式不修改」，
   * 打字全落空。这条用例第一行就是盯着这张匹配表：顺序哪天变了，这里先红，别等到用户身上。
   */
  it("142：删到空之后文档是一个段落，而不是 PM 填出来的空占位块", () => {
    expect(hpSchema.nodes.doc.contentMatch.defaultType?.name).toBe("opaque_block");
    const doc = mdastToDoc("整篇都要删掉。\n");
    let state = EditorState.create({ schema: hpSchema, doc, plugins: [documentShapePlugin()] });
    state = state.apply(state.tr.delete(0, doc.content.size));
    expect(kidsOf(state.doc).map((n) => n.type.name)).toEqual(["paragraph"]);
    // 守门：这条事务之后文档必须合法（`check()` 会拒绝一个字的块都不剩的 doc）
    expect(() => state.doc.check()).not.toThrow();
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
