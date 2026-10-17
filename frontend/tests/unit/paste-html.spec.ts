import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fragment } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { serializeMd, parseMd } from "../../src/kernel/md";
import { htmlToMdast } from "../../src/kernel/paste/htmlToMdast";
import { mdastRootToNodes, mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 114：富文本粘贴 → Markdown 的纯函数夹具（US-35）。
 *
 * 约定同 `roundtrip.spec.ts`：往 `tests/fixtures/paste/` 放一个 `.html`，
 * 配一个同名 `.md` 钉住期望结果，**加用例不用改代码**。
 * 期望值是「先看一眼再生成」的，不是盲钉：`pnpm` 里没有自动重写脚本，
 * 要改口径就手工编辑那个 `.md`，让 diff 说话。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "paste");

const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".html"))
  .sort()
  .map((f) => ({
    name: f,
    html: readFileSync(join(fixtureDir, f), "utf8"),
    mdPath: join(fixtureDir, f.replace(/\.html$/, ".md")),
  }));

/**
 * 去掉 `position` 与 `spread` 后比较结构。
 *
 * `spread` 是 remark 从**源码空行**推出来的「松散列表」排版标记，不是内容：
 * 粘贴产物没有源码，序列化时是否留空行由序列化器决定，比它只会产出无意义的红。
 * 内容、类型、嵌套关系才是这条断言要守的东西。
 */
const strip = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(strip);
  if (n && typeof n === "object") {
    const o: Record<string, unknown> = {};
    // 键排序：mdast 不规定属性顺序，`{url,title}` 与 `{title,url}` 是同一个节点，
    // 不按序比就会假红（第一次跑就被这条骗过一次）
    for (const k of Object.keys(n as object).sort()) {
      if (k === "position" || k === "spread") continue;
      o[k] = strip((n as Record<string, unknown>)[k]);
    }
    return o;
  }
  return n;
};

describe("paste 夹具", () => {
  it("至少 6 份夹具（少于此说明有人误删）", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
  });

  describe.each(fixtures)("转换 %s", (fx) => {
    it("结果与钉住的 .md 一致", () => {
      expect(existsSync(fx.mdPath), "缺少期望文件 " + fx.mdPath).toBe(true);
      const expected = readFileSync(fx.mdPath, "utf8");
      expect(serializeMd(htmlToMdast(fx.html) as never)).toBe(expected);
    });

    it("产物是合法 mdast（根层全是流内容、无 position）", () => {
      const root = htmlToMdast(fx.html);
      for (const child of root.children) {
        expect(child.type).not.toBe("text");
        expect(child.type).not.toBe("strong");
        expect(child.type).not.toBe("emphasis");
        expect(child.position).toBeUndefined();
      }
    });

    it("再解析一次结构不变（Markdown 没有被二次解释）", () => {
      const root = htmlToMdast(fx.html);
      const text = serializeMd(root as never);
      expect(strip(parseMd(text))).toEqual(strip(root));
    });
  });
});

describe("该丢的绝不进结果", () => {
  const all = fixtures.map((f) => serializeMd(htmlToMdast(f.html) as never)).join("\n");

  it("样式与排版属性全清（style/class/mso/字体/颜色/宽高）", () => {
    for (const needle of ["style", "class=", "mso-", "MsoNormal", "font-family", "FONT-SIZE", "color:", "width=", "height=", "valign"]) {
      expect(all, "结果里出现了 " + needle).not.toContain(needle);
    }
  });

  it("Word 私有标签与条件注释不进结果", () => {
    for (const needle of ["<o:", "<w:", "<xml", "StartFragment", "EndFragment", "﻿"]) {
      expect(all, "结果里出现了 " + needle).not.toContain(needle);
    }
  });

  it("脚本/样式表整棵子树丢掉", () => {
    const out = serializeMd(
      htmlToMdast("<p>正文</p><script>alert(1)</script><style>p{color:red}</style><iframe src=\"https://evil.test\"></iframe>") as never
    );
    expect(out.trim()).toBe("正文");
  });
});

describe("该留的一个不少（验收第一条）", () => {
  const out = serializeMd(
    htmlToMdast(
      "<h1>一</h1><h4>四</h4><h6>六</h6>" +
        "<ul><li>a<ol><li>b<ol><li>c</li></ol></li></ol></li></ul>" +
        "<table><thead><tr><th>甲</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>" +
        '<p><a href="https://a.test">链</a> <strong>粗</strong> <em>斜</em> <del>删</del> <code>码</code></p>'
    ) as never
  );

  it("h1~h6、嵌套列表、表格、链接、四种行内标记", () => {
    expect(out).toContain("# 一");
    expect(out).toContain("#### 四");
    expect(out).toContain("###### 六");
    expect(out).toContain("- a\n  1. b");
    expect(out).toContain("| 甲 |");
    expect(out).toContain("[链](https://a.test)");
    expect(out).toContain("**粗**");
    expect(out).toContain("*斜*");
    expect(out).toContain("~~删~~");
    expect(out).toContain("`码`");
  });

  it("有序列表的起始序号保留（3. 不会被改回 1.）", () => {
    const s = serializeMd(htmlToMdast('<ol start="3"><li>三</li><li>四</li></ol>') as never);
    expect(s).toMatch(/^3\. 三/);
  });
});

describe("特殊字符转义", () => {
  it("Markdown 特殊字符原样是文字，不会变成格式", () => {
    const root = htmlToMdast("<p>2 * 3 = 6 与 _x_ 与 #1 与 a | b 与 `y`</p>");
    const text = serializeMd(root as never);
    // 再解析回来必须还是**一个**段落、纯文字，没有 em/strong/heading/code
    const again = parseMd(text);
    expect(again.children).toHaveLength(1);
    const inline = (again.children[0] as unknown as { children: { type: string }[] }).children;
    expect(inline.map((x) => x.type)).toEqual(["text"]);
    expect((inline[0] as unknown as { value: string }).value).toBe("2 * 3 = 6 与 _x_ 与 #1 与 a | b 与 `y`");
  });
});

describe("粘贴产物进 PM（103 的例外分支：无源区间新块）", () => {
  const html =
    "<h2>来的标题</h2><p>来的段落 <strong>粗</strong></p><ul><li>来的一</li><li>来的二</li></ul>" +
    "<table><tr><th>甲</th></tr><tr><td>1</td></tr></table>";
  const nodes = mdastRootToNodes(htmlToMdast(html).children);

  it("块类型正确", () => {
    expect(nodes.map((n) => n.type.name)).toEqual(["heading", "paragraph", "bullet_list", "table"]);
  });

  it("srcFrom/srcTo 全是 null（不是别处文本的坐标）", () => {
    for (const n of nodes) {
      expect(n.attrs.srcFrom ?? null, n.type.name + " 带了 srcFrom").toBeNull();
      expect(n.attrs.srcTo ?? null, n.type.name + " 带了 srcTo").toBeNull();
    }
  });

  it("拼到现有文档后面，doc.check() 通过（表格单元格不能是段落，111 的约定）", () => {
    const doc = mdastToDoc("# 原\n\n原文落。\n");
    const kids = [...nodes];
    doc.forEach((child) => kids.unshift(child));
    const merged = hpSchema.nodes.doc.create(null, Fragment.from(kids));
    expect(merged.check()).toBeUndefined();
  });

  it("单元格里的 <p> 被降级成行内内容（否则 PM 里形状不对）", () => {
    const withP = mdastRootToNodes(
      htmlToMdast("<table><tr><th>表头</th></tr><tr><td><p>甲</p><p>乙</p></td></tr></table>").children
    );
    const cell = withP[0].child(1).child(0);
    expect(cell.type.name).toBe("table_cell");
    expect(cell.child(0).type.name).toBe("paragraph");
    // 一个段落里装着「甲 <br> 乙」，不是两个段落
    expect(cell.childCount).toBe(1);
    expect(cell.textContent).toBe("甲乙");
  });
});
