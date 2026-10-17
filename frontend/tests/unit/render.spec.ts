import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mdToHtml } from "../../src/kernel/md";

function fixture(name: string): string {
  const p = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  expect(existsSync(p), `夹具缺失: ${name}`).toBe(true);
  return readFileSync(p, "utf8");
}

/**
 * 阅读模式渲染的最低保证：结构在、内容不丢。
 * 视觉与排版的验收走 Playwright 截图，不在这里做。
 */
describe("mdToHtml", () => {
  it("标题渲染成 h1-h6 且文字保留", () => {
    const html = mdToHtml(fixture("01-heading.md"));
    expect(html).toContain("<h1>");
    expect(html).toContain("<h6>");
    expect(html).toContain("一级标题");
  });

  it("段落与行内标记渲染成 p/strong/em/code/a", () => {
    const html = mdToHtml(fixture("02-inline.md"));
    for (const tag of ["<p>", "<strong>", "<em>", "<code>", "<a", "<del>", "<hr"]) {
      expect(html, `缺少 ${tag}`).toContain(tag);
    }
  });

  it("列表：有序、无序、任务清单带 checkbox", () => {
    const html = mdToHtml(fixture("03-list.md"));
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain('type="checkbox"');
  });

  it("表格：thead/tbody 与对齐样式在", () => {
    const html = mdToHtml(fixture("04-table.md"));
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain('align="center"');
    expect(html).toContain("12,345.67");
  });

  it("代码块整段转义，不被当作 Markdown 解析", () => {
    const html = mdToHtml(fixture("05-code.md"));
    expect(html).toContain("<pre>");
    expect(html).toContain("package main");
    expect(html).toContain("$env:GOPROXY");
    // 代码块内部的 `code` 不应变成 <code>
    expect(html).not.toContain("<code>code</code>");
  });

  it("mermaid 保留为带语言类的 code 元素（004 才升级为图）", () => {
    const html = mdToHtml(fixture("06-mermaid.md"));
    expect(html).toContain("language-mermaid");
    expect(html).toContain("sequenceDiagram");
  });

  it("裸 HTML 被丢弃但文字保留，避免渲染外来文档时被注入", () => {
    const html = mdToHtml(fixture("07-block.md"));
    // mdast-util-to-hast 在 allowDangerousHtml=false 时是「丢掉 raw 节点」，
    // 不是转义：标签消失、里面的文字仍在。
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("</b>");
    expect(html).toContain("行内 HTML");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<img");
  });

  it("混合 PRD 样本：标题、表、图、码、列表全在", () => {
    const html = mdToHtml(fixture("08-mixed-prd.md"));
    for (const probe of ["<h1>", "<table>", "language-mermaid", "language-sql", "<li>", "<blockquote>"]) {
      expect(html, `缺少 ${probe}`).toContain(probe);
    }
  });
});
