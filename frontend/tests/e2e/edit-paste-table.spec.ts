import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 115：外部表格粘贴 → 合法 GFM 表格（US-34）。
 *
 * 合并规则、补列不丢字、MIME 优先级都在 `tests/unit/paste-table.spec.ts` 里钉了；
 * 这里验的是**接上真编辑器之后**：注入的剪贴板数据真的变成表格、
 * 落在光标处、光标在表格里时真的并入那张表，以及落盘的字节形状对。
 */

const DOC = "# 表\n\n正文段落。\n\n| 模式 | 快捷键 |\n| :--- | ---: |\n| 阅读 | Ctrl+1 |\n| 源码 | Ctrl+3 |\n\n末段不动。\n";

/**
 * 每条用例一份**独立路径**。
 *
 * 共用同一个路径时，上一条用例留下的会话（mock 把状态存 localStorage）会被下一条
 * 恢复成已打开的标签，`savedOf` 读回来的是别人的结果 —— 115 并行跑时就这样假红过。
 * 用 `test.info().title` 派生路径，谁也不撞谁。
 */
let path = "";

/**
 * 115 的两条「光标在表格里粘贴」都靠 `td.click()` 拿选区，但**点击不等于选区已经落进那一格**：
 * 粘贴如果发生在选区还在文档开头的时候，粘出来的表会排到文首、还把 H1 的字吃掉
 * （这条假红在真跑里稳定复现，症状长得像「补齐逻辑写错了」，其实是粘贴的时机）。
 * 所以粘之前先**确认选区真的在表格单元格里** —— 判据要测自己。
 */
const 光标在格子里 = (page: Page) =>
  page.evaluate(() => {
    const s = window.getSelection();
    const n = s?.anchorNode;
    if (!n) return false;
    const el = n.nodeType === 1 ? (n as Element) : (n as Element).parentElement;
    return !!el && !!el.closest(".ProseMirror td, .ProseMirror th");
  });

const 把光标放进第一格 = async (page: Page) => {
  await page.locator(".ProseMirror td").first().click();
  await expect
    .poll(() => 光标在格子里(page), { timeout: 4000, message: "选区没落进表格单元格，粘贴会粘到文首" })
    .toBe(true);
};

async function seedAndOpen(page: Page, doc = DOC) {
  path = "/demo/粘贴表格-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, doc]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror table")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

/**
 * Ctrl+S 之后**等脏标记熄灭**再读盘。
 *
 * 原来这里是 `press("Control+s")` 紧接着 `savedOf(page)` —— 读得比写盘早，
 * 拿回来的是**没改过的原文**。最坏的是症状长得像产品缺陷：
 * 「粘进去的块排到表前面了」（`indexOf("| 源码")` 得 94、`indexOf("## 小标题")` 得 -1），
 * 于是人去查粘贴逻辑，而粘贴是对的。4 worker 并行 + 同机跑构建时最先红的就是它，
 * 单跑又常常是绿的 —— **假红最贵的地方在于它骗你改错代码**。
 * `edit-fidelity.spec.ts` 一直是等脏标记的，这条对齐过去。
 */
const pressSave = async (page: Page) => {
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
};

const paste = (page: Page, payload: { html?: string; text?: string }) =>
  page.evaluate((p) => (window as unknown as { __hpMockPaste: (x: unknown) => void }).__hpMockPaste(p), payload);

/**
 * 取 `after` 之后的**第一张**表格（连续的 `|` 行）。
 *
 * 不能只 filter 出所有 `|` 行：这份夹具里本来就有另一张表（模式/快捷键），
 * 一起数就会把两张表的行数加在一起（第一次就这么假红了）。
 */
function tableRows(md: string, after = "") {
  const lines = md.slice(after ? md.indexOf(after) : 0).split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("|"));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith("|"); i++) out.push(lines[i]);
  return out;
}

test("Excel 只给纯文本（TSV）时也变成表格，落在光标处", async ({ page }) => {
  await seedAndOpen(page);
  await placeCaret(page, ".ProseMirror p", -1, 0); // 「正文段落。」末尾
  await paste(page, { text: "部门\t慢单数\t占比\n采油作业区\t1234\t12%\n集输作业区\t56\t\n" });
  await pressSave(page);

  const saved = await savedOf(page);
  const rows = tableRows(saved, "正文段落。");
  expect(rows).toHaveLength(4); // 表头 + 分隔 + 2 数据行
  // 空格子要算数，所以按位置切而不是 filter(Boolean)
  const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
  for (const r of rows) expect(cells(r)).toHaveLength(3);
  expect(rows[0]).toContain("部门");
  // 块外不动
  expect(saved).toContain("# 表\n\n");
  expect(saved).toContain("末段不动。\n");
  expect(saved).toContain("| 模式 | 快捷键 |");
});

test("Excel 的 HTML（对齐只写在 style 里）粘贴后对齐标记正确", async ({ page }) => {
  await seedAndOpen(page);
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await paste(page, {
    html:
      "<table class=xl65 style='border-collapse:collapse'>" +
      "<tr><td style='text-align:left'>部门</td><td style='text-align:right'>慢单数</td><td style='text-align:center'>占比</td></tr>" +
      "<tr><td>采油</td><td style='text-align:right'>1,234</td><td style='text-align:center'>12%</td></tr></table>",
  });
  await pressSave(page);

  const rows = tableRows(await savedOf(page), "正文段落。");
  const sep = rows[1].split("|").map((c) => c.trim()).filter(Boolean);
  expect(sep[0].startsWith(":")).toBe(true);
  expect(sep[1].endsWith(":")).toBe(true);
  expect(sep[2].startsWith(":") && sep[2].endsWith(":")).toBe(true);
  // 样式与 class 一个都不留
  expect(rows.join("\n")).not.toMatch(/style|class|collapse|xl65/);
});

test("光标在表格里粘贴表格 → 并入这张表，不出现嵌套表", async ({ page }) => {
  await seedAndOpen(page);
  await 把光标放进第一格(page); // 「阅读」那一行
  await paste(page, { html: "<table><tr><td>粘贴</td><td>进来</td></tr></table>" });

  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  await expect(page.locator(".ProseMirror tr")).toHaveCount(4); // 表头 + 3 数据行

  await pressSave(page);
  const rows = tableRows(await savedOf(page), "# 表");
  expect(rows).toHaveLength(5); // 表头 + 分隔 + 3 数据行
  expect(rows[3]).toContain("粘贴");
  expect(rows[3]).toContain("进来");
  // 原有两行都还在
  expect(rows[2]).toContain("阅读");
  expect(rows[4]).toContain("源码");
});

test("列数不一致的表格并入时两边补齐，谁的内容都不丢", async ({ page }) => {
  await seedAndOpen(page);
  await 把光标放进第一格(page);
  await paste(page, { html: "<table><tr><td>甲</td><td>乙</td><td>丙</td></tr></table>" });
  await pressSave(page);

  const rows = tableRows(await savedOf(page), "# 表");
  const cells = (l: string) => l.split("|").map((c) => c.trim()).filter(Boolean);
  for (const r of rows) expect(cells(r).length).toBeLessThanOrEqual(3);
  // 宿主两列的行被补成三列（第三格空），粘贴行三列齐全
  expect(rows[2]).toContain("阅读");
  expect(rows[3]).toContain("丙");
  expect(rows[4]).toContain("源码");
});

test("单元格里有竖线：转义后不串列", async ({ page }) => {
  await seedAndOpen(page);
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await paste(page, { html: "<table><tr><td>含 | 竖线</td><td>正常</td></tr><tr><td>a\\|b</td><td>2</td></tr></table>" });
  await pressSave(page);

  const rows = tableRows(await savedOf(page), "正文段落。");
  for (const r of rows) {
    // 未转义的竖线数必须一致（每行 3 个：两端 + 中间）
    expect((r.replace(/\\\|/g, "").match(/\|/g) ?? []).length).toBe(3);
  }
  expect(rows[2]).toContain("\\|");
});

test("光标在单元格里粘「多块」富文本 → 表不许被劈开（桌面实测抓到的缺陷）", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror td").first().click(); // 「阅读」那一格
  await paste(page, {
    html: "<h2>小标题</h2><p>带<b>粗体</b>的一段。</p><ul><li>列表甲</li><li>列表乙</li></ul>",
  });
  // 直接 replaceSelection 会让 PM 把宿主表从这一行切开：表变成两张、下半截还多出个假表头
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  await expect(page.locator(".ProseMirror tr")).toHaveCount(3); // 表头 + 原有两行，一行没少

  await pressSave(page);
  const saved = await savedOf(page);
  expect(tableRows(saved, "")).toHaveLength(4); // 表头 + 分隔行 + 原有两行数据
  expect(saved).toContain("| 阅读 |");
  expect(saved).toContain("| 源码 |");
  // 粘的块整组落在**那张表下面**
  expect(saved.indexOf("| 源码")).toBeLessThan(saved.indexOf("## 小标题"));
  expect(saved).toContain("- 列表甲");
  expect(saved).toContain("- 列表乙");
  expect(saved).toContain("**粗体**");
});

test("超宽表（20 列）粘贴不崩，读回来看仍是 20 列", async ({ page }) => {
  const cols = Array.from({ length: 20 }, (_, i) => `<th>列${i + 1}</th>`).join("");
  const body = Array.from({ length: 20 }, (_, i) => `<td>v${i}</td>`).join("");
  await seedAndOpen(page);
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await paste(page, { html: `<table><tr>${cols}</tr><tr>${body}</tr></table>` });
  await pressSave(page);

  const rows = tableRows(await savedOf(page), "正文段落。");
  const cells = (l: string) => l.split("|").slice(1, -1);
  for (const r of rows) expect(cells(r)).toHaveLength(20);
  expect(rows[0]).toContain("列20");

  // 夹具里本来就有另一张表，必须按「第一张 = 刚粘贴的那张」来数，
  // 直接 `.hp-doc table th` 会把两张表的表头加在一起（22 ≠ 20，就这么假红过）。
  await setMode(page, "read");
  const tables = page.locator(".hp-doc table");
  await expect(tables).toHaveCount(2);
  await expect(tables.first().locator("th")).toHaveCount(20);
  await expect(tables.first().locator("td")).toHaveCount(20);
});
