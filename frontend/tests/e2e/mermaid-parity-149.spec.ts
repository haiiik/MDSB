import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 149-C（她 10-22：「阅读模式和编辑模式的 mermaid 图哪个占高度更高？
 * 让低的兼容高的，两个图整体大小一致（编辑模式包括功能栏）」）。
 *
 * 探针实测的答案：**编辑档更高** —— 同一张图 708×70 两档一模一样，
 * 但整块阅读档 94px、编辑档 143px，差的 49px 全是编辑档那层壳：
 * 功能栏 33 + 提示行 26 + 上下边框 2 + 预览区内边距 10。
 * 于是同一篇文档切个模式，每张图下面的正文都上下跳一次（图越多跳得越散）。
 *
 * 她定的方向是**矮的一方补到高的一方**：阅读档也摆一条空功能栏、一行空提示
 * （同 147 那条顶部空栏的路子）。图本身不动尺寸 —— 那才是她要的「两个图整体大小一致」。
 *
 * 判据按几何比，且钉住「空栏是装饰不是控件」：里面不许有能点的东西。
 */

const 图源码 = ["flowchart LR", "  A[受理] --> B[形式审查] --> C[会签] --> D[批复] --> E[归档]"].join("\n");

const DOC = ["# 两档同高", "", "```mermaid", 图源码, "```", "", "图后面的正文。", ""].join("\n");

type 量 = { 块: number; 图宽: number; 图高: number; 顶: number; 钮: number; 下拉: number };

const 量图 = (page: Page): Promise<量> =>
  page.evaluate(() => {
    const 阅读块 = document.querySelector<HTMLElement>('.hp-mermaid[data-state="done"]');
    const 编辑块 = document.querySelector<HTMLElement>('.hp-codebox[data-mermaid="1"]');
    const 块 = (阅读块 ?? 编辑块) as HTMLElement | null;
    if (!块) throw new Error("图还没渲染出来");
    const svg = 块.querySelector("svg");
    if (!svg) throw new Error("块里没有 svg");
    return {
      块: Math.round(块.getBoundingClientRect().height),
      图宽: Math.round(svg.getBoundingClientRect().width),
      图高: Math.round(svg.getBoundingClientRect().height),
      顶: Math.round(svg.getBoundingClientRect().top),
      钮: 块.querySelectorAll("button").length,
      下拉: 块.querySelectorAll("select").length,
    };
  });

async function 打开(page: Page): Promise<void> {
  const path = "/demo/两档同高-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
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
  await expect(page.locator('.hp-mermaid[data-state="done"] svg')).toBeVisible({ timeout: 20_000 });
}

test("两档整块等高，图本身同尺寸（编辑档算上功能栏）", async ({ page }) => {
  await 打开(page);
  const 阅 = await 量图(page);
  await setMode(page, "edit");
  await page.waitForSelector('.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg svg');
  await page.waitForTimeout(1_500);
  const 编 = await 量图(page);
  expect(
    Math.abs(编.块 - 阅.块),
    `两档整块高度不一致：阅读 ${阅.块} / 编辑 ${编.块}（切模式时图会上下跳）`
  ).toBeLessThanOrEqual(1);
  expect(编.图高, `图本身被壳挤小了：阅读 ${阅.图高} / 编辑 ${编.图高}`).toBe(阅.图高);
  expect(编.图宽).toBe(阅.图宽);
});

test("图在两块里的位置一致（壳同形 = 图不上跳）", async ({ page }) => {
  await 打开(page);
  const 阅 = await 量图(page);
  await setMode(page, "edit");
  await page.waitForSelector('.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg svg');
  await page.waitForTimeout(1_500);
  const 编 = await 量图(page);
  expect(
    Math.abs(编.顶 - 阅.顶),
    `图顶边两档差了 ${编.顶 - 阅.顶}px（阅读档那条空栏没顶上）`
  ).toBeLessThanOrEqual(1);
});

test("阅读档那条是装饰栏：里面没有能点的控件", async ({ page }) => {
  await 打开(page);
  const 阅 = await 量图(page);
  expect(阅.钮, "阅读档的空功能栏里摆了按钮（阅读档是只读档）").toBe(0);
  expect(阅.下拉, "阅读档的空功能栏里有语言下拉").toBe(0);
  // 编辑档那两处是真控件，对照着钉一条：空栏不是把编辑档的控件复制过来
  await setMode(page, "edit");
  await page.waitForSelector('.hp-codebox[data-mermaid="1"]');
  await page.waitForTimeout(800);
  const 编 = await 量图(page);
  expect(编.下拉).toBe(1);
  expect(编.钮).toBeGreaterThan(0);
});

test("图渲染失败时不给空栏（错误块没有「另一种展示」，不该占编辑档的壳）", async ({ page }) => {
  const path = "/demo/坏图同高.md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, "# 坏图\n\n```mermaid\nflowchart TD\n  A[ --> \n```\n\n后头。\n"]
  );
  await page.getByTestId("tab-open").click();
  const 错 = page.locator('.hp-mermaid[data-state="error"]');
  await expect(错).toBeVisible({ timeout: 20_000 });
  await expect(错.locator(".hp-codebox__bar")).toHaveCount(0);
});
