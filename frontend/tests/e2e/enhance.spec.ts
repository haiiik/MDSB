import { expect, test } from "@playwright/test";

/**
 * 020 代码块增强 / 021 图片失效与灯箱 / 022 [TOC] / 018 缩放 / 019 宽度档。
 */

const DOC = "/demo/增强自检.md";

test.beforeEach(async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent(DOC));
  await expect(page.getByRole("heading", { name: "增强自检", level: 1 })).toBeVisible();
});

test("022 [TOC] 换成可点击目录，且源码里的标记不受影响", async ({ page }) => {
  const toc = page.locator(".hp-toc");
  await expect(toc).toHaveCount(1);
  await expect(toc.locator("a")).toHaveCount(5); // h1 增强自检 + 4 个 h2
  await expect(toc.locator("a", { hasText: "统计口径" })).toBeVisible();

  // TOC 之后紧跟的段落仍在
  await expect(page.getByRole("heading", { name: "目录之上还有一句话", level: 2 })).toBeVisible();

  // 点目录能跳
  const before = await page.locator(".pane__scroller").evaluate((el) => el.scrollTop);
  await toc.locator("a", { hasText: "统计口径" }).click();
  const after = await page.locator(".pane__scroller").evaluate((el) => el.scrollTop);
  expect(after).toBeGreaterThan(before);
});

test("020 长代码块默认折叠，可展开；复制得到原始代码", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const box = page.locator(".hp-code").first();
  await expect(box).toHaveClass(/is-folded/);
  await expect(box.locator(".hp-code__lang")).toHaveText("ts");

  await box.locator(".hp-code__fold").click();
  await expect(box).not.toHaveClass(/is-folded/);

  await expect(box.locator(".hp-code__copy")).toHaveText("复制");
  await box.locator(".hp-code__copy").click();
  await expect(box.locator(".hp-code__copy")).toHaveText("已复制");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('console.log("line 1");');
  expect(clip).toContain('console.log("line 26");');
  expect(clip).not.toContain("复制"); // 工具条文字不进剪贴板
  expect(clip).not.toMatch(/^\s*\d+/); // 行号不进剪贴板
});

test("021 失效图片显示占位块并带原始路径", async ({ page }) => {
  const broken = page.locator(".hp-img-broken");
  await expect(broken).toHaveCount(1);
  await expect(broken).toContainText("图片无法显示");
  await expect(broken.locator(".hp-img-broken__path")).toContainText("/demo/diagrams/不存在.png");
  // 正常图仍在
  await expect(page.locator("img.hp-img")).toHaveCount(1);
});

test("021 点击图片开灯箱，Esc 关闭", async ({ page }) => {
  // 必须指定是哪一张：坏图要被 error 事件换成占位块才从 img 列表里消失，
  // 抢在那之前点就会撞上 strict mode（两张 img.hp-img）
  const good = page.locator('img.hp-img[data-local-path="/demo/diagrams/arch.png"]');
  await expect(good).toBeVisible();
  await good.click();
  const box = page.locator(".hp-lightbox");
  await expect(box).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
});

test("018 缩放按钮按 10% 步进并受 50%~200% 上下限约束", async ({ page }) => {
  const doc = page.locator(".hp-doc");
  await expect(doc).toHaveCSS("zoom", "1");

  await page.getByTestId("zoom-in").click();
  await expect(doc).toHaveCSS("zoom", "1.1");
  await expect(page.getByTestId("statusbar")).toContainText("110%");

  await page.getByTestId("zoom-out").click();
  await page.getByTestId("zoom-out").click();
  await expect(doc).toHaveCSS("zoom", "0.9");

  for (let i = 0; i < 20; i++) await page.getByTestId("zoom-in").click();
  await expect(doc).toHaveCSS("zoom", "2");
  for (let i = 0; i < 30; i++) await page.getByTestId("zoom-out").click();
  await expect(doc).toHaveCSS("zoom", "0.5");

  await page.getByTestId("zoom-name").click();
  await expect(doc).toHaveCSS("zoom", "1");
});

test("018 缩放是每标签独立的", async ({ page }) => {
  await page.getByTestId("zoom-in").click();
  await page.getByTestId("tab-open").click(); // 再开一个（mock 默认返回示例文档）
  const tabs = page.getByTestId("tabbar").locator(".tab");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".hp-doc")).toHaveCSS("zoom", "1");
  await tabs.nth(0).click();
  await expect(page.locator(".hp-doc")).toHaveCSS("zoom", "1.1");
});

test("019 四档宽度切换生效且不丢滚动位置", async ({ page }) => {
  const doc = page.locator(".hp-doc");
  await expect(doc).toHaveCSS("max-width", "900px");

  await page.selectOption("[data-testid=width-select]", "narrow");
  await expect(doc).toHaveCSS("max-width", "760px");
  await page.selectOption("[data-testid=width-select]", "wide");
  await expect(doc).toHaveCSS("max-width", "1100px");

  const scroller = page.locator(".pane__scroller");
  await scroller.evaluate((el) => (el.scrollTop = 200));
  await page.selectOption("[data-testid=width-select]", "full");
  await expect(doc).toHaveCSS("max-width", "none");
  await expect(scroller).toHaveJSProperty("scrollTop", 200);
});

test("023 状态栏统计按既定口径计字（代码块不计入）", async ({ page }) => {
  const stats = page.getByTestId("status-stats");
  await expect(stats).toBeVisible();
  const text = await stats.textContent();
  // 「汉字若干个」5 + 「增强自检」4 + 各标题与正文若干；这里只要求数量级与格式，
  // 精确值由 tests/unit/stats.spec.ts 逐条钉住
  expect(text?.trim()).toMatch(/^\d+ 字 · \d+ 行 · \d+ 标题$/);
});
