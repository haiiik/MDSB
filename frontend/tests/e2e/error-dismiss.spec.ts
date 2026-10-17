import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 127：每条错误提示右上角都要有个叉，点它**只关当前这条**。
 *
 * 要钉住的两件事（都是她这句话里可验证的部分）：
 * ① 叉在**右边** —— 用 boundingBox 判左右，不靠人眼；
 * ② 关的是**这一条**，不是把提示机制哑掉 ——
 *    所以每条用例关掉后都要**再制造一次同样的错**，断言它还会报。
 *
 * 四类提示走的是两条不同的通路，各自都得覆盖：
 * - 正文提示条 / 底栏提示条 = Vue 的响应式状态（清 ref）；
 * - Mermaid 错误块 / 坏图占位卡 = 增强层直接建的 DOM（`addDismiss` 走行内 style）。
 *   后者是这次最容易假绿的地方：`hidden` 属性会被自己的 `display:inline-flex` 压过去，
 *   所以额外断言「 computed display === none」，而不是只看 `hidden`。
 */

const seed = (page: Page, path: string, content: string) =>
  page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, content]
  );

/**
 * 叉必须落在**这条提示自己的**右端（左边是消息正文）。
 * 底栏那条不要求贴到整条底栏的最右 —— 底栏右边还有字数、模式按钮，
 * 「关掉当前这个提示」的叉跟着消息走才说得通。
 */
async function assertOnRight(box: { x: number; width: number }, x: { x: number; width: number }): Promise<void> {
  expect(x.x + x.width).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(x.x).toBeGreaterThan(box.x + box.width * 0.5);
}

/** 关掉后「真的看不见」：display 必须是 none，光有 hidden 属性不算 */
const displayOf = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : "已移除";
  }, selector);

test("正文打开失败的提示条：叉在右边，点它这条就没了", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/缺失.md";
  });
  await page.getByTestId("open-button").click();

  const bar = page.getByTestId("open-error");
  await expect(bar).toContainText("不存在");
  await assertOnRight(
    (await bar.boundingBox())!,
    (await page.getByTestId("open-error-close").boundingBox())!
  );

  await page.getByTestId("open-error-close").click();
  await expect(bar).toHaveCount(0);

  // 没有哑掉：再打开一次不存在的文件，提示照旧出现
  await page.evaluate(() => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/缺失.md";
  });
  await page.getByTestId("open-button").click();
  await expect(bar).toContainText("不存在");
});

test("底栏自动保存失败的提示：叉只关底栏这条，下次真失败还会报", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "source");
  await page.waitForSelector(".cm-content");

  await page.getByTestId("open-settings").click();
  await page.getByTestId("setting-autosave").check();
  await page.getByTestId("settings-close").click();

  await page.evaluate(() => {
    (window as unknown as { __hpMockFailWrites?: string }).__hpMockFailWrites = "文件被另一个程序占用";
  });
  await page.locator(".cm-content").click();
  await page.keyboard.type("自动保存要失败的改动");

  const bar = page.getByTestId("status-error");
  await expect(bar).toContainText("占用");
  await assertOnRight((await bar.boundingBox())!, (await page.getByTestId("status-error-close").boundingBox())!);

  // 同时让正文也挂一条错误：叉必须各关各的，不许一按全清
  await page.evaluate(() => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/缺失.md";
  });
  await page.getByTestId("tab-open").click();
  const paneErr = page.getByTestId("open-error");
  await expect(paneErr).toContainText("不存在");

  await page.getByTestId("status-error-close").click();
  await expect(bar).toHaveCount(0);
  await expect(paneErr).toContainText("不存在");

  // 写失败后自动保存会被暂停（007 的口径），重新打开再改一次 —— 提示必须还能出现
  await page.getByTestId("open-settings").click();
  await page.getByTestId("setting-autosave").check();
  await page.getByTestId("settings-close").click();
  await page.locator(".cm-content").click();
  await page.keyboard.type("再改一处");
  await expect(bar).toContainText("占用");
});

/**
 * 一份文档里放**两个**坏图 + 一张好图 + 两个坏 Mermaid：
 * 关第一个必须只关掉第一个，第二个仍然挂着 —— 这才叫「关闭当前这个错误提示」。
 */
const TWO_ERRORS = [
  "# 两条提示",
  "",
  "```mermaid",
  "graph TD",
  "  A[第一条坏了 -->",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  B[第二条也坏了 -->",
  "```",
  "",
  "![好图](/demo/diagrams/arch.png)",
  "",
  "![坏的一](/demo/diagrams/不存在1.png)",
  "",
  "![坏的二](/demo/diagrams/不存在2.png)",
  "",
].join("\n");

test("阅读模式 Mermaid 错误块：关掉一个，另一个不动", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await seed(page, "/demo/两条提示.md", TWO_ERRORS);
  await page.getByTestId("tab-open").click();
  await expect(page.getByRole("heading", { name: "两条提示", level: 1 })).toBeVisible();

  const boxes = page.locator(".hp-mermaid--error");
  await expect(boxes).toHaveCount(2, { timeout: 15_000 });
  await expect(boxes.first().locator("pre code")).toContainText("第一条坏了");
  await expect(boxes.nth(1).locator("pre code")).toContainText("第二条也坏了");

  // 同一个错误块里只有一个叉，且在右上角
  await expect(boxes.first().locator(".hp-dismiss")).toHaveCount(1);
  const box = await boxes.first().boundingBox();
  const x = await boxes.first().locator(".hp-dismiss").boundingBox();
  expect(x!.x + x!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  expect(x!.y).toBeLessThan(box!.y + box!.height / 2);

  await boxes.first().locator(".hp-dismiss").click();
  await expect(boxes.first()).toBeHidden();
  expect(await displayOf(page, ".hp-mermaid--error")).toBe("none");

  // 第二条还在，正文其它内容也不受牵连（两个坏块 + 两张坏图，关掉一个只剩一个）
  await expect(boxes.nth(1)).toBeVisible();
  await expect(boxes.nth(1).locator("pre code")).toContainText("第二条也坏了");
  await expect(boxes).toHaveCount(2); // DOM 里没删，只是这一条被藏起来
  await expect(page.getByRole("heading", { name: "两条提示", level: 1 })).toBeVisible();
});

test("坏图占位卡：关掉这张卡，另一张与正常图都不受影响", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await seed(page, "/demo/两条提示.md", TWO_ERRORS);
  await page.getByTestId("tab-open").click();

  const broken = page.locator(".hp-img-broken");
  await expect(broken).toHaveCount(2);
  await expect(broken.first().locator(".hp-img-broken__path")).toContainText("不存在1.png");

  const card = await broken.first().boundingBox();
  const x = await broken.first().locator(".hp-dismiss").boundingBox();
  expect(x!.x + x!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);

  await broken.first().locator(".hp-dismiss").click();
  await expect(broken.first()).toBeHidden();
  expect(await displayOf(page, ".hp-img-broken")).toBe("none");

  await expect(broken.nth(1)).toBeVisible();
  await expect(broken.nth(1)).toContainText("不存在2.png");
  await expect(page.locator("img.hp-img")).toHaveCount(1);
});

test("编辑模式原地预览的错误：关掉后把源码改坏会重新报", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  // 先给一份**能渲染**的源码：这样「重新报」只能来自我后面改坏它，而不是它一直错着
  await seed(page, "/demo/原地预览报错.md", "# 流程\n\n```mermaid\ngraph TD\n  A[受理] --> B[审批]\n```\n");
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");

  const preview = page.getByTestId("pm-mermaid-preview");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 15_000 });

  // 改坏：行尾补一个不闭合的方括号（flowchart 语法必然报错）。
  // 不按键回车 —— 在 code_block 里回车是「换行」还是「拆块」取决于 keymap，
  // 拆成两块会让这份 Mermaid 源码反而恢复正常，用例就测不到东西了。
  await placeCaret(page, 'pre[data-language="mermaid"] code', -1);
  await page.keyboard.type("  C[没收尾");
  await expect(preview).toHaveAttribute("data-state", "error", { timeout: 15_000 });

  const err = preview.locator(".hp-mermaidbox__error");
  await expect(err).toContainText("Mermaid 语法错误");
  await assertOnRight(
    (await preview.boundingBox())!,
    (await preview.locator(".hp-dismiss").boundingBox())!
  );

  // 点叉：只把这条提示收起来。
  // 顺带钉住 126 那个坑 —— 叉在预览区里，预览区的 mousedown 本来会把光标抢进源码并 scrollIntoView，
  // 现在点在叉上不该有这动作（收提示就是收提示，视图不许乱跳）。
  const scrollBefore = await page.locator(".edit-pane__scroll").evaluate((el) => el.scrollTop);
  await preview.locator(".hp-dismiss").click();
  expect(await displayOf(page, ".hp-mermaidbox__error")).toBe("none");
  expect(await page.locator(".edit-pane__scroll").evaluate((el) => el.scrollTop)).toBe(scrollBefore);

  // 机制没哑：源码又变了、方括号仍然没闭合，提示必须重新出现。
  // 同步点是「新字符进了源码」而不是「提示条里还有 Mermaid 语法错误」——
  // 后者在旧的隐藏块上就成立，会在重渲落地之前抢跑（实测这样会假红）。
  await placeCaret(page, 'pre[data-language="mermaid"] code', -1);
  await page.keyboard.type(" 依然没闭合");
  await expect(page.locator('pre[data-language="mermaid"] code')).toContainText("依然没闭合");
  await expect
    .poll(() => displayOf(page, ".hp-mermaidbox__error"), { timeout: 15_000 })
    .toBe("block");
  await expect(err).toContainText("Mermaid 语法错误");
});
