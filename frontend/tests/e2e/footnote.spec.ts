import { expect, test } from "@playwright/test";

/**
 * 136-A 脚注：阅读模式的渲染、跳转与本地化。
 *
 * 解析与渲染 remark-gfm 本来就做了，所以这里验的是**我们补的那三件事**：
 * 标题本地化、回跳箭头的无障碍名、点引用/点 ↩ 的滚动接管（且不污染地址栏）。
 * 判据全部押 testid 与几何量，不押中文措辞（i18n 那条规矩）。
 */

const DOC = "/demo/脚注自检.md";

test.beforeEach(async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent(DOC));
  await expect(page.getByRole("heading", { name: "脚注自检", level: 1 })).toBeVisible();
});

test("脚注区出现，标题是本地化的「脚注」，引用与回跳数量对得上", async ({ page }) => {
  const notes = page.getByTestId("footnotes");
  await expect(notes).toHaveCount(1);
  await expect(page.getByTestId("footnotes-title")).toHaveText("脚注");

  // 正文里 3 个引用（[^one] 两次 + [^two] 一次）
  await expect(page.getByTestId("footnote-ref")).toHaveCount(3);
  // 文末 3 个回跳箭头（一条定义被多处引用 → 每个引用一个 ↩）
  await expect(page.getByTestId("footnote-backref")).toHaveCount(3);
  // 编号由 remark 按定义顺序给：第一条定义是 1
  await expect(page.getByTestId("footnote-ref").first()).toHaveText("1");

  // 定义内容里的行内标记照常渲染（粗体 / 代码），说明这块没被当成纯文本
  await expect(notes.locator("strong")).toHaveCount(1);
  await expect(notes.locator("code")).toHaveCount(1);
});

test("点正文引用跳到定义，点 ↩ 跳回来；地址栏不被写脏", async ({ page }) => {
  const scroller = page.locator(".pane__scroller");
  const before = await scroller.evaluate((el) => el.scrollTop);

  await page.getByTestId("footnote-ref").first().click();
  const atNote = await scroller.evaluate((el) => el.scrollTop);
  expect(atNote).toBeGreaterThan(before);

  // 我们接管了滚动，就不该留下 hash（留了的话，用户复制地址、按后退都会中枪）
  expect(page.url()).not.toContain("#");

  // 目标条目闪一下作为落点反馈
  await expect(page.getByTestId("footnotes").locator("li").first()).toHaveClass(/is-fn-target/);

  await page.getByTestId("footnote-backref").first().click();
  const back = await scroller.evaluate((el) => el.scrollTop);
  expect(back).toBeLessThan(atNote);
});

test("切成 English 后脚注标题与回跳提示一起换，testid 不变", async ({ page }) => {
  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("footnotes-title")).toHaveText("Footnotes");
  const back = page.getByTestId("footnote-backref").first();
  await expect(back).toHaveAttribute("aria-label", /^Back to reference \d+$/);
  // 判据的落脚点不随语言变
  await expect(page.getByTestId("footnote-ref")).toHaveCount(3);
});

test("只是在阅读模式里点了跳转，不该把文档改成未保存状态", async ({ page }) => {
  await page.getByTestId("footnote-ref").first().click();
  await page.getByTestId("footnote-backref").first().click();
  // 阅读模式是只读的：底栏不该出现「有未保存改动」
  await expect(page.getByTestId("status-dirty")).toHaveCount(0);
});
