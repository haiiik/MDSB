import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 147：她「阅读模式那个地方也应该有个栏，即使空着，也能让阅读模式和编辑模式的初始高度一致」。
 *
 * 144 修的是**块内**那 1.6em 上边距；这一条是**容器**那一行：
 * 编辑档顶上有条工具栏，阅读档以前没有，于是同一篇文档切个模式，正文整体上下跳一行。
 * 判据量的就是她真正看到的那件事：**正文第一行在窗口里的绝对 y，两档必须一样**。
 * （144 那条量的是相对 `.hp-doc` 的位置，看不见这一行 —— 两条各管一半。）
 */

const 文档 = ["# 高度对照", "", "第一段正文。", "", "第二段正文。", ""].join("\n");

const 首行绝对y = (page: Page) =>
  page.evaluate(() => {
    const 根 = document.querySelector(".hp-doc");
    if (!根) throw new Error("没有 .hp-doc");
    const w = document.createTreeWalker(根, NodeFilter.SHOW_TEXT);
    let t: Node | null;
    for (t = w.nextNode(); t && !/\S/.test(t.nodeValue ?? ""); t = w.nextNode());
    if (!t) throw new Error("没有文字");
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 1);
    return Math.round(r.getBoundingClientRect().top);
  });

test("两档正文第一行在窗口里的绝对高度一致（阅读档补了一条同高的空栏）", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(([p, c]) => {
    (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, ["/demo/高度对照.md", 文档]);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  const 阅 = await 首行绝对y(page);
  // 那条空栏在阅读档里是看得见的（她要的就是"有个栏"），但没有按钮
  await expect(page.getByTestId("read-toolbar-ghost")).toBeVisible();
  expect(await page.getByTestId("read-toolbar-ghost").locator("button").count()).toBe(0);

  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(400);
  const 编 = await 首行绝对y(page);
  expect(编, `阅读档首行在 ${阅}px、编辑档在 ${编}px（差 ${编 - 阅}px = 那一行工具栏）`).toBe(阅);
});

test("两档来回切，正文第一行不该跳", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(([p, c]) => {
    (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, ["/demo/高度对照2.md", 文档]);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  const 起点 = await 首行绝对y(page);
  for (const 档 of ["edit", "read", "edit", "read"] as const) {
    await setMode(page, 档);
    await page.waitForTimeout(400);
    const 现 = await 首行绝对y(page);
    expect(Math.abs(现 - 起点), `切到 ${档} 档时正文第一行跳了 ${现 - 起点}px`).toBeLessThanOrEqual(1);
  }
});
