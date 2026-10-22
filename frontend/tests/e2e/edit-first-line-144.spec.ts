import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 144：她的原话「阅读模式首行与编辑模式对齐」。
 *
 * 根因是一条选择器在编辑档**没人命中**：
 * `reading.css` 的 `.hp-doc > *:first-child { margin-top: 0 }` 靠「首个块是 .hp-doc 的亲儿子」成立，
 * 而编辑档的 DOM 是 `.hp-doc > .hp-edit > .ProseMirror > 块`，中间多了一层挂载点 ——
 * 于是 `.hp-edit`（一个不带外边距的 div）被当成了首子元素，
 * 真正的第一块（标题带 `margin: 1.6em 0 0.6em`）的那 1.6em 没被抹掉，整篇往下挪。
 *
 * 判据按几何：量 `.hp-doc` 里**第一个文字节点**的首行顶边，减去 `.hp-doc` 自己的顶边，
 * 两档必须相等。选「第一个文字节点」而不是「第一个块」，是因为两档的块层级本来就不一样，
 * 而"眼睛看到的正文第一行在哪儿"才是她说的那件事。
 *
 * 三种开头都要管：标题、普通段落、以任务清单开头 —— 只修标题那条等于猜。
 */

type 首行 = { 相对顶: number; 类名: string };

async function 量首行(page: Page): Promise<首行> {
  return page.evaluate(() => {
    const 根 = document.querySelector(".hp-doc");
    if (!根) throw new Error("没有 .hp-doc");
    const w = document.createTreeWalker(根, NodeFilter.SHOW_TEXT);
    let t: Node | null;
    // 跳过空白文本节点（编辑档的挂载点里可能夹着占位的换行）
    for (t = w.nextNode(); t && !/\S/.test(t.nodeValue ?? ""); t = w.nextNode());
    if (!t) throw new Error("文档里没有文字");
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, Math.min(1, (t.nodeValue ?? "").length));
    const 块 = (t.parentElement ?? 根).closest("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table")!;
    return {
      相对顶: Math.round(r.getBoundingClientRect().top - 根.getBoundingClientRect().top),
      类名: 块 ? 块.tagName.toLowerCase() : "?",
    };
  });
}

async function 两档对照(page: Page, 正文: string) {
  const path = "/demo/首行对照-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, 正文]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  const 阅 = await 量首行(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.waitForTimeout(400);
  const 编 = await 量首行(page);
  return { 阅, 编 };
}

test("以标题开头：两档正文第一行的顶边一致", async ({ page }) => {
  const { 阅, 编 } = await 两档对照(page, "# 首行对照\n\n一段正文。");
  expect(编.类名).toBe(阅.类名);
  expect(编.相对顶, `阅读档首行在 ${阅.相对顶}px、编辑档在 ${编.相对顶}px`).toBe(阅.相对顶);
});

test("以段落开头：两档正文第一行的顶边一致", async ({ page }) => {
  const { 阅, 编 } = await 两档对照(page, "一段正文。\n\n# 次级标题");
  expect(编.相对顶, `阅读档首行在 ${阅.相对顶}px、编辑档在 ${编.相对顶}px`).toBe(阅.相对顶);
});

test("以任务清单开头：两档正文第一行的顶边一致", async ({ page }) => {
  const { 阅, 编 } = await 两档对照(page, "- [ ] 买牛奶\n- [x] 交周报");
  expect(编.相对顶, `阅读档首行在 ${阅.相对顶}px、编辑档在 ${编.相对顶}px`).toBe(阅.相对顶);
});
