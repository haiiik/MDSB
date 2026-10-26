import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/** mock 下打开内置示例文档（空态页那颗「打开 Markdown 文件」= 原生对话框选中同一个文件）。 */
async function 开示例(page: Page) {
  await gotoApp(page);
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

/**
 * 130 · 这一批的四条：字号搬进编辑工具栏、底栏右下角的文件名删掉、
 * 设置里那行版本信息改成「产品名 · 版本」、软件名 MDStar。
 *
 * 每条都钉一件"改错了会静默成立"的事：
 * - 字号**只作用编辑档**：光看编辑档变大了不算过，必须同时证明**阅读档没跟着变**
 *   （删设置项的理由就是「与缩放重复」—— 阅读档要大小请用缩放，别再吃字号）。
 * - 底栏文件名删干净：不能只断元素没了，还要断**底栏整条文本里不含当前文件名**，
 *   否则以后有人换个 class 又把它塞回来。
 * - 版本行不许再出现宿主字样（`wails` / `windows` / `mock`）。
 */
test("字号功能已隐藏：设置里没有，编辑工具栏里也没有", async ({ page }) => {
  await 开示例(page);
  // ① 设置里那条明确要删（与缩放重复）
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("setting-fontsize")).toHaveCount(0);
  await expect(page.locator(".rows .row__label", { hasText: "基础字号" })).toHaveCount(0);
  // 其它设置项没被顺手删掉
  await expect(page.getByTestId("setting-autosave")).toBeVisible();
  await expect(page.getByTestId("setting-linenumbers")).toBeVisible();
  await page.getByTestId("settings-close").click();

  // ② 编辑工具栏里那颗**当前是关掉的**（语义没对齐，先隐藏；开关 = EditToolbar 的 SHOW_FONT_SIZE）
  await setMode(page, "edit");
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();
  await expect(page.getByTestId("tb-fontsize")).toHaveCount(0);
  await expect(page.locator(".edit-toolbar")).not.toContainText("字号");
  // 隐藏 ≠ 把排版改坏了：工具栏那排格式按钮都还在
  await expect(page.getByTestId("tb-paragraph")).toBeVisible();
  await expect(page.getByTestId("tb-h1")).toBeVisible();
  await expect(page.getByTestId("tb-bold")).toBeVisible();
});

test("字号功能隐藏期间，编辑档与阅读档都吃默认字号（没人被偷偷改掉）", async ({ page }) => {
  await 开示例(page);
  await setMode(page, "edit");
  await expect(page.locator(".edit-pane .hp-doc")).toHaveCSS("font-size", "15px");
  await setMode(page, "read");
  await expect(page.locator('[data-testid="document-root"] .hp-doc')).toHaveCSS("font-size", "15px");
});

test("底栏右下角不再有文件名", async ({ page }) => {
  await 开示例(page);
  await expect(page.getByTestId("status-doc-name")).toHaveCount(0);
  const 底栏文本 = await page.getByTestId("statusbar").innerText();
  // 整条底栏里不许出现当前文件名（欢迎.md 是 mock 的默认文档）
  expect(底栏文本).not.toContain("欢迎.md");
  // 但统计、模式、宽度、缩放都还在
  await expect(page.getByTestId("status-stats")).toBeVisible();
  await expect(page.getByTestId("mode-picker")).toBeVisible();
  await expect(page.getByTestId("width-picker")).toBeVisible();
  await expect(page.getByTestId("zoom-picker")).toBeVisible();
});

test("设置里那行版本信息是「MDStar v…」，不再有宿主与平台", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("open-settings").click();
  const 版本 = await page.getByTestId("setting-version").innerText();
  expect(版本.startsWith("MDStar v")).toBe(true);
  // 宿主与平台不再出现在界面上。（不禁 "mock" 这个词：mock 宿主把版本串写成 `0.1.0-mock`，
  // 那是假宿主的标记不是界面文案；真机上这一串由构建注入 —— 开发包 `0.1.0-dev`、
  // 安装包 `0.1.0`（131 起 `hp-build.ps1 -Version` / `hp-installer.ps1` 同源），
  // 所以这里只押「以 MDStar v 开头、不含 wails」，桌面脚本 15a 段判同一件事。）
  expect(版本.toLowerCase()).not.toMatch(/wails|windows|宿主/);
});

test("软件名是 MDStar（顶栏与窗口标题），界面上不出现全称", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator(".topbar__name")).toHaveText("MDStar");
  await expect(page).toHaveTitle("MDStar");
  await expect(page.locator("body")).not.toContainText("Markdown Star Browser");
});
