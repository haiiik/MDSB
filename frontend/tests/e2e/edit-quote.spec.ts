import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 108：引用块与分割线的编辑行为。
 *
 * 靶心是**引用前缀 `>`**：编辑后既不能丢（引用降级成正文），
 * 也不能重复（`> > ` 变成假嵌套）。
 */

const PATH = "/demo/引用边界.md";

const DOC = [
  "# 引用与分割线",
  "",
  "> 数据来源以工单库为准。",
  ">",
  "> 第二段引用。",
  "",
  "***",
  "",
  "> 外层引用",
  "> > 内层引用",
  "",
  "末段不动。",
  "",
].join("\n");

async function seedAndOpen(page: Page, doc = DOC) {
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

test("改引用内一句：`>` 前缀不丢也不重复，块外逐字节不变", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror blockquote p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("报表库仅做展示。");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const expected = DOC.replace("> 数据来源以工单库为准。", "> 数据来源以工单库为准。报表库仅做展示。");
  expect(saved).toBe(expected);
  // 反证：没有变成 `> > ` 或掉前缀
  expect(saved).not.toContain("> > 数据来源");
  expect(saved.split("\n")[2]).toMatch(/^> 数据来源/);
});

test("引用内第二段仍可独立编辑，两段引用都带前缀", async ({ page }) => {
  await seedAndOpen(page);
  const second = page.locator(".ProseMirror blockquote p").nth(1);
  await second.click();
  await page.keyboard.press("End");
  await page.keyboard.type("（补）");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("> 第二段引用。（补）");
  expect(saved).toContain("> 数据来源以工单库为准。");
  expect(saved).toContain("***"); // 未点名的分割线原样
});

test("改内层引用：嵌套层级保持，外层文字不变", async ({ page }) => {
  await seedAndOpen(page);
  // 第二个 blockquote 是「外层引用 / 内层引用」那一块
  const inner = page.locator(".ProseMirror blockquote blockquote p").first();
  await inner.click();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("> 外层引用");
  expect(saved).toMatch(/> >? 内层引用X/); // 内层仍是引用，不是掉级成正文
  expect(saved).not.toMatch(/\n> ?\n> ?\n/); // 没产生连续空引用垃圾行
  expect(saved).toContain("末段不动。");
});

test("分割线不参与编辑：改别处时它逐字节活着", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror p").filter({ hasText: "末段不动" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("（改过）");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("***"); // 仍是原文的 ***，没被归一成 ---
  expect(saved).toContain("末段不动。（改过）");
  expect(saved).toContain("> 数据来源以工单库为准。");
});
