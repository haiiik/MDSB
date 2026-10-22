import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 110：Mermaid 点开即改、原地重绘（US-31 / D2 的唯一硬验收）。
 *
 * 判据不靠人眼看截图：断言 SVG 里的**节点文字**随源码变化，
 * 这才证明「改一行图真的重绘了」而不是只重排了源码。
 */

const PATH = "/demo/图示边界.md";

const GOOD = "# 流程\n\n```mermaid\ngraph TD\n  A[单据受理] --> B[形式审查]\n```\n\n正文不动。\n";
const BROKEN = "# 流程\n\n```mermaid\ngraph TD\n  A[单据受理 -->\n```\n\n正文不动。\n";

async function seedAndOpen(page: Page, doc: string) {
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, doc]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await page.waitForSelector(".hp-codebox");
  /*
   * 145 之后 Mermaid 的源码**默认整段收起**（她：「隐藏的再彻底一点，点了编辑源码再展开」），
   * 而这一份用例钉的是 110 那件事 ——「点开即改、原地重绘」，前提是源码看得见点得进。
   * 所以这里先把源码展开（收起与展开本身由 `edit-code-fold-145.spec.ts` 那 8 条管，不重复）。
   */
  const 展开键 = page.locator('[data-testid="pm-code-fold"]');
  if (await 展开键.count()) await 展开键.first().click();
  await page.waitForTimeout(150);
}

const preview = (page: Page) => page.getByTestId("pm-mermaid-preview");

async function savedOf(page: Page): Promise<string> {
  return page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );
}

test("编辑模式把 Mermaid 渲成图，点开源码可改（145 后源码默认收起）", async ({ page }) => {
  await seedAndOpen(page, GOOD);

  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toHaveAttribute("data-state", "done");
  await expect(preview(page).locator("svg")).toBeVisible();
  // 节点文字来自图本身，不是源码字符串
  await expect(preview(page).locator("svg")).toContainText("单据受理");
  await expect(preview(page).locator("svg")).toContainText("形式审查");
  // 源码区点开就在原地（不是跳去别处、也不是换个只读框）
  await expect(page.locator(".hp-codebox > pre")).toBeVisible();
});

/**
 * 只选中代码块内容再打字。
 *
 * 为什么不用 Ctrl+A：它选的是**整篇文档**，打字会把 code_block 整个替换掉
 * （第一版就是这么把测试做废的）。
 * 也不用 Home/方向键/End：代码块里 `End` 跳的是点击所在那一行的行尾，
 * 本里程碑已五次栽在拿光标落点当靶心上。
 * PM 会跟随 DOM selection，所以用 Range 精确选中 code 元素内容即可。
 */
async function selectAllCode(page: Page) {
  await page.locator(".hp-codebox > pre > code").click();
  await page.evaluate(() => {
    const el = document.querySelector(".hp-codebox > pre > code");
    if (!el) throw new Error("找不到代码块的 code 元素");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

test("改图内容 → 图原地重绘（SVG 跟着变，旧节点消失）", async ({ page }) => {
  await seedAndOpen(page, GOOD);
  await expect(preview(page)).toHaveAttribute("data-state", "done");

  await selectAllCode(page);
  await page.keyboard.type("graph LR\n  X[已收件] --> Y[技术复核]");

  // 5s 在 4 worker 并行跑全量时会假红（单独跑刚好 5.0s 擦边过）。
  // 这颗钉的是「重绘是否正确」（旧节点必须消失），不是渲染耗时；
  // 耗时另有 110 的性能用例守着，这里只把等待耐心放宽。
  await expect(preview(page).locator("svg")).toContainText("已收件", { timeout: 20_000 });
  await expect(preview(page).locator("svg")).toContainText("技术复核");
  await expect(preview(page).locator("svg")).not.toContainText("单据受理");
  await expect(preview(page)).toHaveAttribute("data-state", "done");
});

test("点预览即把光标送进源码（点开即改）", async ({ page }) => {
  await seedAndOpen(page, GOOD);
  await expect(preview(page)).toHaveAttribute("data-state", "done");

  await preview(page).locator(".hp-mermaidbox__svg").click();
  // 光标进了 code_block：直接打字应落到源码里，而不是变成正文段落
  await page.keyboard.type("#");
  await expect(page.locator(".hp-codebox > pre > code")).toContainText("#graph");
  // 打字后图不该消失在同一位置（原地编辑，不是跳走）
  await expect(preview(page)).toBeVisible();
});

test("语法错误：显示错误信息、源码仍可继续编辑，修正后自动重绘", async ({ page }) => {
  await seedAndOpen(page, BROKEN);

  await expect(preview(page)).toHaveAttribute("data-state", "error", { timeout: 5000 });
  await expect(preview(page).locator(".hp-mermaidbox__error")).toContainText("Mermaid 语法错误");
  // 关键：错误态下源码必须还能改（不能像阅读模式那样只读展示）
  const code = page.locator(".hp-codebox > pre > code");
  await expect(code).toBeEditable();

  // 整体替换成合法图（只选代码内容，不选整篇）
  await selectAllCode(page);
  await page.keyboard.type("graph TD\n  A[单据受理] --> B[形式审查]");
  await expect(preview(page)).toHaveAttribute("data-state", "done", { timeout: 5000 });
  await expect(preview(page).locator("svg")).toContainText("单据受理");
});

test("Mermaid 文档不改任何东西直接保存 → 文件逐字节等于原文", async ({ page }) => {
  await seedAndOpen(page, GOOD);
  await expect(preview(page)).toHaveAttribute("data-state", "done");

  await page.keyboard.press("Control+s");
  const saved = await savedOf(page);
  // 图渲染过、NodeView 存在，都不该让落盘内容发生一个字节的变化
  expect(saved).toBe(GOOD);
});

test("改图内容后保存：围栏信息串仍是 mermaid，块外逐字节不动", async ({ page }) => {
  await seedAndOpen(page, GOOD);
  await expect(preview(page)).toHaveAttribute("data-state", "done");

  await selectAllCode(page);
  await page.keyboard.type("graph TD\n  A[单据受理] --> B[形式审查]\n  B --> C[技术复核]");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 围栏信息串没丢、没被拆成两个围栏
  expect(saved.match(/```mermaid/g)).toHaveLength(1);
  expect(saved.match(/```/g)).toHaveLength(2);
  // 块外逐字节不变
  expect(saved.startsWith("# 流程\n\n")).toBe(true);
  expect(saved).toContain("正文不动。\n");
  // 图内容里的 `#` 与 `-->` 没被当 Markdown 解析
  expect(saved).toContain("graph TD");
  expect(saved).toContain("B --> C[技术复核]");
});
