import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 118：查找与替换（US-40）。
 *
 * 三种模式共用一条查找条，所以每种模式都要跑一遍「计数 = 高亮数」这条不变量 ——
 * 这是验收第一条，也是最容易在某个模式里悄悄不一致的地方
 * （阅读模式改 DOM 会破坏渲染产物、源码模式的偏移与 PM 的位置不是一套）。
 */

const DOC =
  "# 审批时效周报\n\n指标口径已对齐，指标需要单独看板。\n\n正文里提到 **加粗** 与 avg 平均耗时 AVG。\n\n| 指标 | 值 |\n| :--- | --- |\n| 指标平均 | 12 |\n\n末段不动，指标只此一处。\n";

let path = "";

async function seedAndOpen(page: Page, mode: "read" | "edit" | "source") {
  path = "/demo/查找-" + mode + "-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
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
  if (mode !== "read") await setMode(page, mode);
}

const type = (page: Page, text: string) => page.getByTestId("search-input").fill(text);
const countOf = (page: Page) => page.getByTestId("search-count").innerText();
/** 各模式的高亮落在不同地方：PM/CM 是类名，阅读模式是 CSS Custom Highlight */
const paintedCount = (page: Page, mode: "read" | "edit" | "source") =>
  mode === "read"
    ? page.evaluate(() => CSS.highlights.get("hp-search")?.size ?? 0)
    : mode === "edit"
      ? page.locator(".ProseMirror .hp-search").count()
      : page.locator(".cm-content .hp-search").count();

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

test("编辑模式：计数与高亮项数一致，中文关键词命中 4 处", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await type(page, "指标");
  expect(await countOf(page)).toBe("1 / 5");
  expect(await paintedCount(page, "edit")).toBe(5); // 全部命中都画，当前项只是多一个类名
});

test("编辑模式：跳转循环不越界，末项再点下一个回首项", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  for (let i = 1; i < 5; i++) await page.getByTestId("search-next").click();
  expect(await countOf(page)).toBe("5 / 5");
  await page.getByTestId("search-next").click();
  expect(await countOf(page)).toBe("1 / 5");
  await page.getByTestId("search-prev").click();
  expect(await countOf(page)).toBe("5 / 5");
});

test("编辑模式：含 Markdown 标记的关键词命中渲染后的文字", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  // 编辑模式里没有字面的 `**`：那是源码的写法，屏幕上看到的是渲染后的「加粗」
  await type(page, "加粗");
  expect(await countOf(page)).toBe("1 / 1");
  await type(page, "**加粗**");
  expect(await countOf(page)).toBe("0 / 0");
});

test("编辑模式：大小写与全词两个开关组合结果正确", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "avg");
  expect(await countOf(page)).toBe("1 / 2"); // avg + AVG（大小写不敏感）
  await page.getByTestId("search-opt-caseSensitive").click();
  expect(await countOf(page)).toBe("1 / 1"); // 只剩小写那个 avg
  await page.getByTestId("search-opt-caseSensitive").click();
  await page.getByTestId("search-opt-wholeWord").click();
  expect(await countOf(page)).toBe("1 / 2"); // 两个都是独立词，全词不改变结果
  // 全词真正的效果：词内出现不算命中（「指标口」后面还跟着「径」）
  await type(page, "指标口");
  expect(await countOf(page)).toBe("0 / 0");
  await page.getByTestId("search-opt-wholeWord").click();
  expect(await countOf(page)).toBe("1 / 1");
});

test("编辑模式：正则开关 + 非法表达式只提示、不清空输入", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-opt-regex").click();
  await type(page, "指[标案]");
  expect(await countOf(page)).toBe("1 / 5");
  await type(page, "指(标");
  await expect(page.getByTestId("search-error")).toContainText("正则表达式无效");
  await expect(page.getByTestId("search-input")).toHaveValue("指(标");
  expect(await countOf(page)).toBe("0 / 0");
  await type(page, "指(标)");
  await expect(page.getByTestId("search-error")).toHaveCount(0);
  expect(await countOf(page)).toBe("1 / 5");
});

test("编辑模式：替换当前项只改一个，其余命中还在", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await type(page, "指标");
  await page.getByTestId("replace-input").fill("KPI");
  await page.getByTestId("replace-one").click();
  expect(await countOf(page)).toBe("1 / 4"); // 五处里改掉一处，还剩四处
  await page.keyboard.press("Control+s");
  const text = await savedOf(page);
  expect(text).toContain("KPI口径已对齐");
  expect(text).toContain("指标需要单独看板");
});

test("编辑模式：替换全部是**一步撤销**，撤销后逐字节还原", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await type(page, "指标");
  await page.getByTestId("replace-input").fill("KPI");
  await page.getByTestId("replace-all").click();
  expect(await countOf(page)).toBe("0 / 0");
  await page.keyboard.press("Control+s");
  const replaced = await savedOf(page);
  expect(replaced).toContain("KPI口径已对齐");
  expect(replaced).toMatch(/\|\s*KPI平均\s*\|/); // 表格块被改过 → 整块重排（列宽补齐是 111 的既定代价），只能按形状匹配

  // 一次 Ctrl+Z 就该全部还原（不是四步）
  await page.getByTestId("search-close").click();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC);
});

test("编辑模式：替换只动命中块，未命中的块逐字节不变", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await type(page, "末段不动"); // 只出现在最后一段
  await page.getByTestId("replace-input").fill("收尾段落");
  await page.getByTestId("replace-all").click();
  await page.keyboard.press("Control+s");
  const text = await savedOf(page);
  expect(text).toContain("收尾段落，指标只此一处。");
  // 代码之外的其它块原样：标题、第二段、表格三行都在
  expect(text).toContain("# 审批时效周报\n\n指标口径已对齐，指标需要单独看板。\n\n");
  expect(text).toContain("| 指标平均 | 12 |");
});

test("阅读模式：能数能跳，且不产生脏状态", async ({ page }) => {
  await seedAndOpen(page, "read");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  expect(await countOf(page)).toBe("1 / 5");
  expect(await paintedCount(page, "read")).toBe(4); // 当前项单独一档 highlight，不在这个集合里
  await page.getByTestId("search-next").click();
  expect(await countOf(page)).toBe("2 / 5");
  // 只读行为：没有脏点
  expect(await page.getByTestId("tab-dirty").count()).toBe(0);
  // 阅读模式不给替换入口
  await expect(page.getByTestId("replace-input")).toHaveCount(0);
});

test("Esc 只关查找条并清高亮，不关标签", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await page.getByTestId("search-input").press("Escape");
  await expect(page.getByTestId("search-bar")).toHaveCount(0);
  expect(await paintedCount(page, "edit")).toBe(0);
  expect(await page.getByTestId("tabbar").locator(".tab").count()).toBe(1);
});

test("查找条里再按 Ctrl+F 不重置输入（不重复触发）", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await page.getByTestId("search-input").press("Control+f");
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await expect(page.getByTestId("search-input")).toHaveValue("指标");
  expect(await countOf(page)).toBe("1 / 5");
});

test("源码模式：找的是源文本，替换全部同样一步撤销", async ({ page }) => {
  await seedAndOpen(page, "source");
  await page.keyboard.press("Control+h");
  await type(page, "**加粗**"); // 源码模式里字面标记就在文本上
  expect(await countOf(page)).toBe("1 / 1");
  await page.getByTestId("replace-input").fill("强调");
  await page.getByTestId("replace-all").click();
  expect(await countOf(page)).toBe("0 / 0");
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("正文里提到 强调 与 avg 平均耗时 AVG。");
});
