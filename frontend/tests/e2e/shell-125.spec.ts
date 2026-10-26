import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * 125：这轮三条指令里「外壳」那两条的回归钉子。
 *
 * ① 设置图标要**真是齿轮**（第一版手描的两条 path 同向绕，默认 nonzero 填充规则下
 *    中心孔根本没挖出来，看着就是一坨带棱角的黑块 —— 原话：「图标不对」的真相）；
 * ② 模式入口只剩底栏三按钮，标签栏那个循环按钮删掉（口径 Q10 已定）。
 */

test.beforeEach(async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(() => {
    (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(
      "/demo/外壳125.md",
      "# 外壳 125\n\n正文。\n"
    );
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/外壳125.md";
  });
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
});

/**
 * 把图标序列化后画进 canvas 逐像素采样 —— 这是唯一能钉住「中心是空的」的写法。
 * 断 `path` 数量、断 `d` 字符串都能被绕过，像素不行。
 */
const sample = (page: Page) =>
  page.evaluate(async () => {
    const svg = document.querySelector('[data-testid="open-settings"] svg')!;
    const src = new XMLSerializer().serializeToString(svg);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src);
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("SVG 没能解码"));
      i.src = url;
    });
    const S = 64; // 64 倍采样，避开抗锯齿的边缘像素
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    const alpha = (x: number, y: number) => d[(y * S + x) * 4 + 3];
    return {
      中心: alpha(S / 2, S / 2), // 孔：必须是 0
      齿顶: alpha(S / 2, 3), // 上方那颗齿：必须实心
      环带: alpha(S / 2, 13), // 齿根与孔之间的实体环：必须实心
      四角: [alpha(1, 1), alpha(S - 2, 1), alpha(1, S - 2), alpha(S - 2, S - 2)], // 必须是 0（不是圆/方块）
    };
  });

test("齿轮：中心孔是空的、齿是实的（第一版就是一坨实心）", async ({ page }) => {
  const g = await sample(page);
  expect(g.中心, `中心 alpha=${g.中心}，说明孔没挖出来`).toBe(0);
  expect(g.环带).toBeGreaterThan(200);
  expect(g.齿顶).toBeGreaterThan(200);
  expect(g.四角.every((a) => a === 0), `四角不该有墨：${JSON.stringify(g.四角)}`).toBe(true);
});

test("齿轮在标签栏右端、可点、开得出设置面板", async ({ page }) => {
  const gear = page.getByTestId("open-settings");
  await expect(gear).toHaveCount(1); // 全应用只有一个设置入口
  await expect(gear.locator("path")).toHaveCount(1); // 一条 path 画完（孔靠反向绕，不靠第二条）
  await gear.click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
});

test("标签栏不再有模式切换按钮，底栏三按钮是唯一直达入口", async ({ page }) => {
  await expect(page.getByTestId("tabbar").locator('[data-testid^="mode-"]')).toHaveCount(0);
  await expect(page.getByTestId("mode-picker").getByTestId(/^mode-/)).toHaveCount(3);
  // 底栏按钮组在标签栏右侧留下的只有齿轮：右端最后一个**按钮**是 settings
  // （127 之后齿轮右边又多了主题开关，所以最后一个元素是 themepill —— 它不是按钮，是一颗开关）
  const tails = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="tabbar"]')!;
    return [...bar.children].slice(-2).map((el) => el.className);
  });
  expect(tails[1]).toContain("themepill");
  expect(tails[0]).toContain("tabbar__settings");
});
