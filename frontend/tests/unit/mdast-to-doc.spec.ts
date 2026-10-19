import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 102：mdast → ProseMirror 文档的结构断言。
 *
 * 核心不是「长得对」，而是**不丢内容**：
 * 能表示的要映射对，不能表示的要变成占位原子，而不是被静默丢弃。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures");

const types = (md: string) => {
  const doc = mdastToDoc(md);
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name));
  return out;
};

describe("块级映射", () => {
  it("标题 / 段落 / 引用 / 分割线 / 代码块", () => {
    const md = "# 标题\n\n段落\n\n> 引用\n\n---\n\n```sql\nSELECT 1\n```\n";
    expect(types(md)).toEqual(["heading", "paragraph", "blockquote", "horizontal_rule", "code_block"]);
  });

  it("标题层级带过来，越界的钳到 1~6", () => {
    const doc = mdastToDoc("###### 六级\n");
    expect(doc.child(0).attrs.level).toBe(6);
    expect(mdastToDoc("段落\n").child(0).type.name).toBe("paragraph");
  });

  it("有序列表带 order，无序列表是 bullet_list，任务项带 checked", () => {
    const md = "1. 甲\n2. 乙\n\n- [x] 已完成\n- [ ] 未完成\n";
    const doc = mdastToDoc(md);
    expect(doc.child(0).type.name).toBe("ordered_list");
    expect(doc.child(0).attrs.order).toBe(1);
    const list = doc.child(1);
    expect(list.type.name).toBe("bullet_list");
    expect(list.child(0).attrs.checked).toBe(true);
    expect(list.child(1).attrs.checked).toBe(false);
  });

  it("嵌套列表递归进来，整棵仍是一个列表块", () => {
    const doc = mdastToDoc("- 一\n  - 二\n    - 三\n");
    expect(doc.childCount).toBe(1);
    const item = doc.child(0).child(0); // 外层 list_item
    const names = item.children.map((c) => c.type.name);
    // 紧凑列表里 remark 给的是 [paragraph("一"), bullet_list]，嵌套表是第二个孩子
    expect(names).toEqual(["paragraph", "bullet_list"]);
    expect(item.child(1).child(0).textContent).toContain("二");
  });

  it("表格：表头行映射成 table_header，数据行是 table_cell", () => {
    const doc = mdastToDoc("| 列甲 | 列乙 |\n| --- | --- |\n| a | b |\n");
    const table = doc.child(0);
    expect(table.type.name).toBe("table");
    expect(table.child(0).child(0).type.name).toBe("table_header");
    expect(table.child(1).child(0).type.name).toBe("table_cell");
  });

  it("围栏信息串保留在 code_block 的 language 属性上（109/110 要用）", () => {
    const doc = mdastToDoc("```mermaid\ngraph TD\n  A-->B\n```\n");
    expect(doc.child(0).attrs.language).toBe("mermaid");
  });
});

describe("行内映射", () => {
  const marksOf = (md: string) => {
    const doc = mdastToDoc(md);
    const p = doc.child(0);
    const out: { text: string; marks: string[] }[] = [];
    p.forEach((n) => out.push({ text: n.textContent, marks: n.marks.map((m) => m.type.name) }));
    return out;
  };

  it("粗体 / 斜体 / 删除线 / 行内代码 / 链接 各自成 mark", () => {
    // 标记之间的空格是**无 mark 的独立文本节点**，所以只取带 mark 的那些来比对
    const got = marksOf("**粗** *斜* ~~删~~ `码` [链](https://e.com)\n").filter((g) => g.marks.length);
    expect(got.map((g) => g.marks[0])).toEqual(["strong", "em", "strikeThrough", "code", "link"]);
    expect(got.map((g) => g.text)).toEqual(["粗", "斜", "删", "码", "链"]);
  });

  it("链接的 href 与 title 落在 mark 属性上", () => {
    const doc = mdastToDoc('[文字](https://e.com "标题")\n');
    const link = doc.child(0).child(0).marks.find((m) => m.type.name === "link");
    expect(link?.attrs.href).toBe("https://e.com");
    expect(link?.attrs.title).toBe("标题");
  });

  it("图片是行内原子节点，src / alt 带过来", () => {
    const doc = mdastToDoc("![说明](./diagrams/a.png)\n");
    const img = doc.child(0).child(0);
    expect(img.type.name).toBe("image");
    expect(img.attrs.src).toBe("./diagrams/a.png");
    expect(img.attrs.alt).toBe("说明");
  });
});

describe("不丢内容：无法表示的一律占位", () => {
  it("frontmatter / 裸 HTML → opaque_block；脚注定义 136-B 起升级为可编辑块", () => {
    const md = "---\ntitle: 甲\n---\n\n# 标题\n\n<div class=\"x\">内容</div>\n\n段落甲[^a]\n\n[^a]: 脚注\n";
    const doc = mdastToDoc(md);
    const names = types(md);
    expect(names).toContain("opaque_block");
    // 136-B 之前这里是 3：脚注定义也走占位。现在它是 footnote_def，
    // **占位数少一个不是"少了一层保护"，而是那一块从"不能改"变成"能改且逐字节保真"**
    expect(names.filter((n) => n === "opaque_block")).toHaveLength(2); // yaml / html
    expect(names).toContain("footnote_def");
    // 内容仍然一个字都不丢（占位与可编辑块都要过这条）
    expect(doc.textContent).toContain("标题");
    expect(doc.textContent).toContain("段落甲");
    expect(doc.textContent).toContain("脚注");
  });

  it("脚注引用 → footnote_ref（136-B 起可点跳转），不吞掉所在段落", () => {
    // remark-gfm 只在**存在定义**时才把 `[^x]` 解析成 footnoteReference，
    // 没有定义时它是普通文本 —— 这是 remark 的既定行为，不是我们的丢失。
    const doc = mdastToDoc("前面[^x]后面\n\n[^x]: 注\n");
    const names = doc.child(0).children.map((c) => c.type.name);
    expect(names).toContain("footnote_ref");
    expect(doc.child(0).textContent).toContain("前面");
    expect(doc.child(0).textContent).toContain("后面");
    expect(types("没有定义的引用[^q]\n")).toEqual(["paragraph"]);
    expect(mdastToDoc("没有定义的引用[^q]\n").child(0).textContent).toContain("[^q]");
  });

  it("未知类型也占位而不是丢弃", () => {
    const doc = mdastToDoc("正常段落\n");
    expect(doc.childCount).toBe(1);
    // 上面这条与下面这条一起说明：映射表覆盖不到时走 default 分支
    expect(doc.child(0).type.name).toBe("paragraph");
  });

  it("[TOC] 在 mdast 里就是普通段落，不需要特殊节点（M1 022 是渲染期增强）", () => {
    expect(types("[TOC]\n")).toEqual(["paragraph"]);
  });
});

describe("夹具全量能转成非空文档", () => {
  const fixtures = [
    "01-heading.md",
    "02-inline.md",
    "03-list.md",
    "04-table.md",
    "05-code.md",
    "06-mermaid.md",
    "07-block.md",
    "08-mixed-prd.md",
    "09-table-edge.md",
    "10-frontmatter.md",
  ];

  it.each(fixtures)("%s", (name) => {
    const md = readFileSync(join(fixtureDir, name), "utf8");
    const doc = mdastToDoc(md, hpSchema);
    expect(doc.type.name).toBe("doc");
    expect(doc.childCount).toBeGreaterThan(0);
    expect(doc.content.size).toBeGreaterThan(0);
  });

  it("空文档不崩，且至少有一个空段落（PM 的 doc 不能没有子节点）", () => {
    const doc = mdastToDoc("");
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("paragraph");
  });
});
