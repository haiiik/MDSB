import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 145：她的原话「编辑模式源码内容默认收起，在如图位置新增编辑源码功能，
 * 点击后显示源码并把滚动条定位到源码位置」。
 *
 * 口径（阅读档早就有折叠，这一颗是把同一个动作接到编辑档，且**不能挡住打字**）：
 * - 编辑档的围栏代码块**默认收起**，只露前若干行；
 * - 收起时工具条上出现「编辑源码」，点它 → 展开 + 光标进源码开头 + 视图滚到那块源码；
 * - **光标进到块里就必须展开**（点收着的那几行、上下键走进来都算）——
 *   光标在一个 clipping 掉的 `pre` 里打字 = 看不见自己打的字，这是这条功能唯一真正的陷阱；
 * - 展开之后不自动收回去（她正在看代码，突然收走等于把活儿抢了），
 *   要收由她点「收起」，而**光标还在块里时不给这个按钮**；
 * - 折叠只是 CSS（max-height + mask），**不动 DOM 里的一个字**，所以落盘字节与阅读档都不受影响。
 *
 * 判据全按可见几何与真实打字，不按 class 名 —— 「看着收起了但点不进去」不算通过。
 */

/** 30 行代码 + 前面一堆正文，把代码块顶到首屏之外，才能测出「滚动条定位」 */
const 长码 = Array.from({ length: 30 }, (_, i) => `SELECT col_${i + 1} FROM t;`).join("\n");
const 长文档 = [
  "# 折叠对照",
  "",
  ...Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段正文，用来把代码块顶出首屏。`),
  "",
  "```sql",
  长码,
  "```",
  "",
  "代码块之后的段落。",
  "",
].join("\n");

const 短文档 = "# 短码\n\n```sql\nSELECT 1;\n```\n\n正文。\n";

const 状态 = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".hp-codebox");
    if (!box) throw new Error("没有代码块");
    const pre = box.querySelector<HTMLElement>("pre")!;
    const btn = box.querySelector<HTMLElement>(".hp-codebox__fold");
    const 滚动 = document.querySelector<HTMLElement>(".edit-pane__scroll")!;
    const r = pre.getBoundingClientRect();
    const c = 滚动.getBoundingClientRect();
    return {
      收起: box.dataset.folded === "1",
      按钮: btn ? (btn.hidden ? null : (btn.textContent ?? "").trim()) : null,
      露出行高: Math.round(pre.getBoundingClientRect().height),
      全高: (() => {
        // 临时按展开状态量一次，量完立刻还原（不能让判据改动被测对象）
        const 原 = box.dataset.folded;
        box.dataset.folded = "0";
        const h = Math.round(pre.getBoundingClientRect().height);
        box.dataset.folded = 原 ?? "0";
        return h;
      })(),
      源码顶: Math.round(r.top - c.top),
      在视口内: r.top >= c.top - 1 && r.top < c.bottom,
      scrollTop: Math.round(滚动.scrollTop),
    };
  });

async function 打开(正文: string, page: Page) {
  const path = "/demo/折叠-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
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
  await setMode(page, "edit");
  await page.waitForSelector(".hp-codebox");
  await page.waitForTimeout(300);
  return path;
}

test("长代码块：编辑档默认收起，工具条上是「编辑源码」", async ({ page }) => {
  await 打开(长文档, page);
  const s = await 状态(page);
  expect(s.收起, "编辑档的长代码块没默认收起").toBe(true);
  expect(s.按钮, "收起状态下没有「编辑源码」入口").toBe("编辑源码");
  expect(s.露出行高, `收起后仍然占了 ${s.露出行高}px`).toBeLessThan(s.全高);
});

test("点「编辑源码」：源码显示出来、滚动条定位到那块源码、光标在里面能打字", async ({ page }) => {
  const path = await 打开(长文档, page);
  /*
   * 先把视图滚到「只剩工具条那一行贴在视口下沿」—— 这才是她点这颗键的真实处境：
   * 收着的块很矮，滚到它时通常正好卡在屏幕最下面，一展开，源码整段往屏幕外长。
   * 留 24px（只够看见工具条）而不是 80px：留 80px 时源码首行本来就在屏幕里，
   * 「滚没滚」这条判据量的是空气 —— 上一版还栽得更彻底，它量的是 Playwright
   * 为了点到按钮自己滚的那 16px（问的是我自己，不是产品）。
   */
  await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>(".edit-pane__scroll")!;
    const box = document.querySelector<HTMLElement>(".hp-codebox")!;
    const c = s.getBoundingClientRect();
    s.scrollTop += box.getBoundingClientRect().top - c.top - (c.height - 24);
  });
  await page.waitForTimeout(150);
  const 前 = await 状态(page);
  expect(前.在视口内, "起点没设好：源码首行本来就在视口里，测不出定位").toBe(false);
  await page.locator(".hp-codebox__fold").click();
  await page.waitForTimeout(200);
  const 后 = await 状态(page);
  expect(后.收起, "点了编辑源码还是收起状态").toBe(false);
  expect(后.露出行高).toBe(后.全高);
  expect(后.scrollTop, `展开后源码往屏幕外长了，视图却没跟着走（前 ${前.scrollTop} / 后 ${后.scrollTop}，源码顶相对容器 ${后.源码顶}）`).toBeGreaterThan(
    前.scrollTop
  );
  expect(后.在视口内, "展开后源码不在视口里，等于没定位").toBe(true);
  // 光标真的在源码里：直接打字能落进去
  await page.keyboard.type("-- 打的字 ");
  await page.keyboard.press("Control+s");
  const saved = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );
  expect(saved).toContain("-- 打的字 SELECT col_1 FROM t;");
});

test("收起时点露出来的那几行：光标进得来、块当场展开", async ({ page }) => {
  await 打开(长文档, page);
  expect((await 状态(page)).收起).toBe(true);
  await page.locator(".hp-codebox > pre").click({ position: { x: 40, y: 8 } });
  await page.waitForTimeout(200);
  expect((await 状态(page)).收起, "点在收起的代码块上却没展开，等于看不见自己打的字").toBe(false);
});

test("展开之后不自己收回去；光标离开后才给「收起」", async ({ page }) => {
  await 打开(长文档, page);
  await page.locator(".hp-codebox__fold").click();
  await page.waitForTimeout(150);
  await page.keyboard.type("x");
  const 打字后 = await 状态(page);
  expect(打字后.收起, "正在打字却被自动收回去了").toBe(false);
  expect(打字后.按钮, "光标还在块里却给了「收起」按钮").toBe(null);
  // 光标走到块外面（末尾那段正文）
  await page.locator(".ProseMirror p").last().click();
  await page.waitForTimeout(150);
  expect(await 状态(page).then((s) => s.按钮), "光标出去了还是没给「收起」入口").toBe("收起");
});

test("短代码块不收起、不给按钮（别为一行代码挡路）", async ({ page }) => {
  await 打开(短文档, page);
  const s = await 状态(page);
  expect(s.收起, "三行以内的代码块被收起来了").toBe(false);
  expect(s.按钮).toBe(null);
});

test("折叠不改字节：收起状态直接保存，落盘内容与不折叠一致", async ({ page }) => {
  const path = await 打开(长文档, page);
  expect((await 状态(page)).收起).toBe(true);
  await page.keyboard.press("Control+s");
  const saved = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );
  expect(saved).toBe(长文档);
});

test("Mermaid 块：源码收起，点预览照样进源码（110 的点开即改不能被折叠挡住）", async ({ page }) => {
  const 边 = Array.from({ length: 16 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n");
  await 打开(`# 图\n\n\`\`\`mermaid\nflowchart TD\n${边}\n\`\`\`\n`, page);
  expect((await 状态(page)).收起, "Mermaid 的源码没跟着收起").toBe(true);
  await page.getByTestId("pm-mermaid-preview").click();
  await page.waitForTimeout(200);
  expect((await 状态(page)).收起, "点预览没把源码展开").toBe(false);
});
