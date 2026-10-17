import { describe, expect, it } from "vitest";
import { mdToHtml } from "../../src/kernel/md";

/**
 * US-09 内容类型覆盖矩阵：一类元素一条，断言的是**结构**而不是像素。
 *
 * 不用图片快照做断言：字体渲染、DPI、Edge 版本都会让位图像素漂移，
 * 那种基线只会变成噪音来源。视觉验收走 docs/测试与验收.md 的截图环节。
 */

describe("阅读模式内容类型", () => {
  const cases: Array<[string, string, (html: string) => void]> = [
    [
      "1 标题层级 h1-h6",
      "# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f",
      (h) => {
        for (const t of ["h1", "h2", "h3", "h4", "h5", "h6"]) expect(h).toContain(`<${t}>`);
      },
    ],
    [
      "2 段落与硬换行",
      // CommonMark 的硬换行要行尾两个空格或行尾反斜杠；这里用反斜杠写法，
      // 免得源码里的行尾空格被编辑器/格式化工具悄悄吃掉
      "第一行\\\n第二行\n\n下一段",
      (h) => {
        expect(h).toContain("<br>");
        expect(h.match(/<p>/g)).toHaveLength(2);
      },
    ],
    [
      "3 无序列表",
      "- 一\n- 二",
      (h) => {
        expect(h).toContain("<ul>");
        expect(h.match(/<li>/g)).toHaveLength(2);
      },
    ],
    [
      "4 有序列表（含起始编号）",
      "3. 三\n4. 四",
      (h) => {
        expect(h).toContain("<ol");
        expect(h).toContain('start="3"');
      },
    ],
    [
      "5 嵌套列表",
      "- 一\n  - 子一\n  - 子二\n- 二",
      (h) => {
        expect((h.match(/<ul>/g) || []).length).toBe(2);
        // hast 的 pretty 输出会在块级子元素前换行，用 \s* 容忍
        expect(h).toMatch(/<li>一\s*<ul>/);
      },
    ],
    [
      "6 任务清单",
      "- [x] done\n- [ ] todo",
      (h) => {
        expect(h).toContain('type="checkbox"');
        expect(h).toContain("checked");
        expect(h).toContain("task-list-item");
      },
    ],
    [
      "7 引用块（含嵌套）",
      "> 外层\n>\n> > 内层",
      (h) => {
        expect(h.match(/<blockquote>/g)).toHaveLength(2);
      },
    ],
    [
      "8 分割线",
      "上\n\n---\n\n下",
      (h) => {
        expect(h).toContain("<hr>");
      },
    ],
    [
      "9 删除线",
      "~~去掉~~保留",
      (h) => {
        expect(h).toContain("<del>去掉</del>");
      },
    ],
    [
      "10 行内代码（含反斜杠转义）",
      "写 `a\\`b` 这样",
      (h) => {
        expect(h).toContain("<code>");
      },
    ],
    [
      "11 链接（标题属性与自动链接）",
      "[文字](https://example.com '标题') 与 <https://auto.example>",
      (h) => {
        expect(h).toContain('href="https://example.com"');
        expect(h).toContain('title="标题"');
        expect(h).toContain('href="https://auto.example"');
      },
    ],
    [
      "12 图片（alt 与标题）",
      "![替代文字](./a.png '图注')",
      (h) => {
        expect(h).toContain('src="./a.png"');
        expect(h).toContain('alt="替代文字"');
        expect(h).toContain('title="图注"');
      },
    ],
    [
      "13 表格（三种对齐 + 空单元格）",
      "| L | C | R |\n| :-- | :-: | --: |\n| a |  | c |",
      (h) => {
        expect(h).toContain("<table>");
        expect(h).toContain('align="center"');
        expect(h).toContain('align="right"');
        // 空单元格：属性与换行位置不假设，只要求存在一个无内容的 td
        expect(h).toMatch(/<td[^>]*>\s*<\/td>/);
      },
    ],
    [
      "14 代码块（语言类 + 内容转义）",
      "```ts\nconst a = 1 < 2;\n```",
      (h) => {
        expect(h).toContain('class="language-ts"');
        expect(h).toContain("1 &lt; 2");
      },
    ],
    [
      "15 Mermaid 围栏（先作为代码元素，增强在 hydrate）",
      "```mermaid\nflowchart LR\n  A-->B\n```",
      (h) => {
        expect(h).toContain('class="language-mermaid"');
        expect(h).toContain("flowchart LR");
      },
    ],
  ];

  it.each(cases)("%s", (_name, md, assert) => {
    assert(mdToHtml(md));
  });
});
