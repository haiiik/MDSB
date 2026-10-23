import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 150（她 10-22：「编辑模式的位置，切换到阅读模式后仍对应不上，你现在是怎么找齐的？」）：
 * 换档定位补上**块内偏移**。
 *
 * 140 那套锚点只有**块级**精度：键取「视口顶端那一块」textContent 的开头，
 * 落点是「把这块顶边贴到视口上沿」。停在普通段落里没问题（一段就一两行），
 * 可一旦停在**比屏幕还高的一块**里 —— 60 行的表格、长引用、大代码块 ——
 * 整块就被当成一个坐标，切过去只能回到块首。
 *
 * 修前实测（同一篇文档、两档内容高都是 3732）：
 * 编辑档停在表格第 28 行（scrollTop 1757）→ 阅读档落到 648，**差 1109px，落回表头**。
 * 她那份 PRD 全是长表格，所以天天撞这一条。
 *
 * 判据按**「视口上沿那一行是哪一行」**比，不按 scrollTop 比 ——
 * 三档 scrollTop 本来就不该相等（140 的立论），能比的是内容位置。
 */

const 段 = (n: number, 起 = 1): string =>
  Array.from({ length: n }, (_, i) => `铺垫 ${起 + i} ${"字".repeat(40)}`).join("\n\n");

const 高表格 = [
  "| 编号 | 名称 | 说明 |",
  "| :-- | :-- | :-- |",
  ...Array.from({ length: 60 }, (_, i) => `| ${i + 1} | 名称${i + 1} | ${"要".repeat(40)} |`),
].join("\n");

const DOC = ["# 换档落在哪一行", "", 段(10), "", "## 一张长表", "", 高表格, "", "## 表后", "", 段(10, 11), ""].join(
  "\n"
);

/**
 * 视口上沿（+12px 那条线）压着的是第几行表格、哪一段铺垫，
 * 以及**离「目标行」的行顶还差多少 px**（带符号；0 = 正好压在那一行的上沿）。
 *
 * 为什么量 px 而不只问"是哪一行"：落点按构造会把那一行的**上沿正好放在线上**，
 * 于是"这一行算上面还是算下面"只差一个取整，按行号判会误判成偏差。
 */
const 顶端 = (page: Page, 目标行 = -1) =>
  page.evaluate((i) => {
    const 容 = document.querySelector(".pane__scroller, .edit-pane__scroll") as HTMLElement;
    const 根 = document.querySelector(".hp-doc") as HTMLElement;
    if (!容 || !根) throw new Error("没有容器");
    const 线 = 容.getBoundingClientRect().top + 12;
    const 行 = Array.from(根.querySelectorAll("tr"));
    let 表行 = -1;
    行.forEach((tr, k) => {
      const r = tr.getBoundingClientRect();
      if (r.bottom > 线 && 表行 < 0 && r.top < 线) 表行 = k;
    });
    const w = document.createTreeWalker(根, NodeFilter.SHOW_TEXT);
    let 文字 = "";
    let 最小 = Infinity;
    let t: Node | null;
    while ((t = w.nextNode())) {
      const r = document.createRange();
      r.selectNodeContents(t);
      for (const rect of Array.from(r.getClientRects())) {
        if (rect.height <= 0 || rect.bottom <= 线) continue;
        if (rect.top < 最小) {
          最小 = rect.top;
          文字 = (t.textContent ?? "").trim().slice(0, 12);
        }
      }
    }
    const 差 = i >= 0 && 行[i] ? Math.round(行[i].getBoundingClientRect().top - 线) : null;
    return { 表行, 文字, 差, 滚: Math.round(容.scrollTop) };
  }, 目标行);

/** 在当前档把「第 n 行表格」滚到视口上沿 */
const 滚到表格行 = (page: Page, n: number) =>
  page.evaluate((i) => {
    const 容 = document.querySelector(".pane__scroller, .edit-pane__scroll") as HTMLElement;
    const 根 = document.querySelector(".hp-doc") as HTMLElement;
    const tr = Array.from(根.querySelectorAll("tr"))[i];
    if (!tr) throw new Error("没有第 " + i + " 行");
    容.scrollTop += tr.getBoundingClientRect().top - 容.getBoundingClientRect().top - 12;
  }, n);

async function 打开(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    ["/demo/换档落在哪一行.md", DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

for (const [名, 目标行] of [
  ["编辑 → 阅读（表格中段）", 28],
  ["编辑 → 阅读（表格后段）", 52],
] as const) {
  test(名 + "：还停在同一行，不回表头", async ({ page }) => {
    test.setTimeout(180_000);
    await 打开(page);
    await setMode(page, "edit");
    await page.waitForSelector(".ProseMirror");
    await page.waitForTimeout(600);
    await 滚到表格行(page, 目标行);
    await page.waitForTimeout(400);
    const 起 = await 顶端(page, 目标行);
    expect(Math.abs(起.差!), "起点没设好：视口上沿不在目标行上沿").toBeLessThanOrEqual(2);

    await setMode(page, "read");
    await page.waitForTimeout(1_200);
    const 落 = await 顶端(page, 目标行);
    console.log(`150 ${名}：滚 ${起.滚}→${落.滚}，离目标行顶 ${落.差}px`);
    // 一行 ≈ 40px。修前这里是 **1109px**（落回表头），修后要求落回同一行内
    expect(Math.abs(落.差!), `换档后离目标行顶 ${落.差}px（修前实测 1109）`).toBeLessThanOrEqual(40);
  });
}

test("阅读 → 编辑 → 阅读 来回走一圈，仍停在同一行", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  await 滚到表格行(page, 35);
  await page.waitForTimeout(400);
  const 起 = await 顶端(page, 35);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(900);
  const 中 = await 顶端(page, 35);
  await setMode(page, "read");
  await page.waitForTimeout(1_200);
  const 落 = await 顶端(page, 35);
  console.log(`150 来回一圈：离目标行顶 编辑 ${中.差}px / 回到阅读 ${落.差}px`);
  expect(Math.abs(中.差!), `编辑档这一跳就偏了 ${中.差}px`).toBeLessThanOrEqual(40);
  expect(Math.abs(落.差!), `绕一圈回来偏了 ${落.差}px`).toBeLessThanOrEqual(40);
});

test("源码档同样按行落（CM 的坐标走 lineBlockAt，不是 DOM rect）", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(600);
  await 滚到表格行(page, 40);
  await page.waitForTimeout(400);
  const 起 = await 顶端(page, 40);
  await setMode(page, "source");
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(1_200);
  await setMode(page, "read");
  await page.waitForTimeout(1_200);
  const 落 = await 顶端(page, 40);
  console.log(`150 过源码档一跳：滚 ${起.滚}→${落.滚}，离目标行顶 ${落.差}px`);
  expect(Math.abs(落.差!), `过了源码档一跳偏了 ${落.差}px`).toBeLessThanOrEqual(40);
});

test("回归护栏：停在普通段落里还是准的（140 那条没被改坏）", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const 容 = document.querySelector(".edit-pane__scroll") as HTMLElement;
    容.scrollTop = 300;
  });
  await page.waitForTimeout(400);
  const 起 = await 顶端(page);
  expect(起.表行, "这条测的是段落处境，起点却落在表格里了").toBe(-1);
  await setMode(page, "read");
  await page.waitForTimeout(1_200);
  const 落 = await 顶端(page);
  expect(落.文字, `段落处境换档后文字对不上：起「${起.文字}」/ 落「${落.文字}」`).toBe(起.文字);
});
