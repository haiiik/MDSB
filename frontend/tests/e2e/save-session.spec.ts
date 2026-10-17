import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 006 保存 / 007 自动保存 / 008 崩溃恢复 / 009 会话恢复。
 *
 * mock 宿主的 writeFile 改的是页面内存里的假文件系统，
 * 所以「重开」用 page.reload()：localStorage 里的会话与快照留下，
 * 文件内容回到初始值 —— 正好模拟「进程重启但磁盘没变」的崩溃场景。
 */

const DEMO = "/demo/欢迎.md";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

async function pickAndOpen(page: Page, path: string) {
  await page.evaluate((p) => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, path);
  await page.getByTestId("tab-open").click();
}

async function typeInSource(page: Page, text: string) {
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  await page.keyboard.type(text);
}

test("Ctrl+S 保存后脏点熄灭", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await typeInSource(page, "\n\n保存测试\n");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  await expect(page.getByTestId("status-dirty")).toHaveCount(0);
});

test("自动保存默认关闭；开启后停止输入 1 秒自动落盘", async ({ page }) => {
  await pickAndOpen(page, DEMO);

  await page.getByTestId("open-settings").click();
  const toggle = page.getByTestId("setting-autosave");
  await expect(toggle).not.toBeChecked();

  await toggle.check();
  await page.getByTestId("settings-close").click();

  await typeInSource(page, "\n自动保存的字\n");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0, { timeout: 15_000 });
});

test("设置与主题在重开页面后仍然保留", async ({ page }) => {
  // 130：原来这条借「基础字号」验持久化，那一项她删了（与缩放重复）、编辑工具栏那颗也先隐藏了，
  //      所以换成同样会持久化的「代码块行号」—— 验的是**状态袋**，不是某一颗控件。
  const 行号 = page.getByTestId("setting-linenumbers");
  await page.getByTestId("open-settings").click();
  const 原本 = await 行号.isChecked();
  await 行号.setChecked(!原本);
  await page.getByTestId("settings-close").click();
  // 127：主题不再是设置里的一条，而是标签栏齿轮右侧的开关（左太阳 / 右月亮）
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await gotoApp(page);
  await page.getByTestId("open-settings").click();
  await expect(行号).toBeChecked({ checked: !原本 });
  await expect(page.getByTestId("settings-close")).toBeVisible();
  // 主题还原的是**开关的按下态**，不再是某个 select 的值
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("theme-light")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".shell")).toBeVisible();
  // 收尾还原，别把默认值改跑
  await 行号.setChecked(原本);
  await page.getByTestId("settings-close").click();
});

test("深色主题真的作用到界面（背景变深）", async ({ page }) => {
  await page.getByTestId("theme-dark").click();

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)?.map(Number) ?? [];
  expect((r ?? 255) + (g ?? 255) + (b ?? 255)).toBeLessThan(300);
});

test("会话恢复：重开页面后标签组、顺序与活动标签还原", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await pickAndOpen(page, "/demo/项目 周报 v1.md");
  await page.getByTestId("tabbar").locator(".tab").nth(1).click();

  await page.reload();

  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("项目 周报 v1.md");
});

test("崩溃恢复：有未保存快照时启动弹提示，恢复后内容回来且仍标脏", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await typeInSource(page, "\n\n没保存就崩了\n");
  // 快照是 3 秒防抖写的
  await page.waitForTimeout(3800);

  await page.reload();

  const dlg = page.getByTestId("confirm-dialog");
  await expect(dlg).toBeVisible({ timeout: 10_000 });
  await expect(dlg).toContainText("未保存的内容");

  await page.getByTestId("confirm-恢复").click();
  await expect(page.locator(".cm-content, .hp-doc").first()).toContainText("没保存就崩了");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
});

test("崩溃恢复选「丢弃」后不再打扰", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await typeInSource(page, "\n\n要丢掉的\n");
  await page.waitForTimeout(3800);
  await page.reload();

  await expect(page.getByTestId("confirm-dialog")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("confirm-丢弃").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});

test("127：关标签时选「丢弃」，重开不该再弹「发现未保存的内容」", async ({ page }) => {
  /*
   * 她踩到的原样：改了内容 → 关标签 → 点「丢弃」→ 再打开程序，又弹「发现未保存的内容」。
   * 根因是关标签只取消了挂起的快照定时器、没删盘上那份 —— 定时器与盘是两件事，
   * 所以这条用例必须**先等快照真的落盘**（3 秒防抖）再关标签，否则测的是个空壳。
   */
  await pickAndOpen(page, DEMO);
  await typeInSource(page, "\n\n丢了就不要再问\n");
  await page.waitForTimeout(3800);

  await page.locator(".tab__close").click();
  const 关标签的确认 = page.getByTestId("confirm-dialog");
  await expect(关标签的确认).toContainText("未保存的改动");
  await 关标签的确认.getByTestId("confirm-丢弃").click();
  await expect(page.locator(".tab")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});

test("会话恢复要还原滚动位置（内容含图，回位必须在出图之后）", async ({ page }) => {
  // 长文档是 mock 自带的（不是测试 seed 的）：seed 进去的文件在 reload 后就没了
  await pickAndOpen(page, "/demo/长文档.md");
  await expect(page.locator(".hp-doc h2").first()).toBeVisible();

  await page.locator(".pane__scroller").evaluate((el) => (el.scrollTop = 900));
  await page.waitForTimeout(400);

  await page.reload();
  await expect(page.locator(".hp-doc h2").first()).toBeVisible();
  // 允许一点误差：回位发生在尾部图片撑高内容之后
  await expect
    .poll(() => page.locator(".pane__scroller").evaluate((el) => el.scrollTop), { timeout: 5000 })
    .toBeGreaterThan(700);
});
