import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 137「插入文档链接」：从当前文件所在目录挑一篇 .md，插成 `[文件名](路径)`。
 *
 * 判据全部押在**最终落盘的那串 Markdown** 上，不押弹层好不好看 ——
 * 路径这种东西"看着对、插进去打不开"是最差的失败。
 */

const HOST_DOC = "/demo/链接宿主.md";
const HOST_BODY = "# 链接宿主\n\n这里要插一篇别的文档。\n";

async function openInEdit(page: Page, path = HOST_DOC, body = HOST_BODY) {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, body]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  // 光标放到正文那一行末尾
  await page.locator(".ProseMirror p").last().click();
  await page.keyboard.press("End");
}

async function savedOf(page: Page, path = HOST_DOC): Promise<string> {
  return page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );
}

test("打开弹层：列出当前目录下的 .md，文件名带空格也在", async ({ page }) => {
  await openInEdit(page);
  await page.getByTestId("tb-doclink").click();
  const picker = page.getByTestId("doclink");
  await expect(picker).toBeVisible();
  const items = page.getByTestId("doclink-item");
  await expect(items.filter({ hasText: "欢迎.md" })).toHaveCount(1);
  await expect(items.filter({ hasText: "项目 周报 v1.md" })).toHaveCount(1);
  // 非 Markdown 不进列表（mock 目录里有 .png / .svg）
  await expect(items.filter({ hasText: "arch.png" })).toHaveCount(0);
});

test("搜索缩小范围，预览就是最终要插进去的那串", async ({ page }) => {
  await openInEdit(page);
  await page.getByTestId("tb-doclink").click();
  await page.getByTestId("doclink-search").fill("周报");
  await expect(page.getByTestId("doclink-item")).toHaveCount(1);
  // 同目录 → 相对路径就是文件名；空格必须被编码，否则链接在这里就断了
  await expect(page.getByTestId("doclink-preview")).toHaveText("[项目 周报 v1](项目%20周报%20v1.md)");
});

test("插入相对路径：落盘是 `[文件名](相对路径)`，且只此一处改动", async ({ page }) => {
  await openInEdit(page);
  await page.getByTestId("tb-doclink").click();
  await page.getByTestId("doclink-search").fill("周报");
  await page.getByTestId("doclink-insert").click();
  await expect(page.getByTestId("doclink")).toHaveCount(0);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("这里要插一篇别的文档。[项目 周报 v1](项目%20周报%20v1.md)");
  expect(saved).toContain("# 链接宿主");
  expect(saved).not.toContain("/demo/");
});

test("切到绝对路径：预览与落盘都跟着换成绝对", async ({ page }) => {
  await openInEdit(page);
  await page.getByTestId("tb-doclink").click();
  await page.getByTestId("doclink-search").fill("周报");
  await page.getByTestId("doclink-abs").check();
  await expect(page.getByTestId("doclink-preview")).toHaveText("[项目 周报 v1](/demo/项目%20周报%20v1.md)");
  await page.getByTestId("doclink-insert").click();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("[项目 周报 v1](/demo/项目%20周报%20v1.md)");
});

test("键盘：Enter 直接插入当前高亮行", async ({ page }) => {
  await openInEdit(page);
  await page.getByTestId("tb-doclink").click();
  await page.getByTestId("doclink-search").fill("周报");
  await page.getByTestId("doclink-search").press("Enter");
  await expect(page.getByTestId("doclink")).toHaveCount(0);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("[项目 周报 v1](项目%20周报%20v1.md)");
});

test("Esc 关掉弹层，不该把文档改成未保存", async ({ page }) => {
  await openInEdit(page);
  await page.getByTestId("tb-doclink").click();
  await expect(page.getByTestId("doclink")).toBeVisible();
  await page.getByTestId("doclink-search").press("Escape");
  await expect(page.getByTestId("doclink")).toHaveCount(0);
  await expect(page.getByTestId("status-dirty")).toHaveCount(0);
});

test("**当前文件未保存 → 相对路径禁用**（没有基准就不假装有一个）", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("tab-new").click();
  await setMode(page, "edit");
  await page.getByTestId("tb-doclink").click();
  await expect(page.getByTestId("doclink-nobase")).toBeVisible();
  await expect(page.getByTestId("doclink-rel")).toBeDisabled();
  await expect(page.getByTestId("doclink-item")).toHaveCount(0);
});
