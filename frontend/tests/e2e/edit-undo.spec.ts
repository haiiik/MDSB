import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 117：撤销与重做的粒度（US-39 / D17）。
 *
 * 这颗的判据只能是「按一次 Ctrl+Z 回到哪」，所以全部走真键盘 + 真停顿：
 * 合并窗口是 `Date.now()` 驱动的，mock 不了时间就别假装能测。
 * 前置事实（探针实测）：接 `history()` 之前 Ctrl+Z **完全没反应**，
 * 所以下面第一条同时也是「撤销这件事到底有没有被装上」的守门用例。
 */

const DOC = "# 标题\n\n正文段落。\n\n- 列表项甲\n- 列表项乙\n\n| 模式 | 快捷键 |\n| :--- | ---: |\n| 阅读 | Ctrl+1 |\n\n末段不动。\n";

let path = "";

async function seedAndOpen(page: Page) {
  path = "/demo/撤销-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
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
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

/** 光标放进「正文段落。」末尾。
 * 注意 nth：列表项里也有 p 元素，`.ProseMirror p` 的第 0 个才是这个段落，
 * 拿 nth(1) 会把字打进列表项里（第一版就这么假红了）。 */
const caretInParagraph = (page: Page) => placeCaret(page, ".ProseMirror p", -1, 0);

const HISTORY_WAIT = 800; // 必须大于合并窗口 500ms，并留足调度余量

const undo = (page: Page) => page.keyboard.press("Control+z");
const redo = (page: Page) => page.keyboard.press("Control+Shift+z");

test("Ctrl+Z 真的有反应了：打十个字，一次撤销全部消失", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.keyboard.type("连续输入的十个汉字啊啊");

  await expect(page.locator(".ProseMirror p").nth(0)).toContainText("连续输入的十个汉字啊啊");
  await undo(page);
  // 合并成一步：一次 Ctrl+Z 就该全回去，而不是退一个字
  await expect(page.locator(".ProseMirror p").nth(0)).toHaveText("正文段落。");
});

test("停顿之后继续输入算另一步：两次撤销才回到原样", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.keyboard.type("前半");
  await page.waitForTimeout(HISTORY_WAIT);
  await page.keyboard.type("后半");

  await undo(page);
  await expect(page.locator(".ProseMirror p").nth(0)).toHaveText("正文段落。前半");
  await undo(page);
  await expect(page.locator(".ProseMirror p").nth(0)).toHaveText("正文段落。");
});

test("重做与撤销对称：撤到底再重做到底，内容一字不差", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.keyboard.type("甲甲甲");
  await undo(page);
  await redo(page);
  await expect(page.locator(".ProseMirror p").nth(0)).toHaveText("正文段落。甲甲甲");
  await undo(page);
  await expect(page.locator(".ProseMirror p").nth(0)).toHaveText("正文段落。");
});

test("粘贴是独立一步：撤销只回粘贴，前面打的字还在", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.keyboard.type("先打的字");
  await page.waitForTimeout(HISTORY_WAIT);
  await page.evaluate(() =>
    (window as unknown as { __hpMockPaste?: (x: unknown) => void }).__hpMockPaste!({ text: "粘进来的一整段" })
  );
  await expect(page.locator(".ProseMirror p").nth(0)).toContainText("粘进来的一整段");

  await undo(page);
  await expect(page.locator(".ProseMirror p").nth(0)).toContainText("先打的字");
  await expect(page.locator(".ProseMirror p").nth(0)).not.toContainText("粘进来的一整段");
});

test("表格结构操作是独立一步：撤销只回那一行", async ({ page }) => {
  await seedAndOpen(page);
  const rowsBefore = await page.locator(".ProseMirror tr").count();
  await page.locator(".ProseMirror td").first().click({ button: "right" });
  await page.getByTestId("table-menu").locator('[data-testid="table-menu-item"]').filter({ hasText: "下方插入行" }).click();
  await expect(page.locator(".ProseMirror tr")).toHaveCount(rowsBefore + 1);

  await undo(page);
  await expect(page.locator(".ProseMirror tr")).toHaveCount(rowsBefore);
});

test("块类型转换是独立一步：撤回去仍是段落，且块外字节不受影响", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.getByTestId("tb-h1").click();
  await expect(page.locator(".ProseMirror h1")).toHaveCount(2); // 原有标题 + 刚转出来的

  await undo(page);
  await expect(page.locator(".ProseMirror h1")).toHaveCount(1);
  await expect(page.locator(".ProseMirror p").nth(0)).toHaveText("正文段落。");

  // 撤销完保存：文件必须逐字节回到原文（撤销不产生任何额外差异）
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC);
});

test("撤销回到未编辑状态 → 脏点熄灭、保存不写盘（比对基准是原文）", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.keyboard.type("手滑打的字");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  await undo(page);
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  // 脏点熄了之后再按保存，文件必须仍是原文一份
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC);
});

test("撤销只碰改过的那一块：列表与表格的字节不受牵连", async ({ page }) => {
  await seedAndOpen(page);
  await caretInParagraph(page);
  await page.keyboard.type("只动这一段");
  await undo(page);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toBe(DOC); // 撤销干净之后，整篇与原文逐字节相同
});
