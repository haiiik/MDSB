import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 111：表格单元格直接编辑（US-33 前半）。
 *
 * 表格是「一个表格 = 一个块」，改一格会整块重排（补齐列宽是既定代价），
 * 所以这里的断言重点是**块外逐字节不变 + 对齐语义不丢 + 不丢行**，
 * 而不是整串相等。
 */

const PATH = "/demo/表格边界.md";

const DOC = [
  "# 模式表",
  "",
  "| 模式 | 快捷键 | 说明 |",
  "| :--- | ---: | :---: |",
  "| 阅读 | Ctrl+1 | 只读渲染 |",
  "| 源码 | Ctrl+3 | 看原文 |",
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

test("点单元格改文字：块外逐字节不变，对齐语义保持", async ({ page }) => {
  await seedAndOpen(page);

  await page.locator(".ProseMirror td").first().click();
  await page.keyboard.type("（新）");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 块外逐字节不变
  expect(saved.startsWith("# 模式表\n\n")).toBe(true);
  expect(saved).toContain("末段不动。\n");
  // 插入发生在**该单元格内**（点击落点在文字中间，所以不断言位置 —— 第六次踩这坑了）。
  // 不变量：去掉插入内容后，该格恢复成原文字。
  const rows = saved.split("\n").filter((l) => l.trim().startsWith("|"));
  const firstData = rows[2].split("|").map((c) => c.trim()).filter(Boolean);
  expect(firstData[0].replace("（新）", "")).toBe("阅读");
  expect(firstData[0]).toContain("（新）");
  // 三列对齐语义都还在：左 `:` 开头、右 `:` 结尾、居中两端都有 `:`
  const sep = rows[1];
  const cells = sep.split("|").map((c) => c.trim()).filter(Boolean);
  expect(cells[0].startsWith(":")).toBe(true);
  expect(cells[1].endsWith(":")).toBe(true);
  expect(cells[2].startsWith(":") && cells[2].endsWith(":")).toBe(true);
  // 行数没少（表头 + 分隔 + 两数据行）
  expect(rows).toHaveLength(4);
});

test("Tab 在单元格间移动", async ({ page }) => {
  await seedAndOpen(page);

  // 先确认编辑器有焦点：不 Tab 直接打字应落进第一格
  await page.locator(".ProseMirror td").first().click();
  await page.keyboard.type("A");
  await page.keyboard.press("Tab");
  await page.keyboard.type("B");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const rows = saved.split("\n").filter((l) => l.trim().startsWith("|"));
  const firstData = rows[2].split("|").map((c) => c.trim()).filter(Boolean);
  expect(firstData[0]).toContain("A");
  // 这条就是 Tab 是否真的跨格：B 必须落在第二列
  expect(firstData[1]).toContain("B");
});

test("表头行仍是表头（th 不被降级）", async ({ page }) => {
  await seedAndOpen(page);
  await expect(page.locator(".ProseMirror th")).toHaveCount(3);

  await page.locator(".ProseMirror td").first().click();
  await page.keyboard.type("Z");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 表头行仍是第一行，且分隔行紧随其后
  const lines = saved.split("\n").filter((l) => l.trim().startsWith("|"));
  expect(lines[0]).toContain("模式");
  expect(lines[1]).toMatch(/[:\-]/);
});

test("单元格内含转义竖线：编辑别处后仍不错列", async ({ page }) => {
  const src = "| 列 | 内容 |\n| --- | --- |\n| 甲 | 含竖线 \\| 转义 |\n| 乙 | 尾部 \\| |\n";
  await seedAndOpen(page, src);

  await page.locator(".ProseMirror td").first().click();
  await page.keyboard.type("改");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("\\|");
  for (const line of saved.split("\n").filter((l) => l.trim().startsWith("|"))) {
    expect((line.replace(/\\\|/g, "").match(/\|/g) ?? []).length).toBe(3);
  }
});
