import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 114：富文本粘贴（US-35）。
 *
 * 转换本身由 `tests/unit/paste-html.spec.ts` 的夹具全覆盖（纯函数接缝）。
 * 这里只验**接线**：注入的 ClipboardEvent 真的走了同一条生产路径、
 * 结果进了文档、能继续编辑、能保存，以及块外逐字节不变。
 *
 * 注入契约（工单里定的，115/116 共用）：`window.__hpMockPaste({ html?, text?, files? })`
 * 构造真 `ClipboardEvent` 派发到编辑器；生产代码只从 `event.clipboardData` 取数据。
 * 真实 Ctrl+V（微信截图、Excel 复制）留在桌面手工清单，不在这里冒充自动化。
 */

const DOC = "# 标题\n\n正文段落。\n\n末段不动。\n";

/** 每条用例一份独立路径，避免上一条的会话恢复把这一条的起点改掉（见 115 同一处理由） */
let path = "";

async function seedAndOpen(page: Page) {
  path = "/demo/粘贴-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

/** 把光标放到「正文段落。」末尾，注入粘贴，保存，返回落盘文本 */
async function pasteAtBody(page: Page, payload: { html?: string; text?: string }): Promise<string> {
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await page.evaluate((p) => (window as unknown as { __hpMockPaste: (x: unknown) => void }).__hpMockPaste(p), payload);
  await page.keyboard.press("Control+s");
  return savedOf(page);
}

test("粘贴网页富文本：结构进文档、落盘是 Markdown、块外逐字节不变", async ({ page }) => {
  await seedAndOpen(page);
  const saved = await pasteAtBody(page, {
    html:
      '<h2 class="t" style="color:red">小节标题</h2>' +
      "<p>带 <strong>粗</strong> 与 <a href=\"https://a.test\">链</a> 的段落</p>" +
      "<ul><li>甲</li><li>乙</li></ul>",
  });

  expect(saved).toContain("## 小节标题");
  expect(saved).toContain("带 **粗** 与 [链](https://a.test) 的段落");
  expect(saved).toMatch(/^- 甲$/m);
  expect(saved).toMatch(/^- 乙$/m);
  // 样式与 class 绝不进结果
  expect(saved).not.toContain("style");
  expect(saved).not.toContain("class");
  // 块外：标题行与末段原样
  expect(saved.startsWith("# 标题\n\n")).toBe(true);
  expect(saved).toContain("末段不动。\n");
  // 被粘贴的那一段本身也没被吃掉：它仍在，只是后面多了内容
  expect(saved).toContain("正文段落。");
});

test("纯文本粘贴不触发转换（按当前块类型插入）", async ({ page }) => {
  await seedAndOpen(page);
  const saved = await pasteAtBody(page, { text: "字面 # 井号 与 <b>标签</b> 与 *星号*" });

  // 关键：没有变成标题/加粗，而是作为文字进了当前段落
  expect(saved).toContain("字面 # 井号");
  // 标题行仍然只有原文那一个（粘贴的 "# " 没被当成块前缀）
  expect(saved.split("\n").filter((l) => /^#{1,6}\s/.test(l))).toEqual(["# 标题"]);
  // 尖括号按 Markdown 规则转义后仍是这些字
  expect(saved).toContain("<b>");
});

test("粘贴后立刻可以继续编辑（不需要二次确认）", async ({ page }) => {
  await seedAndOpen(page);
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await page.evaluate(() =>
    (window as unknown as { __hpMockPaste: (x: unknown) => void }).__hpMockPaste({
      html: "<h3>粘进来的三级标题</h3><ul><li>项一</li></ul>",
    })
  );
  // 粘贴后光标应落在最后一个粘进来的块里，直接打字就该进那一处
  await page.keyboard.type("接着写");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("### 粘进来的三级标题");
  expect(saved).toContain("- 项一");
  // 打字真的进了文档（不是弹了确认框、也没变成只读）
  expect(saved).toContain("接着写");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // 光标就停在粘进来的内容后面：「接着写」出现在列表项之后
  expect(saved.indexOf("接着写")).toBeGreaterThan(saved.indexOf("- 项一"));
});

test("粘贴 Word 表格：结果是合法 GFM 表格，列数一致", async ({ page }) => {
  await seedAndOpen(page);
  const saved = await pasteAtBody(page, {
    html:
      '<table class=MsoTable style="border-collapse:collapse"><tr>' +
      '<td width=131 style="padding:0cm 5.4pt"><p class=MsoNormal>项目</p></td>' +
      "<td><p class=MsoNormal>内容</p></td></tr><tr>" +
      "<td><p class=MsoNormal>提交日期</p></td><td><p class=MsoNormal>2026-10-08</p></td></tr></table>",
  });

  const rows = saved.split("\n").filter((l) => l.trim().startsWith("|"));
  expect(rows).toHaveLength(3); // 表头 + 分隔 + 一行数据
  const cells = (l: string) => l.split("|").map((c) => c.trim()).filter(Boolean);
  for (const r of rows) expect(cells(r)).toHaveLength(2);
  expect(rows[0]).toContain("项目");
  expect(rows[2]).toContain("2026-10-08");
  // Word 的东西一个都不留
  expect(saved).not.toMatch(/Mso|mso-|width=|padding/);
});

test("粘贴的代码围栏带语言，重开渲染正常", async ({ page }) => {
  await seedAndOpen(page);
  const saved = await pasteAtBody(page, {
    html: '<pre><code class="language-python">print("hi")</code></pre>',
  });
  expect(saved).toContain("```python\nprint(\"hi\")\n```");

  await setMode(page, "read");
  await expect(page.locator(".hp-doc .hp-code__lang")).toHaveCount(1);
  await expect(page.locator(".hp-doc pre code").last()).toContainText("print");
});

test("粘贴内容里的 Markdown 特殊字符不会被二次解析", async ({ page }) => {
  await seedAndOpen(page);
  const saved = await pasteAtBody(page, { html: "<p>2 * 3 = 6 与 _x_ 与 `y`</p>" });
  const line = saved.split("\n").find((l) => l.includes("2 "))!;
  // 转义后仍是**一行普通段落**，没有新列表/斜体块
  expect(line).toContain("\\*");
  expect(saved.split("\n").filter((l) => /^\s*[-*]\s/.test(l))).toHaveLength(0);

  await setMode(page, "read");
  await expect(page.locator(".hp-doc em")).toHaveCount(0);
  await expect(page.getByTestId("document-root")).toContainText("2 * 3 = 6 与 _x_ 与 `y`");
});
