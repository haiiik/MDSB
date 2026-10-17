import { expect, test, type Page } from "@playwright/test";
import { gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 113：编辑模式工具栏（US-38 后半的 UI 部分）。
 *
 * 命令语义在 `tests/unit/toolbar.spec.ts` 里逐条钉过了，这里只管三件事：
 * ① 按钮真的能点到、点完落盘对；② 高亮/置灰跟着光标走；
 * ③ 工具栏**只在所见即所得模式出现**（验收标准最后一条）。
 */

const PATH = "/demo/工具栏.md";

const DOC = "# 标题\n\n第一段正文。\n\n第二段正文。\n\n```sql\nSELECT 1;\n```\n\n末段不动。\n";

async function seedAndOpen(page: Page, doc = DOC) {
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, doc]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );

/** 把光标放进第 n 个段落（0 基，只数 p）——同步放定，不用 click：
 *  点击的选区事务与随后的按钮点击之间没有同步点，负载高时按钮会作用在旧光标上 */
async function clickParagraph(page: Page, n: number) {
  await placeCaret(page, ".ProseMirror p", 0, n);
}

/** 选中第 n 个段落的**全部文字**（不用 Ctrl+A：那是全文档） */
async function selectParagraphText(page: Page, n: number) {
  await page.evaluate((idx) => {
    const el = document.querySelectorAll<HTMLElement>(".ProseMirror p")[idx];
    if (!el) throw new Error("没有第 " + idx + " 个段落");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, n);
}

test("工具栏只在所见即所得模式出现", async ({ page }) => {
  await seedAndOpen(page);
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();

  await setMode(page, "read");
  await expect(page.getByTestId("edit-toolbar")).toHaveCount(0);

  await setMode(page, "source");
  await expect(page.getByTestId("edit-toolbar")).toHaveCount(0);

  await setMode(page, "edit");
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();
});

test("点 H2 变二级标题，再点 H2 回正文", async ({ page }) => {
  await seedAndOpen(page);
  await clickParagraph(page, 0); // 第一段正文
  await page.getByTestId("tb-h2").click();
  await expect(page.locator(".ProseMirror h2")).toHaveCount(1);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("## 第一段正文");

  await page.getByTestId("tb-h2").click();
  await expect(page.locator(".ProseMirror h2")).toHaveCount(0);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("第一段正文");
});

test("点引用再点一次：套上又提出，不会叠成两层", async ({ page }) => {
  await seedAndOpen(page);
  await clickParagraph(page, 1); // 第二段正文
  await page.getByTestId("tb-quote").click();
  await expect(page.locator(".ProseMirror blockquote")).toHaveCount(1);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("> 第二段正文");

  await page.getByTestId("tb-quote").click();
  await expect(page.locator(".ProseMirror blockquote")).toHaveCount(0);
});

test("点无序 / 任务：列表与复选框都落到源码里", async ({ page }) => {
  await seedAndOpen(page);
  await clickParagraph(page, 0);
  await page.getByTestId("tb-bullet").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toMatch(/^- 第一段正文。$/m);

  await page.getByTestId("tb-task").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toMatch(/^- \[ ] 第一段正文。$/m);
});

test("选中文字点「粗」加粗，再点取消", async ({ page }) => {
  await seedAndOpen(page);
  await selectParagraphText(page, 0);
  await page.getByTestId("tb-bold").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("**第一段正文。**");

  await selectParagraphText(page, 0);
  await page.getByTestId("tb-bold").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("第一段正文");
  expect(await savedOf(page)).not.toContain("**第一段正文。**");
});

test("Ctrl+B 与工具栏按钮同源（提示写的是快捷键，就得真能用）", async ({ page }) => {
  await seedAndOpen(page);
  await selectParagraphText(page, 0);
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("**第一段正文。**");
});

test("链接：选中 → 填 URL → 确定；再选一次点「清除」去掉", async ({ page }) => {
  await seedAndOpen(page);
  await selectParagraphText(page, 0);
  await page.getByTestId("tb-link").click();
  await page.getByTestId("tb-link-input").fill("https://example.test/a");
  await page.getByTestId("tb-link-apply").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("[第一段正文。](https://example.test/a)");

  await selectParagraphText(page, 0);
  await page.getByTestId("tb-link").click();
  await page.getByTestId("tb-link-clear").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).not.toContain("https://example.test/a");
  expect(await savedOf(page)).toContain("第一段正文");
});

test("光标进代码块：块级与行内按钮置灰，出了代码块又恢复", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator('.ProseMirror [data-testid="pm-code-block"] code').first().click();

  const disabled = page.getByTestId("tb-h2");
  await expect(disabled).toBeDisabled();
  await expect(page.getByTestId("tb-bold")).toBeDisabled();
  await expect(page.getByTestId("tb-link")).toBeDisabled();

  await clickParagraph(page, 1);
  await expect(page.getByTestId("tb-h2")).toBeEnabled();
});

test("表格里：块级按钮灰掉，但加粗可用（`| **粗** |` 是合法 GFM）", async ({ page }) => {
  await seedAndOpen(page, "| 模式 | 快捷键 |\n| :--- | ---: |\n| 阅读 | Ctrl+1 |\n\n末段。\n");
  await page.locator(".ProseMirror td").first().click();
  await expect(page.getByTestId("tb-h2")).toBeDisabled();
  await expect(page.getByTestId("tb-quote")).toBeDisabled();
  await expect(page.getByTestId("tb-bold")).toBeEnabled();
  await expect(page.getByTestId("tb-link")).toBeEnabled();

  // 选中**单元格里的文字**再点加粗：证明可用的那半真的能用，而不是换了个地方打字
  await page.evaluate(() => {
    const td = document.querySelector<HTMLElement>(".ProseMirror td");
    if (!td) throw new Error("没有单元格");
    const range = document.createRange();
    range.selectNodeContents(td);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.getByTestId("tb-bold").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("**阅读**");
});

test("当前块类型在工具栏上是亮的（高亮跟光标，不靠猜）", async ({ page }) => {
  await seedAndOpen(page);
  // 第一块是 H1 标题
  await page.locator(".ProseMirror h1").click();
  await expect(page.getByTestId("tb-h1")).toHaveClass(/is-active/);
  await expect(page.getByTestId("tb-h2")).not.toHaveClass(/is-active/);

  await clickParagraph(page, 0);
  await expect(page.getByTestId("tb-paragraph")).toHaveClass(/is-active/);
});

test("工具栏转换只重写那一块，块外逐字节不变", async ({ page }) => {
  await seedAndOpen(page);
  const before = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );

  await clickParagraph(page, 0);
  await page.getByTestId("tb-h3").click();
  await page.keyboard.press("Control+s");

  const after = await savedOf(page);
  // 标题、代码围栏、末段都保持原样（围栏的补齐列宽之类都没被牵动）
  expect(after).toContain("# 标题");
  expect(after).toContain("```sql\nSELECT 1;\n```");
  expect(after).toContain("末段不动。\n");
  expect(after).toContain("### 第一段正文");
  expect(after).toContain("第二段正文");
  expect(before).not.toContain("### 第一段正文");
});
