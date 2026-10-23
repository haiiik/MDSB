import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * 153（她 10-23，红框圈住侧栏那一行）：「继续加宽标签宽度和底部色条宽度，
 * 尽可能对齐下方滚动条左侧」。
 *
 * 改前实测（侧栏 260px 宽）：两颗页签各 84px、整组居中，落在 44→216，
 * 两侧各空 44px / 43px —— 与下方一直顶到滚动条的列表不成形。
 * 改后：两颗**平分这一行**（各 115px，0→115 与 123→237），
 * 色条从 60px 长到 99px（左右各缩 8px）。
 *
 * 为什么右端停在 237 而不是滚动条左缘（~247）：那 22px 是「收起侧栏」把手的点击区
 * （`.sidebar__edge` 是整栏高的透明条），页签压上去就点不着了 —— 她说的是"尽可能"。
 *
 * 判据钉的是**几何**：左缘贴住栏的左边界、右缘正好停在把手左边界、两颗等宽、色条明显变宽。
 * 127 / 129 那两条（≥80px 宽、底边与这一行对齐、高 30~34）继续成立，不放宽。
 */

const DOC = ["# 侧栏页签", "", "## 甲节", "", "## 乙节", "", "正文。", ""].join("\n");

async function 打开(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    ["/demo/侧栏页签加宽.md", DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await page.setViewportSize({ width: 1463, height: 900 });
  await page.waitForTimeout(400);
}

const 量行 = (page: Page) =>
  page.evaluate(() => {
    const 盒 = (el: Element | null) => {
      const b = el!.getBoundingClientRect();
      return { 左: Math.round(b.left), 右: Math.round(b.right), 宽: Math.round(b.width) };
    };
    const 颗 = Array.from(document.querySelectorAll(".sidebar__tab")).map(盒);
    const 选中 = document.querySelector(".sidebar__tab.is-active") as HTMLElement;
    const 条 = getComputedStyle(选中, "::after");
    // 色条的实际宽度 = 页签宽 - 左右缩进
    const 缩 = [Number(条.left.replace("px", "")), Number(条.right.replace("px", ""))];
    return {
      栏: 盒(document.querySelector(".sidebar")!),
      颗,
      把手: 盒(document.querySelector(".sidebar__edge")!),
      色条宽: 颗.find((c) => c.左 >= 0 && c.右 <= 260)!.宽 - 缩[0] - 缩[1],
      色条缩进: 缩,
    };
  });

test("两颗页签平分这一行：左缘贴栏、右缘停在把手左边界", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  const 量 = await 量行(page);
  expect(量.颗[0].左, "第一颗没贴住栏的左边界").toBe(量.栏.左);
  expect(量.颗[1].右, `第二颗右缘没停在把手左边界（${量.颗[1].右} vs 把手 ${量.把手.左}）`).toBe(量.把手.左);
  expect(Math.abs(量.颗[0].宽 - 量.颗[1].宽), "两颗不等宽").toBeLessThanOrEqual(1);
  // 她要的是"加宽"：比改前的 84px 明显更宽
  expect(量.颗[0].宽, `页签还是 ${量.颗[0].宽}px 宽（改前 84px）`).toBeGreaterThanOrEqual(110);
});

test("底部色条跟着变宽（左右各缩 8px，不是原来的 12px）", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  const 量 = await 量行(page);
  expect(量.色条缩进, "色条缩进没改").toEqual([8, 8]);
  expect(量.色条宽, `色条只有 ${量.色条宽}px（改前 60px）`).toBeGreaterThanOrEqual(95);
});

test("换到导航页，加宽同样成立（两颗是 flex 平分，不是只撑了第一颗）", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  await page.getByTestId("page-outline").click();
  await page.waitForTimeout(400);
  const 量 = await 量行(page);
  expect(量.颗[1].右).toBe(量.把手.左);
  expect(量.色条宽).toBeGreaterThanOrEqual(95);
});
