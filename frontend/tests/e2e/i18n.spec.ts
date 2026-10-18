import { expect, test } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * M3-134：语言设置真的能切、能记住。
 *
 * 判据一律押「切语言后**该变的变了、不该变的没变**」：
 * 底栏模式按钮的文案要跟着换（它是 i18n 出来的），testid 不许换（那是判据的落脚点）。
 */
test("设置里选 English → 对话框自身文案立刻换英文（改语言不需要重启）", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("界面语言")).toBeVisible();

  await page.selectOption("[data-testid=setting-lang]", "en");
  await expect(page.getByText("Language")).toBeVisible();
  await expect(page.getByText("界面语言")).toHaveCount(0);
  // 结构没动：切语言不许把判据的落脚点一起换掉
  await expect(page.getByTestId("setting-lang")).toHaveValue("en");
  // 顶栏窗口三键的提示也换了（title 是给人看的，属于界面文案）
  await expect(page.getByTestId("win-close")).toHaveAttribute("title", "Close");
});

test("切回中文；未打开文档的提示两档都对", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await expect(page.getByTestId("status-not-opened")).toHaveText("未打开文档");

  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  await expect(page.getByTestId("status-not-opened")).toHaveText("No document open");

  await page.selectOption("[data-testid=setting-lang]", "zh");
  await expect(page.getByTestId("status-not-opened")).toHaveText("未打开文档");
});
