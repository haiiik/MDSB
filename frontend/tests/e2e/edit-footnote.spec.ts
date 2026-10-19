import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 136-B：编辑模式的脚注 —— 点引用落到定义上、改正文只动那一块。
 *
 * 这一份是 Q27（她定「先不做跨块重排」）的**端到端**凭据：
 * 单测那边钉的是纯函数往返，这里钉的是"她在界面上改一个字，落盘的文件长什么样"。
 */

const PATH = "/demo/脚注编辑.md";

const DOC = [
  "# 脚注编辑",
  "",
  "正文一句[^a]，再来一句[^b]。",
  "",
  "中间段落不动。",
  "",
  "[^a]: 第一个定义",
  "  两格缩进的续行",
  "",
  "[^b]: 第二个定义",
  "",
].join("\n");

async function seedAndOpen(page: Page, doc = DOC): Promise<void> {
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
}

async function savedOf(page: Page): Promise<string> {
  return page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );
}

test("两条定义都渲染成可编辑块，标记由 CSS 画且不进 DOM", async ({ page }) => {
  await seedAndOpen(page);
  const defs = page.getByTestId("pm-footnote-def");
  await expect(defs).toHaveCount(2);
  await expect(defs.first()).toContainText("第一个定义");
  // 续行的换行是原文的一部分，不能被折叠成一行
  await expect(defs.first()).toContainText("两格缩进的续行");
  // 标记 `[^a]:` 是伪元素：它在界面上看得见，但**不在 DOM 文字里**
  const before = await defs.first().evaluate((el) => getComputedStyle(el, "::before").content);
  expect(before).toContain("[^a]");
  await expect(defs.first()).not.toContainText("[^a]:");
});

test("点引用 → 光标进对应定义，打字就落在那一条上", async ({ page }) => {
  await seedAndOpen(page);
  await page.getByTestId("pm-footnote-ref").first().click();
  await page.keyboard.type("改过：");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("[^a]: 改过：第一个定义");
  // **续行缩进沿用原文的两格**（remark 的序列化器会把它改成四格，那正是我们绕开它的原因）
  expect(saved).toContain("[^a]: 改过：第一个定义\n  两格缩进的续行");
  expect(saved).not.toContain("\n    两格缩进的续行");
});

test("改一条定义：另一条、正文段落、标题都逐字节不动", async ({ page }) => {
  await seedAndOpen(page);
  await page.getByTestId("pm-footnote-ref").first().click();
  await page.keyboard.type("只动这一条");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const before = (key: string): string => saved.slice(0, saved.indexOf(key));
  // 定义块之后的那条必须原样
  expect(saved).toContain("[^b]: 第二个定义");
  expect(saved).toContain("正文一句[^a]，再来一句[^b]。");
  expect(saved).toContain("中间段落不动。");
  expect(saved).toContain("# 脚注编辑");
  // 引用的原文没被改写（她改的是定义，不是引用）
  expect(before("[^a]:")).toBe(DOC.slice(0, DOC.indexOf("[^a]:")));
});

test("什么都没改就保存：文件与原文一字不差", async ({ page }) => {
  await seedAndOpen(page);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC);
});

test("**没有定义的 `[^zz]` 就是普通文字**，不该被当成引用节点、也不该被改坏", async ({ page }) => {
  // CommonMark/GFM 的规矩：脚注引用必须有对应定义才成立。
  // 这条测的是"我们不替她发明结构"：悬空的 [^zz] 必须逐字节留在正文里。
  const orphan = ["# 悬空", "", "这里有个[^zz]但没有定义。", ""].join("\n");
  await seedAndOpen(page, orphan);
  await expect(page.getByTestId("pm-footnote-ref")).toHaveCount(0);
  await expect(page.getByTestId("pm-footnote-def")).toHaveCount(0);
  const savedBefore = await savedOf(page);
  expect(savedBefore).toBe(orphan);
});
