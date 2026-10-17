import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 104 编辑模式工作文本回写 / 105 段落编辑闭环。
 *
 * 断言对象是 **mock 文件系统里已落盘的字节**，不是界面上的工作副本 ——
 * 只看界面证明不了「保存后只有那一段变了」。
 */

const PATH = "/demo/保真样本.md";

const DOC = [
  "# 保真标题",
  "",
  "段落甲原文在此。",
  "",
  "| 甲 | 乙 |",
  "| :--- | ---: |",
  "| 1 | 2 |",
  "",
  "末段也不许动。",
  "",
].join("\n");

async function seedAndOpen(page: Page) {
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

async function savedOf(page: Page): Promise<string> {
  return page.evaluate((p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p), PATH);
}

test("恒等：进编辑模式什么都不改，不产生脏状态且保存后字节不变", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();

  // 挂载 / 解析过程一旦顺手规范化一次，脏点就会亮 —— 这条是 M1「未编辑永不落盘」闸门的延伸
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  expect(await savedOf(page)).toBe(DOC);
});

test("改一个段落并保存：磁盘上只有那一段变了，表格对齐与补齐列宽一律没动", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");

  const para = page.locator(".ProseMirror p").filter({ hasText: "段落甲原文在此" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type("【改过】");

  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  const saved = await savedOf(page);

  // 1) 改动确实落盘
  expect(saved).toContain("段落甲原文在此。【改过】");

  // 2) 块外逐字节不变 —— 表格是这一条最硬的探针：
  //    remark 整篇序列化会把 `:---` 补成 `-----`、把列宽对齐、把 `| 甲 |` 撑开
  expect(saved).toContain("| 甲 | 乙 |\n| :--- | ---: |\n| 1 | 2 |");
  expect(saved).toContain("# 保真标题");
  expect(saved).toContain("末段也不许动。");

  // 3) 除被改的那一段外，行数与原文一致（没有多插空行、没有吃掉空行）
  expect(saved.split("\n").length).toBe(DOC.split("\n").length);
});

test("改回原样：脏点自动熄灭（比对基准是原始字节）", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");

  const para = page.locator(".ProseMirror p").filter({ hasText: "段落甲原文在此" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type("临时加的");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  for (let i = 0; i < "临时加的".length; i++) await page.keyboard.press("Backspace");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
});

test("未编辑的裸 HTML / frontmatter 块在保存后逐字节回来（103 的不透明保留）", async ({ page }) => {
  const withOpaque = ["---", "title: 甲", "---", "", "# 标题", "", "<div class=\"x\">原样保留</div>", "", "正文段落。", ""].join("\n");
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, withOpaque]
  );
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");

  // 占位原子可见，且不可被编辑成别的东西
  await expect(page.getByTestId("opaque-block")).toHaveCount(2);

  const para = page.locator(".ProseMirror p").filter({ hasText: "正文段落" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type("（补一句）");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toBe(withOpaque.replace("正文段落。", "正文段落。（补一句）"));
});

/* ---------------------------------------------------------------------------
 * 105 段落编辑闭环：软/硬回车、跨标签、重开一致、边界段落
 * ------------------------------------------------------------------------- */

test("软回车（Shift+Enter）不拆块：仍在同一个顶层块内", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");

  const para = page.locator(".ProseMirror p").filter({ hasText: "段落甲原文在此" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("第二行");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 表格与末段各自仍是独立块：段落甲里换行没有把它裂成两块
  const blocks = saved.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  expect(blocks).toHaveLength(4); // 标题 / 段落甲(两行) / 表格 / 末段
  expect(blocks[1]).toContain("段落甲原文在此。");
  expect(blocks[1]).toMatch(/第二行/);
  expect(saved).toContain("| :--- | ---: |");
});

test("硬回车（Enter）拆成两块，两块都能各自保存且不动邻居", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");

  const para = page.locator(".ProseMirror p").filter({ hasText: "段落甲原文在此" }).first();
  await para.click();
  await page.keyboard.press("Home");
  // 「段落甲原文在此。」共 8 字，走 7 步落在「此」与「。」之间
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const blocks = saved.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  expect(blocks).toHaveLength(5); // 拆出来多一块
  // 不断言具体切在第几个字（方向键落点不是这条用例的靶心），
  // 只断言真正的不变量：两块拼回去等于原句，且没有丢字。
  expect(blocks[1] + blocks[2]).toBe("段落甲原文在此。");
  expect(blocks[1].length).toBeGreaterThan(0);
  expect(blocks[2].length).toBeGreaterThan(0);
  // 拆块没牵连邻居
  expect(saved).toContain("# 保真标题");
  expect(saved).toContain("| :--- | ---: |");
  expect(saved).toContain("末段也不许动。");
});

test("编辑后切标签再切回：改动与脏状态都还在（跨标签不丢）", async ({ page }) => {
  await seedAndOpen(page);
  await page.evaluate((p) => {
    (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, "# 另一篇\n\n另一篇的正文。\n");
  }, "/demo/另一篇.md");
  await page.evaluate(() => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/另一篇.md";
  });
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);

  // 切回 A 并进编辑模式改字
  await page.getByTestId("tabbar").locator(".tab").nth(0).click();
  await setMode(page, "edit");
  const para = page.locator(".ProseMirror p").filter({ hasText: "段落甲原文在此" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type("（跨标签）");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  // 切到 B 再切回 A
  await page.getByTestId("tabbar").locator(".tab").nth(1).click();
  await page.getByTestId("tabbar").locator(".tab").nth(0).click();
  await setMode(page, "edit");

  await expect(page.locator(".ProseMirror")).toContainText("（跨标签）");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  // 不保存直接关标签要弹确认（与 M1 006 行为一致）
  await page.locator(".tab").nth(0).hover();
  await page.locator(".tab__close").first().click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
});

test("保存后重新打开：编辑模式渲染与保存前一致", async ({ page }) => {
  // 为什么不用 page.reload()：mock 文件系统是**内存**的，重载后内容回到内置初始态，
  // 测的就不是「落盘再读回」而是 mock 的重建 —— M1 加长文档夹具时踩过同一个坑。
  // 这里改成 保存 → 关标签（已保存故不弹确认）→ 重新打开同一文件，
  // 真走一次 writeFile → readFile → 重新解析。
  // 真正的跨进程重开属桌面手工项，见 docs/测试与验收.md 的「持久化」段。
  await seedAndOpen(page);
  await setMode(page, "edit");
  const para = page.locator(".ProseMirror p").filter({ hasText: "段落甲原文在此" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type("（重开看）");
  await page.keyboard.press("Control+s");
  const saved = await savedOf(page);
  expect(saved).toContain("（重开看）");

  await page.locator(".tab").first().hover();
  await page.locator(".tab__close").first().click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(0);

  await page.evaluate((p) => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, PATH);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");

  await expect(page.locator(".ProseMirror")).toContainText("（重开看）");
  // 重开后不该一进来就是脏的
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  expect(await savedOf(page)).toBe(saved);
});

test("边界段落：空段落 / 单字符 / 纯标点被编辑时不产生异常 patch，未编辑时逐字节不动", async ({ page }) => {
  const edge = ["# 边界", "", "", "。", "", "a", "", "正常段落在这里。", ""].join("\n");
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, edge]
  );
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");

  // 只改最后一块，前面的空行、单字符、纯标点块必须一个字节都不动
  const para = page.locator(".ProseMirror p").filter({ hasText: "正常段落在这里" }).first();
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type("（改）");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toBe(edge.replace("正常段落在这里。", "正常段落在这里。（改）"));
});
