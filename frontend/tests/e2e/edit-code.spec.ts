import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 109：代码块就地编辑 + 语言下拉（US-32）。
 */

const PATH = "/demo/代码块边界.md";

const DOC = [
  "# 代码块",
  "",
  "```sql",
  "SELECT matter_type,",
  "       AVG(diff) AS avg_hours",
  "FROM approval_duration;",
  "```",
  "",
  "正文段落不动。",
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

test("代码块渲染出语言下拉，且当前语言被选中", async ({ page }) => {
  await seedAndOpen(page);
  const select = page.getByTestId("pm-codelang");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("sql");
});

test("改代码内容一行：只有该围栏块变化，围栏信息串与正文不动", async ({ page }) => {
  await seedAndOpen(page);
  const code = page.locator(".hp-codebox > pre > code");
  await code.click();
  await page.keyboard.type("-- 改过 ");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 只断言「改动落在代码块内」：`End` 跳的是**点击所在那一行的行尾**，
  // 不是代码块末尾 —— 这是 105/106 就记过的坑，别再拿光标落点当靶心。
  expect(saved).toMatch(/```sql\n[^\n]*-- 改过/);
  expect(saved).toContain("```sql"); // 语言标注没丢
  expect(saved).toContain("正文段落不动。");
  expect(saved).toContain("# 代码块");
  // 代码块仍是 1 个块（没被拆成正文+注释）
  expect(saved.match(/```/g)?.length).toBe(2);
});

test("换语言：围栏信息串变化，代码内容逐字节不变", async ({ page }) => {
  await seedAndOpen(page);
  await page.getByTestId("pm-codelang").selectOption("python");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("```python");
  expect(saved).not.toContain("```sql");
  // 代码三行原样
  expect(saved).toContain("SELECT matter_type,\n       AVG(diff) AS avg_hours\nFROM approval_duration;");
  expect(saved).toContain("正文段落不动。");
});

test("未知语言：标注原样保留并给出可见提示，不被悄悄改成纯文本", async ({ page }) => {
  const unknown = "# 码\n\n```klingon\npH\n```\n";
  await seedAndOpen(page, unknown);

  const select = page.getByTestId("pm-codelang");
  await expect(select).toHaveValue("klingon");
  // 收起的 <select> 里的 <option> 在 Playwright 眼里永远不是 visible，
  // 所以断言「存在且文案带未识别」而不是 toBeVisible()
  await expect(select.locator('option[value="klingon"]')).toHaveCount(1);
  await expect(select.locator('option[value="klingon"]')).toHaveText("klingon（未识别）");
  // 提示可见：不能让用户以为标注已经生效于高亮
  await expect(page.locator(".hp-codebox__hint")).toContainText("klingon");

  await page.keyboard.press("Control+s");
  const saved = await savedOf(page);
  expect(saved).toContain("```klingon");
  expect(saved).toContain("pH");
});

test("下拉上的点击不被当成选区移动（能真的打开并改值）", async ({ page }) => {
  await seedAndOpen(page);
  const select = page.getByTestId("pm-codelang");
  await select.click();
  // 点击会打开**原生下拉菜单**，此时直接 selectOption 会被菜单关闭时的回写覆盖
  // （症状是值退回原语言、文档不变）。先按 Esc 收起菜单再设值。
  await page.keyboard.press("Escape");
  await select.selectOption("json");
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("```json");
});
