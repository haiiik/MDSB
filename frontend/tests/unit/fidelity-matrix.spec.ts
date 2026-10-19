import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { patch, topBlocks } from "../../src/kernel/blockPatch";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { changedBlocks } from "../../src/kernel/pm/patches";

/**
 * 120：保真总验收矩阵（US-42 的收口颗）。
 *
 * 这张表把散在 106~116 各块类型里的「改一处只有那一处变化」汇成**一条可重复执行的断言**。
 * 每行先分类再给结论（审计 2026-10-14 加的口径）：
 *
 * - **恒等类**：只要 101 的 patch + 103 的源区间/不透明保留做对了就成立，
 *   **不需要该类型可编辑**。这一类必须全绿，红一条就是保真事故。
 * - **实现类**：依赖对应块类型的编辑工单交付。
 *
 * 断言方式是**字节级局部性**，不是「整篇相等」：
 * 原文与结果的差集必须严格落在被点名块的 `[srcFrom, srcTo)` 内 ——
 * 也就是「块前缀逐字节相同 + 块后缀逐字节相同」。
 * 这正是 D23「按块替换」的全部主张，也是 `report:drift`（管整篇往返漂移）不管的那一半。
 *
 * 「改一处」在这里表达成：**把那一块的 Markdown 换掉，重新解析成 PM 节点，
 * 并盖上同一份源区间**。这与真实编辑的落点等价 ——
 * PM 那边一块的模型变了，`changedBlocks` 拿到的是同一对（旧块, 新块）。
 */

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/fidelity/${name}`, import.meta.url)), "utf8");

type Result = {
  /** 原文 */
  md: string;
  /** 按块 patch 之后的文本 */
  out: string;
  /** 被点名那一块的源区间 */
  block: { from: number; to: number };
  /** 这次改动生成了几个 patch */
  patchCount: number;
};

const kidsOf = (doc: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  doc.forEach((n) => out.push(n));
  return out;
};

/** 找到「原文里含这段文字」的那个顶层块 */
function blockIndexOf(md: string, text: string): number {
  const i = topBlocks(md).findIndex((b) => md.slice(b.from, b.to).includes(text));
  if (i < 0) throw new Error(`夹具里找不到含「${text}」的块`);
  return i;
}

/**
 * 把第 index 个块换成 `newBlockMd`，走完整链路：解析 → changedBlocks → patch。
 * 这就是产品里 `EditView.commit()` 的那三步，一个字没多。
 */
function editBlock(md: string, index: number, newBlockMd: string): Result {
  const doc = mdastToDoc(md);
  const blocks = topBlocks(md);
  const target = blocks[index];
  const parsed = mdastToDoc(newBlockMd);
  const node = parsed.firstChild;
  if (!node) throw new Error("新块解析不出节点");
  // 盖上原来那份源区间：改过的块仍然指向原文里它自己那一段
  const stamped = node.copy(node.content, { ...node.attrs, srcFrom: target.from, srcTo: target.to });
  const arr = kidsOf(doc);
  arr[index] = stamped;
  const next = doc.copy(Fragment.from(arr));
  const patches = changedBlocks(doc, next, md);
  return { md, out: patch(md, patches), block: target, patchCount: patches.length };
}

function editBlockByText(md: string, text: string, newBlockMd: string): Result {
  return editBlock(md, blockIndexOf(md, text), newBlockMd);
}

/**
 * 局部性判据：差集严格在被点名块内。
 *
 * 后缀用「从尾部倒着数同样长度」来比，因为块内一改，后面的字节整体平移了 ——
 * 直接按原 `to` 切会切错位。
 */
function assertLocalToBlock(r: Result): void {
  expect(r.out.slice(0, r.block.from)).toBe(r.md.slice(0, r.block.from));
  const tailLen = r.md.length - r.block.to;
  expect(r.out.slice(r.out.length - tailLen)).toBe(r.md.slice(r.block.to));
}

/** 点名块「只改了哪一格」的更强判据：块前后缀相同，中间只差一处 */
function assertBlockDiffWindow(r: Result): { changed: string; at: number } {
  const oldBlock = r.md.slice(r.block.from, r.block.to);
  const newBlock = r.out.slice(r.block.from, r.block.from + oldBlock.length);
  let prefix = 0;
  while (prefix < oldBlock.length && oldBlock[prefix] === newBlock[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldBlock.length - prefix &&
    oldBlock[oldBlock.length - 1 - suffix] === newBlock[newBlock.length - 1 - suffix]
  )
    suffix++;
  return { changed: oldBlock.slice(prefix, oldBlock.length - suffix), at: r.block.from + prefix };
}

describe("矩阵·恒等类（不需要该类型可编辑就成立，必须全绿）", () => {
  const md = fx("06-rule-html.md");

  it("分割线：编辑别处时 *** 原样保留（不是变成 --- 的规范化产物）", () => {
    const r = editBlockByText(md, "上面那段是块外参照。", "上面那段被改过。\n");
    assertLocalToBlock(r);
    // 逐字节找回来：`***` 是原文写法，remark 整篇序列化会把它规范成 `---`（103 已记的代价），
    // 按块替换必须把它原样带回来
    expect(r.out).toContain("\n***\n");
    expect(r.out).not.toContain("\n---\n");
  });

  it("裸 HTML 块：编辑别处时逐字节回来（M1 阅读模式是丢弃其内容的，这颗必须证明保存链路不丢）", () => {
    const r = editBlockByText(md, "再下面。", "再下面是被改过的。\n");
    assertLocalToBlock(r);
    expect(r.out).toContain('<div class="notice">这里有一段裸 HTML，里面写着「不能被丢」</div>');
    expect(r.out).toContain("\n<br>\n"); // 行内/块级两种裸 HTML 都不许丢
    expect(r.out).not.toContain("不能被丢</p>");
  });

  it("图片未被编辑：`![]()` 那一行一个字节都不动", () => {
    const img = fx("11-image-link.md");
    const r = editBlockByText(img, "另一段，块外参照。", "另一段被改过。\n");
    assertLocalToBlock(r);
    expect(r.out).toContain("![装置照片](assets/photo.png)");
  });

  /**
   * 136 的恒等行：**没编辑的脚注定义必须逐字节回来，含续行缩进与冒号后的空格数。**
   * 这一行是 Q27（她定「先不做跨块重排」）的另一半凭据 ——
   * 上一行证明"改了的那一块只动那一块"，这一行证明"没改的那一块连空格都没多"。
   */
  const FN_MD = [
    "# 脚注矩阵",
    "",
    "正文一句[^a]，另一句[^b]。",
    "",
    "段落二，块外参照。",
    "",
    "[^a]: 第一条定义",
    "  两格缩进的续行",
    "",
    "[^b]:   第二条定义，冒号后三个空格",
    "",
  ].join("\n");

  it("脚注定义未被编辑：标记、冒号后空格数、续行缩进全部逐字节回来（136）", () => {
    const r = editBlockByText(FN_MD, "段落二，块外参照。", "段落二被改过。\n");
    assertLocalToBlock(r);
    expect(r.patchCount).toBe(1);
    expect(r.out).toContain("[^a]: 第一条定义\n  两格缩进的续行");
    expect(r.out).toContain("[^b]:   第二条定义，冒号后三个空格");
    // 整篇重序列化会把两格改成四格（remark 的既定行为）—— 这条就是钉住我们没走那条路
    expect(r.out).not.toContain("\n    两格缩进的续行");
  });

  it("frontmatter：编辑正文时 YAML 头逐字节不动（含分隔线本身）", () => {
    const fm = fx("10-frontmatter-footnote.md");
    const r = editBlockByText(fm, "段落二，块外参照。", "段落二被改过。\n");
    assertLocalToBlock(r);
    expect(r.out.startsWith("---\ntitle: 审批时效周报\nauthor: xuange\nversion: v1.46\n---\n")).toBe(true);
    // 关键：YAML 没被拆成「分割线 + 段落 + 分割线」
    expect(r.out).not.toMatch(/title: 审批时效周报\n\nauthor:/);
  });

  it("脚注与 [TOC]：编辑别处时结构不变", () => {
    const fm = fx("10-frontmatter-footnote.md");
    const r = editBlockByText(fm, "这里有个引用脚注", "这里有个引用脚注[^a]，句子被改过。\n");
    assertLocalToBlock(r);
    expect(r.out).toContain("[^a]: 脚注内容，别动它。");
    expect(r.out).toContain("\n[TOC]\n");
  });

  it("列表未被编辑时保留原文写法（`1. 1. 1.` 不被重排成 `1. 2. 3.`，Q1 口径）", () => {
    const list = fx("03-list.md");
    const r = editBlockByText(list, "段落收尾。", "段落收尾被改过。\n");
    assertLocalToBlock(r);
    expect(r.out).toContain("1. 第一\n1. 第二\n1. 第三");
  });
});

describe("矩阵·实现类（各块类型的编辑工单交付）", () => {
  it("标题 h1~h6：改一个标题，其余标题行字节不变（106）", () => {
    const md = fx("01-heading.md");
    const r = editBlockByText(md, "## 二级标题乙", "## 二级标题乙改了\n");
    assertLocalToBlock(r);
    expect(r.out).toContain("# 一级标题甲");
    expect(r.out).toContain("### 三级标题丙");
    expect(r.patchCount).toBe(1);
  });

  it("段落 + 行内标记：改一个词，该行外字节不变（105, 106）", () => {
    const md = fx("02-paragraph-inline.md");
    // 真的只改一个词：「和一个」→「和两个」，别的一个字不动
    const r = editBlockByText(
      md,
      "这段里有",
      "这段里有 **粗体词**、*斜体词*、`行内代码` 和两个 [链接文字](https://example.com/a?b=1)。\n"
    );
    assertLocalToBlock(r);
    expect(r.patchCount).toBe(1);
    // 行内标记本身没被牵动：块内差集就是那一个字
    const w = assertBlockDiffWindow(r);
    expect(w.changed).toBe("一");
    expect(r.out).toContain("`行内代码`");
    expect(r.out).toContain("**粗体词**");
    expect(r.out).toContain("*斜体词*");
  });

  it("无序列表：改一项，块外不动；嵌套子项不丢（107）", () => {
    const md = fx("03-list.md");
    const r = editBlockByText(md, "- 乙项", "- 甲项\n- 乙项改了\n  - 乙的子项\n- 丙项\n");
    assertLocalToBlock(r);
    expect(r.out).toContain("  - 乙的子项"); // 嵌套缩进两格，不是变成同级
    expect(r.out).toContain("- 丙项");
  });

  it("有序列表：一旦被编辑，整块统一递增 `1. 2. 3.`（Q1 已定的既定代价）", () => {
    const md = fx("03-list.md");
    const r = editBlockByText(md, "1. 第一", "1. 第一改了\n2. 第二\n3. 第三\n");
    assertLocalToBlock(r);
    expect(r.out).toMatch(/1\. 第一改了\n2\. 第二\n3\. 第三/);
    // 代价只落在这一块里：未编辑的那份无序列表逐字节原样
    expect(r.out).toContain("- 甲项\n- 乙项\n  - 乙的子项\n- 丙项");
  });

  it("任务清单：勾选只改 `[ ]` → `[x]`，其余字节不动（107）", () => {
    const md = fx("04-task-list.md");
    const r = editBlockByText(md, "指标口径已对齐", "- [x] 指标口径已对齐\n- [ ] 慢单需要单独看板\n");
    assertLocalToBlock(r);
    // 块内只差**一个字符**（空格 → x），长度也没变 —— 「勾选只动三字符里的中间那个」在这里可验证
    const oldBlock = md.slice(r.block.from, r.block.to);
    const newBlock = r.out.slice(r.block.from, r.block.to);
    expect(newBlock.length).toBe(oldBlock.length);
    const diffs = [...oldBlock].map((c, i) => (c === newBlock[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diffs).toHaveLength(1);
    const at = diffs[0];
    expect(oldBlock[at]).toBe(" ");
    expect(newBlock[at]).toBe("x");
    expect(oldBlock.slice(at - 1, at + 2)).toBe("[ ]");
    expect(newBlock.slice(at - 1, at + 2)).toBe("[x]");
  });

  it("引用（含嵌套）：改一句，块外不动（108）", () => {
    const md = fx("05-quote.md");
    const r = editBlockByText(md, "第一句。", "> 第一句被改过。\n> 第二句。\n>\n> > 嵌套的一句。\n");
    assertLocalToBlock(r);
    expect(r.out).toContain("> > 嵌套的一句。"); // 嵌套引用没被压平
    expect(r.patchCount).toBe(1);
  });

  it("代码块：改一行，块外不动；围栏信息串（sql）不变（109）", () => {
    const md = fx("07-code.md");
    const r = editBlockByText(
      md,
      "SELECT matter_type",
      "```sql\nSELECT matter_type,\n       AVG(diff) AS avg_hours\nFROM approval_duration\nWHERE 1 = 1;\n```\n"
    );
    assertLocalToBlock(r);
    expect(r.out).toContain("```sql\nSELECT matter_type,");
    expect(r.out).toContain("WHERE 1 = 1;");
    // 另一块代码（math）没被牵动
    expect(r.out).toContain("```math\nx = y + 1\n```");
  });

  it("代码块围栏升级：内容里出现 ``` 时外层加长，语言信息串仍在（109）", () => {
    const md = fx("07-code.md");
    const r = editBlockByText(md, "SELECT matter_type", "```sql\nSELECT '```' AS fence;\n```\n");
    assertLocalToBlock(r);
    // 外层必须升成四个反引号，否则内容里那三个反引号会提前闭合围栏（内容就坏了）
    const blockText = r.out.slice(r.block.from, r.out.indexOf("SELECT '"));
    expect(blockText.startsWith("````sql")).toBe(true);
    expect(r.out).toContain("SELECT '```' AS fence;");
  });

  it("Mermaid：改一个节点名，块外不动（110）", () => {
    const md = fx("08-mermaid.md");
    const r = editBlockByText(
      md,
      "graph TD",
      "```mermaid\ngraph TD\n  开始 --> 复核\n  复核 --> 结束\n```\n"
    );
    assertLocalToBlock(r);
    expect(r.out).toContain("开始 --> 复核");
    expect(r.out).not.toContain("审批 --> 结束"); // 两处引用都改了，没有留下半截旧名
    expect(r.out).toContain("段落，块外参照。");
  });

  it("表格：改一格，块外不动；对齐标记与 <br> 都回来（111，代价是列宽被补齐）", () => {
    const md = fx("09-table.md");
    const r = editBlockByText(
      md,
      "采油作业区",
      "| 科室 | 受理量 | 说明 |\n| :--- | ---: | :---: |\n| 采油作业区 | 5,678 | 白天班<br>夜间班 |\n| 集输作业区 | 56 | 备注 |\n"
    );
    assertLocalToBlock(r);
    expect(r.out).toContain("5,678");
    // 对齐标记：左中右三种各一，改一格不许把它们抹平
    const sep = r.out.split("\n").find((l) => /^\|/.test(l) && /-/.test(l));
    expect(sep).toBeDefined();
    const cells = sep!.split("|").slice(1, -1).map((c) => c.trim());
    expect(cells.map((c) => [c.startsWith(":"), c.endsWith(":")])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(r.out).toContain("白天班<br>夜间班"); // Q2：单元格换行是 <br>，不是空格
    expect(r.out).toContain("段落，块外参照。");
  });

  it("脚注定义：改一条的正文，另一条定义与正文引用都不动（136，Q27「只动被编辑那一块」）", () => {
    const md = [
      "# 脚注矩阵",
      "",
      "正文一句[^a]，另一句[^b]。",
      "",
      "[^a]: 第一条定义",
      "  两格缩进的续行",
      "",
      "[^b]:   第二条定义，冒号后三个空格",
      "",
    ].join("\n");
    const r = editBlockByText(md, "[^a]: 第一条定义", "[^a]: 第一条定义改过了\n  续行也改过了\n");
    assertLocalToBlock(r);
    expect(r.patchCount).toBe(1);
    expect(r.out).toContain("[^a]: 第一条定义改过了\n  续行也改过了");
    // 另一条定义连"冒号后三个空格"这种细节都没被规整掉
    expect(r.out).toContain("[^b]:   第二条定义，冒号后三个空格");
    expect(r.out).toContain("正文一句[^a]，另一句[^b]。");
  });

  it("链接：改链接文字，URL 一个字节不变（106，本行按「链接可编辑」验收）", () => {
    const md = fx("11-image-link.md");
    const r = editBlockByText(
      md,
      "链接在",
      "链接在 [新链接文字](https://example.com/x?y=1) 里，URL 不该被牵动。\n"
    );
    assertLocalToBlock(r);
    expect(r.out).toContain("(https://example.com/x?y=1)"); // URL 原样
    expect(r.out).toContain("[新链接文字]");
    expect(r.out).not.toContain("[链接文字]");
  });

  it("全类型混排（仿 PRD 一整篇）：只改结论那一句，其余逐字节回来", () => {
    const md = fx("12-mixed-prd.md");
    const r = editBlockByText(
      md,
      "**结论段落要改的就是这一句。**",
      "**结论段落被改过了。**\n"
    );
    assertLocalToBlock(r);
    // 每一类内容都点一条：这一颗的意义是「一条命令跑完整张矩阵」
    expect(r.out).toContain("**指标口径**已对齐，*慢单*定义为超过 `P90` 的工单");
    expect(r.out).toContain("- 乙项\n  - 乙的子项");
    expect(r.out).toContain("1. 第一\n1. 第二");
    expect(r.out).toContain("- [ ] 慢单需要单独看板\n- [x] 已提交的清单不再变更");
    expect(r.out).toContain("> 受理量以工单系统导出为准。");
    expect(r.out).toContain("复核人：班组长按钮，不做二次确认。");
    expect(r.out).toContain("\n---\n");
    expect(r.out).toContain("FROM approval_duration\nGROUP BY matter_type;");
    expect(r.out).toContain("白天班<br>夜间班");
    expect(r.out).toContain("开始 --> 审批");
    expect(r.out).toContain("![现场照片](assets/site.png)");
    expect(r.out).toContain('<div class="notice">这里有一段裸 HTML，里面写着「不能被丢」</div>');
    expect(r.patchCount).toBe(1);
  });
});

describe("矩阵·夹具自检", () => {
  const names = [
    "01-heading.md",
    "02-paragraph-inline.md",
    "03-list.md",
    "04-task-list.md",
    "05-quote.md",
    "06-rule-html.md",
    "07-code.md",
    "08-mermaid.md",
    "09-table.md",
    "10-frontmatter-footnote.md",
    "11-image-link.md",
    "12-mixed-prd.md",
  ];

  it.each(names)("%s：每个顶层块都带源区间，且文档结构合法（109 的教训）", (name) => {
    const md = fx(name);
    const doc = mdastToDoc(md);
    doc.check(); // 非法结构在这里就抛，不留到某次 setNodeMarkup 才炸
    const blocks = topBlocks(md);
    const kids = kidsOf(doc);
    expect(kids.length).toBe(blocks.length);
    kids.forEach((n, i) => {
      expect(n.attrs.srcFrom).toBe(blocks[i].from);
      expect(n.attrs.srcTo).toBe(blocks[i].to);
    });
  });

  it("矩阵里唯一一行「本期不做」是图片 alt/src 编辑（Q5 已定），且它确实是不可编辑的原子", () => {
    const md = fx("11-image-link.md");
    const doc = mdastToDoc(md);
    let image: PMNode | null = null;
    doc.descendants((n) => {
      if (n.type.name === "image") image = n;
      return true;
    });
    expect(image, "夹具里的图片没解析出来").not.toBeNull();
    // 行内原子：没有可编辑的内容区，编辑模式点它只会选中，改不了 alt / 路径。
    // 这一条不是「通过」，是把 `N/A（本期不做）` 这行钉成可回归的事实 ——
    // 哪天有人给图片加了编辑入口，这里会红，逼他回来改矩阵那一行。
    expect(image!.isAtom || image!.type.spec.atom === true).toBe(true);
    expect(image!.isInline).toBe(true);
    expect(image!.content.size).toBe(0);
  });
});
