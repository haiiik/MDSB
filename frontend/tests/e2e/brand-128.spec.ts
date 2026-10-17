import { expect, test } from "@playwright/test";
import { gotoApp } from "./mockApp";

/**
 * 128 · 软件名 MDSB → MDStar，品牌图形换成 star-doc 的「星里挖一张纸页」。
 *
 * 三条钉住的是「改名改干净了」与「两张标记真的在用」：
 * ① 界面上只剩短名 `MDStar`，**全称 Markdown Star Browser 只留在 exe 属性页**（FileDescription），
 *    所以这里反向钉一条「界面上任何地方都不该再出现全称」——防止有人把全称又塞回标题或 tooltip；
 * ② 顶栏那颗标记**跟着主题换两张**（深浅两套配色是各自设计的：纸白磁贴带投影、近黑磁贴带描边，
 *    不是同一张反色），换的是 `src` 而不是 CSS 滤镜 —— 滤镜做不出「各自设计」；
 * ③ 两张都得真加载出来（`naturalWidth > 0`）：路径写错时界面上是一个不报错的空格子。
 *
 * 旧的马嗅纸资产已退役（`assets/brand/README.md` 记了来源与替换日期），
 * 内部标识**故意没改**：Go module `mdsb`、`%APPDATA%\mdsb`、`.mdsb.tmp`、单实例 ID `io.mdsb.app`
 * —— 她定的是「软件内都更名，但项目名不变」，再折腾一次数据目录迁移没有收益只有风险。
 */
test("顶栏品牌是 MDStar，界面上不再出现全称", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator(".topbar__name")).toHaveText("MDStar");
  await expect(page).toHaveTitle("MDStar");
  await expect(page.locator(".topbar__brand")).toHaveAttribute("title", "MDStar");
  await expect(page.locator("body")).not.toContainText("Markdown Star Browser");
});

test("顶栏标记随主题换两张（深浅各自设计，不是反色）", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("theme-light").click();
  await expect(page.getByTestId("brand-logo")).toHaveAttribute("src", "/logo.svg");
  await page.getByTestId("theme-dark").click();
  await expect(page.getByTestId("brand-logo")).toHaveAttribute("src", "/logo-dark.svg");
  await page.getByTestId("theme-light").click();
  await expect(page.getByTestId("brand-logo")).toHaveAttribute("src", "/logo.svg");
});

/**
 * 129：两张都改成 **SVG 矢量母版**。原来用 48px 位图铺到 20 CSS px（175% 屏 ≈35 设备像素）
 * 是非整数倍缩小，md 档那圈点状描边每段只剩一两个像素 —— 她看到的「锯齿」就是这么来的。
 * 判据押「拿到的是矢量（固有宽度是 1024 的母版，不是几十像素的位图）」，
 * 这样以后有人把它换回小位图，这条会红。
 */
test("两张标记都是矢量母版（不是被缩小的小位图）", async ({ page }) => {
  await gotoApp(page);
  for (const [档, 源] of [
    ["theme-light", "/logo.svg"],
    ["theme-dark", "/logo-dark.svg"],
  ] as const) {
    await page.getByTestId(档).click();
    const 量 = await page.getByTestId("brand-logo").evaluate((el) => {
      const i = el as HTMLImageElement;
      const r = i.getBoundingClientRect();
      return { 自然宽: i.naturalWidth, 宽: r.width, 高: r.height, src: i.getAttribute("src") };
    });
    expect(量.src).toBe(源);
    expect(量.自然宽).toBeGreaterThanOrEqual(512); // 1024 的矢量母版
    expect(量.宽).toBeGreaterThanOrEqual(18);
    expect(量.宽).toBeLessThanOrEqual(24);
    expect(Math.abs(量.宽 - 量.高)).toBeLessThanOrEqual(1); // 别被压成椭圆
  }
});
