import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * 163（要求：「标签栏标签新增鼠标移入静置 1 秒鼠标浮窗显示文件全名」）。
 *
 * 钉的是"什么时候弹、弹出来是什么、什么时候必须收"，位置算法在
 * `tests/unit/tab-tooltip-anchor-163.spec.ts`。三条口径抄 127 那条跑马灯的作业：
 * 只对**真的被截断**的那一颗弹；延时的尾巴落下前再认一次指针还在不在；
 * 浮层不吃鼠标（不然鼠标追上去会把浮层顶掉，读不完又弹回来）。
 */

const 长名 = "这份文件的名称长到一定会被省略号吃掉.md";
const 短名 = "短名.md";

async function 开两篇(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  for (const [i, 名] of [
    [0, 长名],
    [1, 短名],
  ] as const) {
    const p = "/demo/" + 名;
    await page.evaluate(
      ([path, text]) => {
        (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(
          path,
          text
        );
        (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = path;
      },
      [p, "# 悬停全名 " + i + "\n\n正文。\n"]
    );
    await page.getByTestId("tab-open").click();
    await page.waitForTimeout(200);
  }
}

const 那颗 = (page: Page, 名: string) =>
  page.locator(".tab").filter({ has: page.locator(".tab__name", { hasText: 名.replace(".md", "") }) }).first();
const 浮层 = (page: Page) => page.getByTestId("tab-tip");

/** 这一颗此刻是否真的被截断（判据的前提，不成立就别往下测） */
const 截断了 = (page: Page, 名: string) =>
  那颗(page, 名)
    .locator(".tab__name")
    .evaluate((el) => el.scrollWidth - el.clientWidth);

test("长名字那颗悬停满 1 秒：弹出来的是完整文件名，落在标签下方且在窗口里", async ({ page }) => {
  await 开两篇(page);
  const 溢出 = await 截断了(page, 长名);
  expect(溢出, "判据前提：这颗标签的名字确实被截断了").toBeGreaterThan(1);

  const 标签 = 那颗(page, 长名);
  await 标签.hover();
  await page.waitForTimeout(1300);
  await expect(浮层(page)).toBeVisible();
  expect((await 浮层(page).textContent())!.trim()).toBe(长名);

  const 位 = await 那颗(page, 长名).evaluate((颗) => {
    const 钮 =颗.querySelector(".tab__name")?.getBoundingClientRect();
    const 条 = document.querySelector('[data-testid="tab-tip"]')?.getBoundingClientRect();
    return {
      标签下缘: 钮 ? Math.round(钮.bottom) : -1,
      浮层顶边: 条 ? Math.round(条.top) : -1,
      浮层左缘: 条 ? Math.round(条.left) : -1,
      浮层右缘: 条 ? Math.round(条.right) : -1,
      视口宽: window.innerWidth,
    };
  });
  expect(位.浮层顶边).toBeGreaterThanOrEqual(位.标签下缘);
  expect(位.浮层左缘).toBeGreaterThanOrEqual(8);
  expect(位.浮层右缘).toBeLessThanOrEqual(位.视口宽 - 8 + 1);
});

test("名字本来就看得全的那颗不弹（没截断就别加一层浮层噪音）", async ({ page }) => {
  await 开两篇(page);
  expect(await 截断了(page, 短名), "判据前提：这颗没被截断").toBeLessThanOrEqual(1);
  await 那颗(page, 短名).hover();
  await page.waitForTimeout(1300);
  await expect(浮层(page)).toHaveCount(0);
});

test("只扫过去 0.4 秒就移开：不许弹（延时的意义就是别让扫过的标签乱弹）", async ({ page }) => {
  await 开两篇(page);
  await 那颗(page, 长名).hover();
  await page.waitForTimeout(400);
  await page.mouse.move(20, 500); // 移到正文里
  await page.waitForTimeout(1200); // 延时的尾巴这会儿才该落下 —— 而指针早不在那颗上了
  await expect(浮层(page), "迟到的定时器必须被挡住（127 记过同一类坑）").toHaveCount(0);
});

test("弹出来之后移开鼠标：立刻收起", async ({ page }) => {
  await 开两篇(page);
  await 那颗(page, 长名).hover();
  await page.waitForTimeout(1300);
  await expect(浮层(page)).toBeVisible();
  await page.mouse.move(20, 500);
  await page.waitForTimeout(300);
  await expect(浮层(page)).toHaveCount(0);
});

test("浮层不吃鼠标：弹着的时候点那颗标签照样能激活", async ({ page }) => {
  await 开两篇(page);
  const 标签 = 那颗(page, 长名);
  await 标签.hover();
  await page.waitForTimeout(1300);
  await expect(浮层(page)).toBeVisible();
  const 挡不住 = await 浮层(page).evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(挡不住).toBe("none");
  await 标签.click({ timeout: 5000 });
  await expect(标签).toHaveClass(/is-active/);
});

test("换到另一颗标签：浮层收起（不许留着指向已经不走鼠标的那一颗）", async ({ page }) => {
  await 开两篇(page);
  await 那颗(page, 长名).hover();
  await page.waitForTimeout(1300);
  await expect(浮层(page)).toBeVisible();
  await 那颗(page, 短名).click();
  await page.waitForTimeout(300);
  await expect(浮层(page)).toHaveCount(0);
});
