import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 143：同一篇文档，**阅读档与编辑档的排版必须逐项一致**。
 *
 * 她的原话：「阅读模式和编辑模式为什么行间距变了？下面的任务行为什么会换行」
 * （两张图是同一篇文档的两档）。
 *
 * 根因不是字号也不是行高，是 ProseMirror 多出来的一层**块**：
 * ① `table_cell` / `list_item` 的内容必须是块（`cellContent: "paragraph+"`、`list_item: "block+"`），
 *    于是每个格子、每一项里都包着一个 `<p>`，而 `.hp-doc p` 带着 `margin: 0 0 1em` ——
 *    阅读档的格子里是行内文字、没有这层段落，两边每行差出整整一个 1em
 *    （实测任务项 26px → 53px，表格行 39px → 54px）；
 * ② 任务项的 `toDOM` 是 `li > input + div`，那个 div 是块级 → **文字整块掉到方框下面一行**；
 *    圆点也没关：阅读档靠 `li.task-list-item` 关圆点，PM 渲染出来的是 `li[data-hp-task]`。
 *
 * 判据按**几何**比，不按 class 名比：两档 DOM 结构本来就不同，
 * 能比的是"第 n 个列表项多高、方框和首行是不是同一行、第 n 行表格多高"。
 */

const DOC = [
  "# 排版对照",
  "",
  "- [ ] 仓库地址已填进第 8 张图与首评（https://github.com/haiiik/MDSB）",
  "- [x] 8 张图按 01 到 08 顺序上传，正文里的 17.2 MB 与 1.0 秒要与图上一致，全篇不用那四个字",
  "  - [ ] 嵌套的一项",
  "",
  "普通列表：",
  "",
  "- 甲项",
  "- 乙项",
  "",
  "| 项 | 建议 |",
  "| :-- | :-- |",
  "| 封面 | 第 1 张，深绿底大字，信息流里对比度够，别再叠滤镜 |",
  "| 图序 | 01 封面 → 02 痛点 → 03 解法 |",
  "",
  "结尾段落。",
  "",
].join("\n");

type 测量 = {
  列表项: { 高: number; 有圆点: boolean; 方框y: number | null; 文字y: number }[];
  表格行: number[];
  段落高: number[];
};

/**
 * 量 `.hp-doc` 里的几何。两档都用同一套选择器：
 * `li` 的 rect、`li input` 的顶边、`li` 里**第一个文字节点**的顶边（Range 量，跨结构可比）。
 */
const 量 = (page: Page): Promise<测量> =>
  page.evaluate(() => {
    const 根 = document.querySelector(".hp-doc");
    if (!根) throw new Error("没有 .hp-doc");
    const 文字顶 = (li: Element): number | null => {
      const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      const t = w.nextNode();
      if (!t) return null;
      const r = document.createRange();
      r.selectNodeContents(t);
      return Math.round(r.getBoundingClientRect().top);
    };
    return {
      列表项: Array.from(根.querySelectorAll("li")).map((li) => ({
        高: Math.round(li.getBoundingClientRect().height),
        有圆点: getComputedStyle(li).listStyleType !== "none",
        方框y: li.querySelector("input[type=checkbox]")
          ? Math.round(li.querySelector("input[type=checkbox]")!.getBoundingClientRect().top)
          : null,
        文字y: 文字顶(li),
      })),
      表格行: Array.from(根.querySelectorAll("tr")).map((tr) => Math.round(tr.getBoundingClientRect().height)),
      // 顶层正文段落：两档的 DOM 层级不一样（编辑档多一层 .ProseMirror），
      // 所以按「不在格子里、不在列表项里」挑，而不是按 `.hp-doc > p` 挑
      段落高: Array.from(
        根.querySelectorAll("p:not(li p):not(td p):not(th p):not(div[data-hp-task] p")
      ).map((p) => Math.round(p.getBoundingClientRect().height)),
    };
  });

let path = "";

async function 打开并两档对照(page: Page) {
  path = "/demo/排版对照-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
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
  const 阅 = await 量(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(600);
  const 编 = await 量(page);
  return { 阅, 编 };
}

test("任务清单：两档每一项的行高一致，方框与首行在同一行，圆点关掉", async ({ page }) => {
  const { 阅, 编 } = await 打开并两档对照(page);
  expect(编.列表项.length).toBe(阅.列表项.length);
  // 前三项是任务清单（含一项嵌套），后两项是普通列表
  for (let i = 0; i < 3; i++) {
    expect(
      Math.abs(编.列表项[i].高 - 阅.列表项[i].高),
      `第 ${i + 1} 项高度两档不一致：阅读 ${阅.列表项[i].高} / 编辑 ${编.列表项[i].高}`
    ).toBeLessThanOrEqual(1);
    expect(编.列表项[i].有圆点, `第 ${i + 1} 项还留着圆点（方框 + 圆点两个标记）`).toBe(false);
    const 差 = Math.abs((编.列表项[i].方框y ?? 0) - (编.列表项[i].文字y ?? 0));
    expect(差, `第 ${i + 1} 项文字掉到方框下面一行（y 差 ${差}px）`).toBeLessThanOrEqual(4);
  }
});

test("普通列表项：两档高度一致（该留的项间距别被顺手清掉）", async ({ page }) => {
  const { 阅, 编 } = await 打开并两档对照(page);
  const 尾 = 阅.列表项.slice(3);
  const 尾编 = 编.列表项.slice(3);
  expect(尾编.map((x) => x.高)).toEqual(尾.map((x) => x.高));
  expect(尾.every((x) => x.高 > 0)).toBe(true);
  // 长文字那一项（任务清单第 2 项）两档折行数必须一样：不是阅读 2 行、编辑 3 行
  expect(编.列表项[1].高).toBe(阅.列表项[1].高);
  expect(阅.列表项[1].高).toBeGreaterThan(40);
});

test("表格：两档每一行的高度一致（格子内那层段落不许撑高行）", async ({ page }) => {
  const { 阅, 编 } = await 打开并两档对照(page);
  expect(编.表格行.length).toBe(阅.表格行.length);
  expect(编.表格行).toEqual(阅.表格行);
});

test("正文段落：两档高度一致（这条是反向守门，别把该留的间距也清掉了）", async ({ page }) => {
  const { 阅, 编 } = await 打开并两档对照(page);
  expect(编.段落高).toEqual(阅.段落高);
  expect(阅.段落高.length).toBeGreaterThan(0);
});
