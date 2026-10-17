import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mdToHtml, parseMd } from "../../src/kernel/md";
import { roundTrip } from "../../src/kernel/roundtrip";

/**
 * 004 的验收点单独成文：对齐标记、转义竖线、frontmatter。
 * 这些不能只靠 `.roundtrip.md` 钉住（钉的是「当前行为」），
 * 这里断言的是「语义正确」——将来换成按块替换后这两组都必须仍然成立。
 */

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

describe("表格", () => {
  const md = fx("09-table-edge.md");
  const out = roundTrip(md);

  it("三种对齐标记解析出来", () => {
    const table = parseMd(md).children.find((c) => c.type === "table") as
      | { align?: Array<"left" | "center" | "right" | null> }
      | undefined;
    expect(table, "第一张表没解析成 table 节点").toBeTruthy();
    expect(table!.align).toEqual(["left", "center", "right"]);
  });

  it("对齐标记回写后仍是同一种对齐", () => {
    // 逐张表比对「解析出的 align」而不是比对字符，避免被列宽补齐干扰
    const srcAlign = alignsOf(md);
    const outAlign = alignsOf(out);
    expect(outAlign).toEqual(srcAlign);
    expect(srcAlign.length).toBeGreaterThanOrEqual(3);
  });

  it("单元格内的转义竖线不丢", () => {
    expect(out).toContain("含竖线 \\| 转义");
    expect(out).toContain("`a\\|b`");
    // 转义没有变成真竖线（真竖线会多切出一列）
    const rows = parseMd(out).children.filter((c) => c.type === "table") as Array<{
      children: Array<{ children: unknown[] }>;
    }>;
    expect(rows[0].children[1].children).toHaveLength(3);
  });

  it("渲染出 align 属性，且 <br> 这类裸 HTML 只丢标签不丢文字", () => {
    const html = mdToHtml(md);
    expect(html).toContain('align="center"');
    expect(html).toContain('align="right"');
    expect(html).not.toContain("<br>");
    expect(html).toContain("第一行");
    expect(html).toContain("第二行");
  });
});

function alignsOf(md: string): Array<Array<"left" | "center" | "right" | null>> {
  return parseMd(md)
    .children.filter((c) => c.type === "table")
    .map((t) => (t as { align?: Array<"left" | "center" | "right" | null> }).align ?? []);
}

describe("frontmatter", () => {
  const md = fx("10-frontmatter.md");

  it("往返逐字节一致（YAML 不被拆成分隔线 + 段落）", () => {
    expect(roundTrip(md)).toBe(md);
  });

  it("本期不渲染：YAML 内容不出现在 HTML 里，正文照常", () => {
    const html = mdToHtml(md);
    expect(html).not.toContain("xuange");
    expect(html).not.toContain("v1.46");
    expect(html).toContain("<h1>");
    expect(html).toContain("正文正常渲染");
  });
});

describe("再次解析稳定", () => {
  const names = [
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

  it.each(names)("%s 二次往返不再变化", (name) => {
    const once = roundTrip(fx(name));
    expect(roundTrip(once)).toBe(once);
  });
});
