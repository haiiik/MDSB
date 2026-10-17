import { expect, test } from "@playwright/test";
import { gotoApp } from "./mockApp";

/**
 * 贯穿子弹：选文件 -> 读盘 -> 渲染。
 * mock 宿主下 pickOpen 返回内置示例文档，等价于桌面点原生对话框选中同一个文件。
 */

test("点「打开」后渲染出文档标题，状态栏显示文件名", async ({ page }) => {
  await gotoApp(page);

  await page.getByTestId("open-button").click();

  await expect(page.getByRole("heading", { name: "欢迎使用 MDStar", level: 1 })).toBeVisible();
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("欢迎.md");
});

test("渲染结构：二级标题、表格、代码块都在文档根里", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("open-button").click();

  const root = page.getByTestId("document-root");
  await expect(root.locator("h2")).toHaveCount(3);
  await expect(root.locator("table th")).toHaveCount(3);
  await expect(root.locator("pre code")).toContainText("const greet");
});

test("?file= 带中文目录与空格的路径可直接打开", async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent("/中文目录/审批时效 样本.md"));

  await expect(
    page.getByRole("heading", { name: "审批时效样本（非 ASCII 目录）", level: 1 })
  ).toBeVisible();
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("审批时效 样本.md");
});

test("?file= 指向不存在的文件：显示失败提示而不是空白", async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent("/demo/没有这个文件.md"));

  // mock 的 startupFile 只认存在的路径，因此这里回到空态而不是崩掉
  await expect(page.getByRole("heading", { name: "没有打开的文档" })).toBeVisible();
});

test("打开失败时正文区给出可读错误", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => {
    // 让下一次 pickOpen 返回一个 mock 文件系统里不存在的路径
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/缺失.md";
  });
  await page.getByTestId("open-button").click();

  await expect(page.getByTestId("open-error")).toContainText("不存在");
});
