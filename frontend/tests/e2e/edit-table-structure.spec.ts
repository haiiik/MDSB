import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 112：表格结构操作（US-33 后半）。
 *
 * 这一颗的靶心是**右键菜单**：菜单弹出/关闭、每一项执行后落盘的字节、
 * 以及边界项置灰（点了没反应也不能报错）。命令本身的边界条件在单测里钉
 * （`tests/unit/table-structure.spec.ts`），这里只管「接上 UI 后是否真的可用」。
 */

const PATH = "/demo/表格结构.md";

const DOC = [
  "# 模式表",
  "",
  "| 模式 | 快捷键 |",
  "| :--- | ---: |",
  "| 阅读 | Ctrl+1 |",
  "| 源码 | Ctrl+3 |",
  "",
  "末段不动。",
  "",
].join("\n");

async function seedAndOpen(page: Page, doc = DOC) {
  // gotoApp 里已经等了 mock 宿主挂上 window（见 tests/e2e/mockApp.ts 的说明）
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
  await expect(page.locator(".ProseMirror table")).toBeVisible();
}

async function savedOf(page: Page): Promise<string> {
  return page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );
}

/** 表格行（含分隔行），按源文本顺序 */
const tableRows = (md: string) => md.split("\n").filter((l) => l.trim().startsWith("|"));

/** 右键某一格，返回菜单定位器 */
async function rightClickCell(page: Page, selector: string) {
  await page.locator(selector).first().click({ button: "right" });
  const menu = page.getByTestId("table-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function clickMenuItem(page: Page, label: string) {
  await page.getByTestId("table-menu-item").filter({ hasText: label }).click();
  await expect(page.getByTestId("table-menu")).toHaveCount(0);
}

test("右键单元格出菜单，11 项齐全", async ({ page }) => {
  await seedAndOpen(page);
  const menu = await rightClickCell(page, ".ProseMirror td");
  await expect(menu.getByTestId("table-menu-item")).toHaveCount(11);
  // 分隔线不参与点击
  await expect(menu.locator(".hp-tablemenu__sep")).toHaveCount(2);
});

test("下方插入行：落盘多一行、块外逐字节不变", async ({ page }) => {
  await seedAndOpen(page);
  await rightClickCell(page, ".ProseMirror td");
  await clickMenuItem(page, "下方插入行");

  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved.startsWith("# 模式表\n\n")).toBe(true);
  expect(saved).toContain("末段不动。\n");
  const rows = tableRows(saved);
  // 表头 + 分隔 + 3 数据行
  expect(rows).toHaveLength(5);
  expect(rows[0]).toContain("模式");
  expect(rows[1]).toMatch(/:---|---:/);
  // 「下方插入行」插在第一数据行（阅读）之后 → 第 4 行是新的空格子，原「源码」行后移
  expect(rows[2].split("|").map((c) => c.trim()).filter(Boolean)).toEqual(["阅读", "Ctrl+1"]);
  expect(rows[3].split("|").map((c) => c.trim()).filter(Boolean)).toHaveLength(0);
  expect(rows[4].split("|").map((c) => c.trim()).filter(Boolean)).toEqual(["源码", "Ctrl+3"]);
});

test("右移一列：内容与对齐一起搬", async ({ page }) => {
  await seedAndOpen(page);
  await rightClickCell(page, ".ProseMirror td");
  await clickMenuItem(page, "右移一列");
  await page.keyboard.press("Control+s");

  const rows = tableRows(await savedOf(page));
  const cellsOf = (line: string) => line.split("|").map((c) => c.trim()).filter(Boolean);
  // 原本 列0=模式(左对齐 `:---`)、列1=快捷键(右对齐 `---:`)；
  // 右键落在**第一数据行的第一格**（「阅读」）→ 搬的是这一列，整表一起动
  expect(cellsOf(rows[0])).toEqual(["快捷键", "模式"]);
  expect(cellsOf(rows[2])).toEqual(["Ctrl+1", "阅读"]);
  // 对齐标记跟着列走（破折号数量由补齐列宽决定，不断言）
  const sep = cellsOf(rows[1]);
  expect(sep[0].endsWith(":")).toBe(true);
  expect(sep[0].startsWith(":")).toBe(false);
  expect(sep[1].startsWith(":")).toBe(true);
  expect(sep[1].endsWith(":")).toBe(false);
});

test("删除本列：列数 -1，剩下另一列的内容", async ({ page }) => {
  await seedAndOpen(page);
  await rightClickCell(page, ".ProseMirror td");
  await clickMenuItem(page, "删除本列");
  await page.keyboard.press("Control+s");

  const rows = tableRows(await savedOf(page));
  const cellsOf = (line: string) => line.split("|").map((c) => c.trim()).filter(Boolean);
  expect(cellsOf(rows[0])).toEqual(["快捷键"]);
  expect(cellsOf(rows[2])).toEqual(["Ctrl+1"]);
  // 一列的表格仍带分隔行 —— 合法 GFM
  expect(rows[1]).toMatch(/^[|\s:-]+$/);
});

test("取消表头再设回来：th/td 数量跟着变，往返不丢内容", async ({ page }) => {
  await seedAndOpen(page);
  await expect(page.locator(".ProseMirror th")).toHaveCount(2);

  await rightClickCell(page, ".ProseMirror th");
  await clickMenuItem(page, "设为表头 / 取消表头");
  await expect(page.locator(".ProseMirror th")).toHaveCount(0);

  await rightClickCell(page, ".ProseMirror tr td");
  await clickMenuItem(page, "设为表头 / 取消表头");
  await expect(page.locator(".ProseMirror th")).toHaveCount(2);

  await page.keyboard.press("Control+s");
  const rows = tableRows(await savedOf(page));
  expect(rows[0]).toContain("模式");
  expect(rows[0]).toContain("快捷键");
  expect(rows[1]).toMatch(/:---/);
});

test("只剩一列一行的表：删除本行/本列置灰，点了不抛异常、内容不变", async ({ page }) => {
  // 只收未捕获异常（`pageerror`）。控制台里的 404 是浏览器自己请求 /favicon.ico，
  // 预览服务器没有该文件，与本颗无关
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await seedAndOpen(page, "| 模式 |\n| :--- |\n\n段落。\n");
  const menu = await rightClickCell(page, ".ProseMirror th");

  const disabled = menu.locator(".hp-tablemenu__item.is-disabled");
  // 一列一行：行方向除了「下方插入行」都不能动；列方向只能插不能移/删
  await expect(disabled).toHaveCount(7);
  await expect(menu.getByTestId("table-menu-item").filter({ hasText: "删除本行" })).toHaveClass(/is-disabled/);
  await expect(menu.getByTestId("table-menu-item").filter({ hasText: "删除本列" })).toHaveClass(/is-disabled/);

  await clickMenuItem(page, "删除本列");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  // 表格没被动过：仍是一行一列
  await expect(page.locator(".ProseMirror tr")).toHaveCount(1);
  await expect(page.locator(".ProseMirror th")).toHaveCount(1);
  expect(errors).toEqual([]);
});

/*
 * 「一次结构操作 = 一步撤销」不在这里验：编辑模式目前**还没接 `prosemirror-history`**
 * （Ctrl+Z 现在什么都不做），history 插件与合并窗口是 117 的活。
 * 112 只把前提钉住 —— 每个结构操作只派发**一个**事务（见单测），
 * 117 接上撤销后天然就是「一步」。
 */

test("菜单只认表格：右键普通段落不弹菜单（浏览器原生菜单照常）", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror p").last().click({ button: "right" });
  await expect(page.getByTestId("table-menu")).toHaveCount(0);
});

test("菜单始终在视口内；Esc 能关掉", async ({ page }) => {
  await seedAndOpen(page);
  const vp = page.viewportSize()!;

  // 最右一格：菜单位置最容易溢出右缘
  await page.locator(".ProseMirror th").last().click({ button: "right" });
  const menu = page.getByTestId("table-menu");
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Esc 关掉后能重新打开并执行：旧菜单的全局监听若不摘干净，
  // 重开后的点击会先被旧监听当成「点了外面」而整体关掉
  await page.locator(".ProseMirror th").last().click({ button: "right" });
  await expect(menu.getByTestId("table-menu-item")).toHaveCount(11);
  await clickMenuItem(page, "右侧插入列");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
});

test("连续两次「选中菜单项」都要生效（关菜单时得摘掉全局监听）", async ({ page }) => {
  await seedAndOpen(page);

  // 第一次：插一行
  await rightClickCell(page, ".ProseMirror td");
  await clickMenuItem(page, "下方插入行");
  // 第二次：菜单是被「选中菜单项」这条路径关掉的，此时上一轮的 mousedown 监听
  // 若还挂在 document 上，本轮点菜单项会先被它关掉，命令根本执行不到
  await rightClickCell(page, ".ProseMirror td");
  await clickMenuItem(page, "下方插入行");

  await page.keyboard.press("Control+s");
  // 表头 + 分隔 + 4 数据行
  expect(tableRows(await savedOf(page))).toHaveLength(6);
});

test("点菜单外面会关掉；结构操作后重开渲染正常", async ({ page }) => {
  await seedAndOpen(page);
  await rightClickCell(page, ".ProseMirror td");
  await page.locator(".ProseMirror p").first().click();
  await expect(page.getByTestId("table-menu")).toHaveCount(0);

  // 走一遍结构操作并保存，再切回阅读模式看渲染
  await page.locator(".ProseMirror td").first().click({ button: "right" });
  await clickMenuItem(page, "下方插入行");
  await page.keyboard.press("Control+s");

  const root = page.getByTestId("document-root");
  await setMode(page, "read");
  await expect(root.locator("table")).toBeVisible();
  await expect(root.locator("table th")).toHaveCount(2);
  // 表头 1 行 + 数据 3 行（原有 2 行 + 新插入 1 行）
  await expect(root.locator("table tbody tr")).toHaveCount(3);
});
