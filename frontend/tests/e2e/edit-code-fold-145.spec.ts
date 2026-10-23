import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 145：她的原话「编辑模式源码内容默认收起，在如图位置新增编辑源码功能，
 * 点击后显示源码并把滚动条定位到源码位置」；图里红框 = 代码块工具条最右格。
 *
 * **口径（她 2026-10-22 钉死的，我第一版理解反了）**：
 * > 代码块不收，收的是既展示源码又通过其他方式展示的内容
 * 所以参与折叠的只有 **Mermaid 块**（图 = 另一种展示）与**块级公式**（排版结果 = 另一种展示）；
 * 普通代码块摊开显示、不给按钮。两类都还要 >3 行才收（一行的源码收起来只是多一次点击）。
 *
 * 其余规矩：
 * - 收起时工具条右端给「编辑源码」，点它 → 展开 + 光标进源码开头 + 把整块源码滚进视口；
 * - **光标进块就当场展开**（点露出的那几行、上下键走进来、点 Mermaid 预览都算）——
 *   光标在被 clipping 掉的 `pre` 里打字 = 看不见自己打的字，这是这条功能唯一的真陷阱；
 * - 展开后不自动收回；「收起」在展开态**一直给着**（149-B 改的，理由见下面那条用例的注释）；
 * - 折叠只裁可视高度，**不动 DOM 里的一个字**（有用例直接钉落盘字节）。
 *
 * 判据全按可见几何与真实打字，不按 class 名 —— 「看着收起了但点不进去」不算通过。
 */

const 三十行 = Array.from({ length: 30 }, (_, i) => `SELECT col_${i + 1} FROM t;`).join("\n");
const 图源码 = ["flowchart TD", ...Array.from({ length: 16 }, (_, i) => `  n${i} --> n${i + 1}`)].join("\n");
const 长公式 = [
  "\\begin{aligned}",
  "a &= 1 \\\\",
  "b &= 2 \\\\",
  "c &= 3 \\\\",
  "d &= 4",
  "\\end{aligned}",
].join("\n");

const 文档 = [
  "# 折叠对照",
  "",
  "```sql",
  三十行,
  "```",
  "",
  "```mermaid",
  图源码,
  "```",
  "",
  "$$",
  长公式,
  "$$",
  "",
  "结尾段落。",
  "",
].join("\n");

type 块状态 = { 折: boolean; 钮: string | null; 高: number; 在视口: boolean };

const 量块 = (page: Page, 定位: string): Promise<块状态> =>
  page.evaluate((sel) => {
    const box = document.querySelector<HTMLElement>(sel);
    if (!box) throw new Error(`没有 ${sel}`);
    // 必须限定**直接子元素**：Mermaid 那个块里，预览区的报错提示本身就是一个 `<pre>`
    // （`.hp-mermaidbox__error`），它在文档顺序里排在源码那块前面 ——
    // 用 `querySelector("pre")` 量到的是那个空提示框（高 0），整条判据就废了。
    const 源区 = box.querySelector<HTMLElement>(":scope > pre")!;
    const 钮 = box.querySelector<HTMLElement>(".hp-codebox__fold");
    const 容 = document.querySelector<HTMLElement>(".edit-pane__scroll")!.getBoundingClientRect();
    const r = 源区.getBoundingClientRect();
    return {
      折: box.dataset.folded === "1",
      钮: 钮 && !钮.hidden ? (钮.textContent ?? "").trim() : null,
      高: Math.round(r.height),
      在视口: r.top >= 容.top - 1 && r.top < 容.bottom,
    };
  }, 定位);

/** 三类块各自怎么找：语言标注 / mermaid 标记 / 公式块外框 */
const SQL = '.hp-codebox:has(pre[data-language="sql"])';
const 图 = '.hp-codebox[data-mermaid="1"]';
const 式 = ".hp-mathblock";

async function 打开(page: Page, 正文 = 文档) {
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

const 读盘 = (page: Page, path: string) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

test("普通代码块不收、不给按钮（她的口径：源码是它唯一的内容）", async ({ page }) => {
  await 打开(page);
  const s = await 量块(page, SQL);
  expect(s.折, "30 行的 sql 块被收起来了 —— 她明确说代码块不收").toBe(false);
  expect(s.钮).toBe(null);
  // 反向对照：同一篇里的 Mermaid 块要收，而且是**整段收走**（她：隐藏的再彻底一点）
  const m = await 量块(page, 图);
  expect(m.折, "Mermaid 的源码没跟着收起").toBe(true);
  expect(m.高, "收起后源码还占着高度（她要的是整段不显示，点了才展开）").toBe(0);
  expect(m.钮, "收起状态下没有「编辑源码」入口").toBe("编辑源码");
});



test("公式块：多行源码也收起（排版结果就是它的另一种展示）", async ({ page }) => {
  await 打开(page);
  const s = await 量块(page, 式);
  expect(s.折).toBe(true);
  expect(s.钮).toBe("编辑源码");
});

test("点「编辑源码」：源码显示出来、滚动条定位到那块源码、光标在里面能打字", async ({ page }) => {
  const path = await 打开(page);
  /*
   * 先把视图滚到「只剩工具条贴在视口下沿」—— 这才是她点这颗键的真实处境：
   * 收着的块很矮，滚到它时通常正好卡在屏幕最下面，一展开源码整段往屏幕外长。
   * 留 24px（只够看见工具条）而不是 80px：留 80px 时源码首行本来就在屏幕里，
   * 「滚没滚」这条判据量的是空气 —— 上一版栽得更彻底，它量的是 Playwright
   * 为了点到按钮自己滚的那 16px（问的是我自己，不是产品）。
   */
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(".edit-pane__scroll")!;
    const box = document.querySelector<HTMLElement>(sel)!;
    const c = s.getBoundingClientRect();
    s.scrollTop += box.getBoundingClientRect().top - c.top - (c.height - 24);
  }, 图);
  await page.waitForTimeout(150);
  const 前 = await 量块(page, 图);
  expect(前.在视口, "起点没设好：源码首行本来就在视口里，测不出定位").toBe(false);
  await page.locator(图 + " .hp-codebox__fold").click();
  await page.waitForTimeout(200);
  const 后 = await 量块(page, 图);
  expect(后.折, "点了编辑源码还是收起状态").toBe(false);
  expect(后.高, "展开后高度没变 = 源码没真的显示出来").toBeGreaterThan(前.高 * 3);
  expect(后.在视口, "展开后源码不在视口里，等于没定位").toBe(true);
  // 光标真的在源码里：直接打字能落进去
  await page.keyboard.type("%% 打的字 ");
  await page.keyboard.press("Control+s");
  expect(await 读盘(page, path)).toContain("%% 打的字 flowchart TD");
});

test("光标用方向键走进收起的源码：块当场展开（收起 ≠ 进不去）", async ({ page }) => {
  await 打开(page);
  expect((await 量块(page, 式)).折).toBe(true);
  // 源码整段收起后没有可点的地方（146-B），剩下的自然手势是从上面那段按 ↓ 走进来
  await page.locator(".ProseMirror p").first().click();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("ArrowDown");
    if ((await 量块(page, 式)).折 === false) break;
  }
  const s = await 量块(page, 式);
  expect(s.折, "方向键走进了收起的源码却没展开 = 看不见自己打的字").toBe(false);
  expect(s.高, "展开了却没高度").toBeGreaterThan(0);
});

test("展开之后不自己收回去；「收起」一直给着，点了收得回去（149-B）", async ({ page }) => {
  await 打开(page);
  await page.locator(图 + " .hp-codebox__fold").click();
  await page.waitForTimeout(150);
  await page.keyboard.type("x");
  const 打字后 = await 量块(page, 图);
  expect(打字后.折, "正在打字却被自动收回去了").toBe(false);
  /*
   * 149-B：这一格从「不给按钮」改成「给收起」。
   * 点「编辑源码」的第一件事就是把光标送进源码，于是刚展开的那一块**恰好是唯一不给「收起」的那一块** ——
   * 她 10-22 的原话「编辑源码如何关闭？」就是这么来的。
   * 不抽纸的办法不是藏键，是点下去先把光标挪出块（下面那条用例钉的就是这个）。
   */
  expect(打字后.钮, "光标还在块里就不给「收起」= 她把源码打开了却关不掉").toBe("收起");
  await page.locator(".ProseMirror p").last().click();
  await page.waitForTimeout(150);
  expect((await 量块(page, 图)).钮, "光标出去了还是没给「收起」入口").toBe("收起");
  await page.locator(图 + " .hp-codebox__fold").click();
  await page.waitForTimeout(150);
  expect((await 量块(page, 图)).折, "点了「收起」没收回去").toBe(true);
});

test("149-B：光标还泡在源码里就能点「收起」，收下去时光标跟着搬出块", async ({ page }) => {
  const path = await 打开(page);
  await page.locator(图 + " .hp-codebox__fold").click();
  await page.waitForTimeout(150);
  expect((await 量块(page, 图)).钮).toBe("收起");
  // 不挪光标，直接点收起
  await page.locator(图 + " .hp-codebox__fold").click();
  await page.waitForTimeout(200);
  const 后 = await 量块(page, 图);
  expect(后.折, "光标在块里时点「收起」没收回去（收起判据把光标算进去了，得先把它搬出去）").toBe(true);
  expect(后.高).toBe(0);
  /*
   * 收回去之后打字：字**不能**落进那块看不见的源码里。
   * 光标若还留在被 clipping 的 `pre` 里，这段输入就静默进了源码 —— 正是 145 那条
   * 「光标进块就展开」要防的事，收起时必须同样防住。
   */
  await page.keyboard.type("Z");
  await page.keyboard.press("Control+s");
  const 盘 = await 读盘(page, path);
  expect(盘, "收起后打的字落进了被藏起来的图源码里").not.toContain("Zflowchart");
  expect(盘).not.toContain("flowchartZ");
});

test("折叠不改字节：收起状态直接保存，落盘内容与不折叠一致", async ({ page }) => {
  const path = await 打开(page);
  expect((await 量块(page, 图)).折).toBe(true);
  expect((await 量块(page, 式)).折).toBe(true);
  await page.keyboard.press("Control+s");
  expect(await 读盘(page, path)).toBe(文档);
});

test("一行的图源码也整段收起（不再有「太短就不收」的门槛）", async ({ page }) => {
  const 短文 = ["# 一图", "", "```mermaid", "graph TD", "```", "", "正文。", ""].join("\n");
  const path = await 打开(page, 短文);
  const s = await 量块(page, 图);
  expect(s.折).toBe(true);
  expect(s.高, "两行源码也该整段藏起来").toBe(0);
  expect(s.钮).toBe("编辑源码");
  await page.keyboard.press("Control+s");
  expect(await 读盘(page, path)).toBe(短文);
});

test("语言从 sql 改成 mermaid：这块跟着收起 —— 折叠判据是现读的，不靠重建视图", async ({ page }) => {
  await 打开(page);
  expect((await 量块(page, SQL)).折).toBe(false);
  await page.locator(SQL + ' select[data-testid="pm-codelang"]').selectOption("mermaid");
  await page.waitForTimeout(400);
  const s = await 量块(page, 图);
  expect(s.折, "改成 mermaid 之后没跟着收起（110 起两种形态共用一个视图，判据必须现读）").toBe(true);
  expect(s.钮).toBe("编辑源码");
});
