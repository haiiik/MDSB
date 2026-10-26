import { expect, test, type Page } from "@playwright/test";

/**
 * 冒烟：浏览器 mock 壳能起来、布局四槽位齐、宿主自检通过。
 * 后续每张工单的 UI 断言都往这个目录里加，不再另起脚手架。
 */

test("空壳加载：标题 + 四个布局槽位可见", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("MDStar");
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".pane")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
});

test("空态文案可见", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "没有打开的文档" })).toBeVisible();
});

/**
 * 127：底栏不再有「宿主=mock」那颗字段（原话：日常是噪音，版本挪进设置）。
 * **130 之后连设置里也不报宿主了**（那行只剩「MDStar v版本」），所以"宿主判定成什么"
 * 不再能从界面读 —— 判据改成直接问代码：mock 宿主挂的钩子在不在。
 * 原来靠 `toContainText("mock")` 蹭的是 mock 构建把版本串写成 `0.1.0-mock`，
 * 那是**构建标记不是界面文案**，蹭它等于把判据建在偶然上，故换掉。
 */
const 宿主是mock = (page: Page) =>
  page.evaluate(() => typeof (window as unknown as Record<string, unknown>).__hpMockSeedFile === "function");

/**
 * 140：空态那块「宿主自检」面板按那句要求删了（"没用就删了"），
 * 所以这条只留**宿主判定**与**版本行**两件事，不再断言自检那行字。
 */
test("宿主判定为 mock（状态袋自检面板已随 140 删除）", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".statusbar")).not.toContainText("宿主=");
  expect(await 宿主是mock(page)).toBe(true);
  await page.getByTestId("open-settings").click();
  const 版本 = page.getByTestId("setting-version");
  await expect(版本).toContainText("MDStar v");
  await expect(版本).not.toContainText("wails");

  // 自检面板删了：这块 DOM 不该还在（删干净了才算这条过）
  await expect(page.locator(".check")).toHaveCount(0);
});

test("?host=mock 显式覆盖：与自动判定结果一致", async ({ page }) => {
  await page.goto("/?host=mock");
  expect(await 宿主是mock(page)).toBe(true);
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("setting-version")).toContainText("MDStar v");
  await page.getByTestId("settings-close").click();
  await expect(page.locator(".check")).toHaveCount(0);
});
