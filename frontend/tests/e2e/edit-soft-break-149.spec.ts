import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 149-A（她 10-22：「编辑模式为什么会有奇怪的换行？」，两张同篇文档的截图）：
 * 源码里**两行、中间没空行**的那一段，阅读档是一行，编辑档断成两行。
 *
 * 根因不在我们的样式里，在 prosemirror-view 自带的那条
 * `.ProseMirror { white-space: pre-wrap; white-space: break-spaces }`
 * （后一句是前一句的降级写法，Chrome 认 `break-spaces`）。它让**源码里的软换行真的换了一行**，
 * 还让行尾空白各占一格。探针实测（100% 缩放、同一篇）：
 * 那一段阅读档 26px / 1 个文字矩形，编辑档 53px / 3 个文字矩形。
 *
 * 修法是把编辑档的 `white-space` 拨回 HTML 默认的 `normal`（= 阅读档的口径）。
 * **只改显示，不动文档**：PM 的 `whitespace` 解析规则本来就是 `normal`
 * （脚注定义块要显式 `code: true` 才保得住续行换行，正是同一件事的反面）。
 *
 * 判据按几何（行高 + 文字矩形数），并按她的真实动作补两条反向护栏：
 * ① 软换行不许把落盘内容改了；② **硬换行**（行尾两个空格）两档都得照旧换行 ——
 * 这条防的是"把换行一律抹平"这种把功能修没的解法。
 */

const 软换行段 = ["段落甲第一行", "段落甲第二行（源码里是软换行）"].join("\n");
const 硬换行段 = ["硬换行上半  ", "硬换行下半"].join("\n");

const DOC = [
  "# 换行对照",
  "",
  "| PRD 提交日期 | 2026-10-21 | | 复杂度级别 | L3（模块级） |",
  "",
  软换行段,
  "",
  硬换行段,
  "",
  "| 变更时间 | 变更内容 | 变更提出部门与理由 | 修改人 | 版本号 |",
  "| :-- | :-- | :-- | :-- | :-- |",
  "| 2026-10-21 | 3.0 基线版本 | v3.x 逐轮修改记录清空，转为需求基线（含 T+1 更新频率、知会海能Work通知 F47、会签口径入待决、恢复「点击办理」、关注 / 知会卡「点击查看」等本轮定稿） | 张三 | v3.0 |",
  "",
  "结尾段落。",
  "",
].join("\n");

type 段 = { 文本: string; 高: number; 矩形: number; 空白: string };

/** 顶层正文段落（格子与列表项里那层归 143 管，这里只量正文段） */
const 量段 = (page: Page): Promise<段[]> =>
  page.evaluate(() => {
    const 根 = document.querySelector(".hp-doc");
    if (!根) throw new Error("没有 .hp-doc");
    return Array.from(根.querySelectorAll<HTMLElement>("p:not(li p):not(td p):not(th p)"))
      .filter((p) => (p.textContent ?? "").trim() !== "")
      .map((p) => {
        const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let 矩形 = 0;
        let t: Node | null;
        while ((t = w.nextNode())) {
          const r = document.createRange();
          r.selectNodeContents(t);
          矩形 += Array.from(r.getClientRects()).filter((x) => x.height > 0).length;
        }
        return {
          文本: p.textContent ?? "",
          高: Math.round(p.getBoundingClientRect().height),
          矩形,
          空白: getComputedStyle(p).whiteSpace,
        };
      });
  });

const 量列宽 = (page: Page) =>
  page.evaluate(() => {
    const tb = document.querySelector(".hp-doc table") as HTMLTableElement | null;
    if (!tb) throw new Error("没有表格");
    return {
      表宽: Math.round(tb.getBoundingClientRect().width),
      列宽: Array.from(tb.rows[0].cells).map((c) => Math.round(c.getBoundingClientRect().width)),
      行高: Array.from(tb.rows).map((r) => Math.round(r.getBoundingClientRect().height)),
    };
  });

const 找 = (段表: 段[], 前缀: string): 段 => {
  const s = 段表.find((x) => x.文本.startsWith(前缀));
  if (!s) throw new Error(`没有以「${前缀}」开头的段落`);
  return s;
};

let path = "";

async function 打开两档(page: Page): Promise<{ 阅: 段[]; 编: 段[] }> {
  path = "/demo/换行对照-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
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
  await expect(page.getByTestId("document-root")).toBeVisible();
  const 阅 = await 量段(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(400);
  return { 阅, 编: await 量段(page) };
}

const 读盘 = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

test("软换行那段：两档同高、各只有一行（编辑档不再自己断行）", async ({ page }) => {
  const { 阅, 编 } = await 打开两档(page);
  const a = 找(阅, "段落甲第一行");
  const b = 找(编, "段落甲第一行");
  expect(a.矩形, "阅读档这段本来就不是一个矩形，探针前提变了").toBe(1);
  expect(b.矩形, "编辑档这段还是断成两行（break-spaces 没被拨回来）").toBe(1);
  expect(b.高, `两档行高不一致：阅读 ${a.高} / 编辑 ${b.高}`).toBe(a.高);
  // 那一行「| PRD 提交日期 |…| 复杂度级别 |…」是她截图里最扎眼的一条
  const c = 找(编, "| PRD 提交日期");
  expect(c.矩形, "竖线那行在编辑档断成了两行").toBe(1);
  expect(c.高).toBe(找(阅, "| PRD 提交日期").高);
});

test("编辑档的段落不再继承 break-spaces（判据测的是这条口径本身）", async ({ page }) => {
  const { 编 } = await 打开两档(page);
  expect(找(编, "段落甲第一行").空白, "计算样式还是 break-spaces = 根因没动").toBe("normal");
});

test("硬换行（行尾两个空格）两档都照旧换行：修的是软换行，不是把换行抹平", async ({ page }) => {
  const { 阅, 编 } = await 打开两档(page);
  const a = 找(阅, "硬换行上半");
  const b = 找(编, "硬换行上半");
  expect(a.高, "阅读档这条前提变了（硬换行没换行？）").toBeGreaterThan(30);
  expect(b.高, `编辑档硬换行没换行：${b.高} vs 阅读 ${a.高}`).toBe(a.高);
});

test("表格列宽两档一致（white-space 改动不许把格子撑歪）", async ({ page }) => {
  await 打开两档(page);
  const 阅 = await 量列宽(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(400);
  const 编 = await 量列宽(page);
  expect(编.列宽, `两档列宽对不上：阅读 ${阅.列宽} / 编辑 ${编.列宽}`).toEqual(阅.列宽);
  expect(编.行高).toEqual(阅.行高);
  expect(阅.列宽.length).toBe(5);
});

test("软换行照旧落盘：两行还是两行，一个字节没被显示层带走", async ({ page }) => {
  await 打开两档(page);
  await page.keyboard.press("Control+s");
  const 盘 = await 读盘(page);
  expect(盘, "保存后文件与源文件不一致（保真口径）").toBe(DOC);
  expect(盘).toContain(软换行段);
});
