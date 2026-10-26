import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoApp } from "./mockApp";

/** mock 里「打开一个文件」= 先塞虚拟磁盘 + 预置对话框返回值，再点标签栏那颗文件夹（原生对话框点不了）。 */
async function 打开(page: Page, path: string, md: string) {
  await page.evaluate(
    ([p, m]) => {
      const w = window as unknown as {
        __hpMockSeedFile: (a: string, b: string) => void;
        __hpMockPickPath?: string;
      };
      w.__hpMockSeedFile(p, m);
      w.__hpMockPickPath = p;
    },
    [path, md],
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

/**
 * 129 · 两条：① 最近/导航与软件顶栏都收窄；② 底栏里「统计信息」与「阅读/编辑/源码」对调位置。
 *
 * 判据都写成**量出来的**，不写「看起来矮了」：
 * - 高度钉一个上限（≤34px）而不是精确值：32px 是这一版的值，将来微调一两个像素不该红，
 *   但退回 40 那种「一眼就知道没改」必须红；同时钉一条**页签顶满这一行**——
 *   收高度最容易犯的错是行收了两颗页签没收，底下留一条缝。
 * - 底栏顺序按**几何**判（左边缘、右边缘），不按 DOM 顺序判：
 *   DOM 里 `<span class="statusbar__spacer">` 会把视觉顺序和文档顺序分开，押 DOM 序会误伤。
 */
test("顶栏与侧栏头部收窄到 32px 一档，页签仍顶满这一行", async ({ page }) => {
  await gotoApp(page);
  const 顶栏 = (await page.getByTestId("topbar").boundingBox())!;
  expect(顶栏.height).toBeLessThanOrEqual(34);
  expect(顶栏.height).toBeGreaterThanOrEqual(28);

  const 头部 = await page.locator(".sidebar__head").boundingBox();
  expect(头部!.height).toBeLessThanOrEqual(34);
  expect(头部!.height).toBeGreaterThanOrEqual(28);

  for (const 页 of ["page-recent", "page-outline"]) {
    const 颗 = (await page.getByTestId(页).boundingBox())!;
    // 顶满：颗的底边与这一行的底边对得上（差 ≤1px），不留缝
    expect(Math.abs(颗.y + 颗.height - (头部!.y + 头部!.height))).toBeLessThanOrEqual(1);
    expect(颗.height).toBeGreaterThanOrEqual(28);
    expect(颗.width).toBeGreaterThanOrEqual(80);
  }
  // 窗口三键不能被压到点不着：盒子仍 ≥20px 高
  const 关闭 = (await page.getByTestId("win-close").boundingBox())!;
  expect(关闭.height).toBeGreaterThanOrEqual(20);
  expect(关闭.width).toBeGreaterThanOrEqual(24);
  // 主题开关右缘仍与窗口关闭按钮右缘对齐（127 定的那条，收高度不该弄坏它）
  // 注意量的是**整颗药丸** `theme-switch`，不是里面的 `theme-light` 半颗（那是左半边，右缘落在中间）
  const 开关 = (await page.getByTestId("theme-switch").boundingBox())!;
  const 标签栏 = await page.locator(".tabbar").boundingBox();
  expect(Math.abs(开关.x + 开关.width - (关闭.x + 关闭.width))).toBeLessThanOrEqual(1.5);
  expect(标签栏!.height).toBeLessThanOrEqual(34);
});

test("底栏：统计信息在最左，模式三按钮在右侧那一组的最前", async ({ page }) => {
  await gotoApp(page);
  await 打开(page, "/demo/底栏顺序.md", "# 底栏顺序\n\n正文一段。\n");
  // 统计是 200ms 防抖算出来的，先等它出现再量（否则量到的是 null，红在判据上不是产品上）
  await expect(page.getByTestId("status-stats")).toBeVisible();

  const 量 = await page.evaluate(() => {
    const 条 = document.querySelector('[data-testid="statusbar"]')!;
    const r = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const 条b = 条.getBoundingClientRect();
      return { 左: b.left, 右: b.right, 中心: b.top + b.height / 2, 条左: 条b.left, 条右: 条b.right, 高: b.height };
    };
    return {
      统计: r('[data-testid="status-stats"]'),
      模式: r('[data-testid="mode-picker"]'),
      宽度: r('[data-testid="width-picker"]'),
      缩放: r('[data-testid="zoom-picker"]'),
      条: r('[data-testid="statusbar"]'),
    };
  });
  expect(量.统计 && 量.模式 && 量.宽度).toBeTruthy();
  const 统计 = 量.统计!, 模式 = 量.模式!, 宽度 = 量.宽度!;

  // ① 统计贴着底栏左缘（它现在是最左的一项）
  expect(统计.左 - 统计.条左).toBeLessThan(20);
  // ② 模式组在右半边，且排在宽度/缩放之前
  expect(模式.左).toBeGreaterThan(统计.右);
  expect(模式.右).toBeLessThan(宽度.左);
  expect(模式.条右 - 模式.右).toBeGreaterThan(0);
  // ③ 各项垂直居中：中心线与底栏中线的差 ≤1.5px
  for (const 项 of [统计, 模式, 宽度, 量.缩放!]) expect(Math.abs(项.中心 - 量.条!.中心)).toBeLessThanOrEqual(1.5);
});

test("没打开文档时，底栏左侧只出现一次「未打开文档」", async ({ page }) => {
  await gotoApp(page);
  // 关掉所有标签，回到底栏的空态
  let 还有 = await page.locator(".tab").count();
  while (还有-- > 0) {
    await page.locator(".tab").first().locator(".tab__close").click();
    await page.waitForTimeout(200);
  }
  // 判据押 testid 不押中文文本：i18n 之后文案会随语言变（M3-135 定的迁移口径）
  await expect(page.getByTestId("status-not-opened")).toBeVisible();
  await expect(page.getByTestId("status-not-opened")).toHaveCount(1);
  // 空态下不该还有模式按钮与统计（它们都挂在 activeTab 上）
  await expect(page.getByTestId("mode-picker")).toHaveCount(0);
  await expect(page.getByTestId("status-stats")).toHaveCount(0);
});
