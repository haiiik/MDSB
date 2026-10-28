import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 159 片 2：双击 Mermaid 图上的一处文字，**就地给两颗键** ——
 * 「只改显示」（125 的老路：只换那一段文字）与「一起改名 N 处」（把标识符连同所有引用位一起换）。
 *
 * 三条判据是这颗功能的全部风险，都对应真缺陷：
 * ① **处数写在按钮上**：点之前就该知道会动几处；数不到标识符位时**那颗键不摆**
 *    （摆一颗点下去必然被拒绝的键 = 请人去撞墙）；
 * ② **点键不能变成两次写盘**：编辑区一失焦就提交（125 的口径），而点任何键必然先失焦 ——
 *    挡住 `mousedown` 的默认行为才是一段撤销，`Ctrl+Z` 一次要能回到改字前；
 * ③ **拒绝时一个字都不写**，并把理由说出口（新名字带空格 / 撞名 / 源码被别处改过）。
 */

const FLOW = `flowchart LR
  A[起步] --> B[读 A 的值]
  B --> A`;

const EDGE = `flowchart LR
  A -->|起步| B`;

const ER = `erDiagram
  采购申请 {
    string 编号 PK
  }
  采购申请 ||--o{ 验收单 : "发起验收"`;

async function openEdit(page: Page, src: string, name: string): Promise<string> {
  await freshSession(page);
  await gotoApp(page);
  const path = "/demo/159-" + name + ".md";
  const doc = "# 159 " + name + "\n\n```mermaid\n" + src + "\n```\n\n段落。\n";
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, doc]
  );
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");
  await page.waitForSelector('.hp-mermaidbox[data-state="done"] svg', { timeout: 30_000 });
  return doc;
}

const 源码块 = (page: Page) => page.locator('pre[data-language="mermaid"][data-testid="pm-code-block"]');
const 键栏 = (page: Page) => page.locator('[data-testid="pm-mermaid-actions"]');
const 只改显示 = (page: Page) => page.locator('[data-testid="pm-mermaid-display"]');
const 一起改名 = (page: Page) => page.locator('[data-testid="pm-mermaid-rename"]');
const 提示条 = (page: Page) => page.locator(".hp-mermaidbox__hint");

/** 双击图上那段文字，等编辑态开起来（按文字找元素，不押第几个 —— 渲染顺序会变） */
async function 双击改字(page: Page, text: string): Promise<void> {
  await page
    .locator('.hp-mermaidbox [data-hp-label="1"]', { hasText: text })
    .first()
    .dblclick({ timeout: 8000 });
  await expect(page.locator('.hp-mermaidbox [contenteditable="true"]')).toHaveCount(1, { timeout: 5000 });
  await expect(键栏(page)).toBeVisible({ timeout: 5000 });
}

/**
 * 把编辑区里的整段选中，换成新文字（两颗键都拿这段文字当输入）。
 *
 * 这里**不能用 `Ctrl+A`**：焦点在 contenteditable 里时 PM 的键位表会先接住它，
 * 实测一次 `Ctrl+A` 选中的是**整篇文档**，跟着打进去的字把首行标题换掉了、
 * Mermaid 块整个消失 —— 判据于是红在"找不到元素"，看着像产品坏了。
 * 换成显式 DOM Range 只框住这一处编辑区（142/146 那条老纪律的第三次兑现）。
 */
async function 换新文字(page: Page, text: string): Promise<void> {
  const box = page.locator('.hp-mermaidbox [contenteditable="true"]');
  await box.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  });
  await page.keyboard.type(text, { delay: 30 });
}

/**
 * 落盘判据的固定三步（142 / 146 定的口径）：**Ctrl+S → 等脏标记熄灭 → 再读盘**。
 * 少等那一步读到的是旧文件，症状长得像"改名没生效"。
 */
async function 存盘读盘(page: Page, name: string): Promise<string> {
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0, { timeout: 10_000 });
  const 盘上 = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    "/demo/159-" + name + ".md"
  );
  expect(盘上, "mock 里那份文件要读得到").not.toBeNull();
  return 盘上 as string;
}

test("flowchart 节点标签：两颗都在，按钮上写着处数", async ({ page }) => {  await openEdit(page, FLOW, "两颗键");
  await 双击改字(page, "起步");
  await expect(只改显示(page)).toBeVisible();
  await expect(一起改名(page)).toBeVisible();
  // A 出现在声明头与 `B --> A` = 2 处；`B[读 A 的值]` 那个 A 在标签正文里，不算
  await expect(一起改名(page)).toContainText("2");
});

test("纯边标签：只给一颗，那颗「一起改名」不摆出来", async ({ page }) => {
  await openEdit(page, EDGE, "边标签");
  await 双击改字(page, "起步");
  await expect(只改显示(page)).toBeVisible();
  await expect(一起改名(page)).toBeHidden();
});

test("点「一起改名」：声明与引用位一起变，标签正文里那个同名一个字不动", async ({ page }) => {
  const 原文 = await openEdit(page, FLOW, "改名落盘");
  await 双击改字(page, "起步");
  await 换新文字(page, "受理");
  await 一起改名(page).click();
  const 期望 = 原文
    .replace("A[起步]", "受理[起步]")
    .replace("B --> A", "B --> 受理");
  await expect
    .poll(() => 源码块(page).innerText(), { timeout: 8000 })
    .toContain("受理[起步]");
  const 盘上 = await 存盘读盘(page, "改名落盘");
  expect(盘上, "落盘整篇要逐字节等于预期").toBe(期望);
  // 标签正文里那个 A 是内容不是引用
  expect(盘上).toContain("[读 A 的值]");
});

test("撤销一次回到改字前（点键不是「先按显示提交一次、再改名一次」）", async ({ page }) => {
  await openEdit(page, FLOW, "一步撤销");
  await 双击改字(page, "起步");
  await 换新文字(page, "受理");
  await 一起改名(page).click();
  await expect.poll(() => 源码块(page).innerText(), { timeout: 8000 }).toContain("受理[起步]");
  // 只发生了**一次**写盘：显示文字还是"起步"，没有先被 blur 提交成"A[受理]"再改名
  expect(await 源码块(page).innerText()).not.toContain("A[受理]");
  // 只退**一段**：一次 Ctrl+Z 就该回到双击之前，而不是先退改名再退那次"多余的显示提交"
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => 源码块(page).innerText(), { timeout: 8000 })
    .toContain("A[起步] --> B[读 A 的值]\n  B --> A");
  expect(await 源码块(page).innerText()).not.toContain("受理");
});

test("回车照旧只改显示：别处的引用位不动", async ({ page }) => {
  await openEdit(page, FLOW, "回车只改显示");
  await 双击改字(page, "起步");
  await 换新文字(page, "开始");
  await page.keyboard.press("Enter");
  await expect.poll(() => 源码块(page).innerText(), { timeout: 8000 }).toContain("A[开始]");
  const 改后 = await 源码块(page).innerText();
  // 名字没动：声明头还是 A、引用位还是 A；只有那一段显示文字换了
  expect(改后).toContain("B --> A");
  expect(改后).not.toContain("开始 -->");
  expect(改后).toContain("[读 A 的值]");
});

test("Esc 取消：源码一个字不动，屏幕上的文字还原装回去", async ({ page }) => {
  await openEdit(page, FLOW, "取消还原");
  await 双击改字(page, "起步");
  await 换新文字(page, "受理");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // 源码那一行原样（不是"包含空串"这种永远成立的判据）
  expect(await 源码块(page).innerText()).toContain("A[起步] --> B[读 A 的值]");
  expect(await 源码块(page).innerText()).not.toContain("受理");
  await expect(键栏(page)).toBeHidden();
  await expect
    .poll(() => page.locator('.hp-mermaidbox [data-hp-label="1"]').first().innerText(), { timeout: 8000 })
    .toContain("起步");
});

test("新名字不合法（带空格）：拒绝、说清为什么、源码不动", async ({ page }) => {
  const 原文 = await openEdit(page, FLOW, "非法名");
  await 双击改字(page, "起步");
  await 换新文字(page, "带 空格");
  await 一起改名(page).click();
  await expect(提示条(page)).toContainText("不能当名字用", { timeout: 8000 });
  await page.waitForTimeout(300);
  expect(await 源码块(page).innerText()).toContain("A[起步]");
  expect(原文).toContain("A[起步]");
});

test("ER 实体名：双击不再一口回绝，两颗键都在", async ({ page }) => {
  await openEdit(page, ER, "实体名两颗键");
  await 双击改字(page, "采购申请");
  await expect(只改显示(page)).toBeVisible();
  await expect(一起改名(page)).toBeVisible();
  // 声明头 + 关系行 = 2 处
  await expect(一起改名(page)).toContainText("2");
});

test("ER 实体名「一起改名」：声明与关系行两端一起换", async ({ page }) => {
  const 原文 = await openEdit(page, ER, "实体名改名");
  await 双击改字(page, "采购申请");
  await 换新文字(page, "请购单");
  await 一起改名(page).click();
  await expect.poll(() => 源码块(page).innerText(), { timeout: 8000 }).toContain("请购单 {");
  const 盘上 = await 存盘读盘(page, "实体名改名");
  expect(盘上).toContain("请购单 ||--o{ 验收单");
  expect(盘上).not.toContain("采购申请");
  expect(原文).toContain("采购申请");
});

test("ER 实体名「只改显示」：写进去的是别名，名字本身不动", async ({ page }) => {
  await openEdit(page, ER, "实体名别名");
  await 双击改字(page, "采购申请");
  await 换新文字(page, "请购单");
  await 只改显示(page).click();
  await expect.poll(() => 源码块(page).innerText(), { timeout: 8000 }).toContain('采购申请["请购单"]');
  const 盘上 = await 存盘读盘(page, "实体名别名");
  // 盘上真落下了这条别名（不放"没变化也算过"的判据）
  expect(盘上).toContain('采购申请["请购单"]');
  // 别名只是"显示名"，引用位照旧用名字
  expect(盘上).toContain("采购申请 ||--o{ 验收单");
  expect(盘上).not.toContain("请购单 ||--o{");
});

/* ---------------- 片 3：同一段文字出现在多处，点哪个改哪一处 ---------------- */

/** 编辑器有两种：HTML 标签是 contenteditable，SVG `<text>` 是盖上去的输入框（127） */
const 编辑器 = (page: Page) =>
  page
    .locator('.hp-mermaidbox [contenteditable="true"], .hp-mermaidbox [data-testid="pm-mermaid-label-input"]')
    .first();

/** 双击第 n 处（从 0 数），等编辑态开起来 */
async function 双击第处(page: Page, text: string, n: number): Promise<void> {
  const 目标 = page.locator('.hp-mermaidbox [data-hp-label="1"]').filter({ hasText: text }).nth(n);
  await 目标.dblclick({ timeout: 8000 });
  await expect(编辑器(page)).toBeVisible({ timeout: 5000 });
  await expect(键栏(page)).toBeVisible({ timeout: 5000 });
}

/** 把当前编辑器里的文字换掉（两种控件各走各的合法路子） */
async function 换成(page: Page, text: string): Promise<void> {
  const ed = 编辑器(page);
  const tag = await ed.evaluate((el) => el.tagName);
  if (tag === "INPUT") {
    await ed.fill(text);
    return;
  }
  await ed.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  });
  await page.keyboard.type(text, { delay: 30 });
}

const SEQ = "sequenceDiagram\n  participant 甲\n  participant 乙\n  甲->>乙: 重复\n  乙->>甲: 重复";

const ER重复 = `erDiagram
  验收单 {
    decimal 金额 "必填"
    string 备注 "必填"
  }`;

test("片3 两处都标成可改（不再整组拒绝）", async ({ page }) => {
  await openEdit(page, SEQ, "两处都可改");
  await expect(
    page.locator('.hp-mermaidbox [data-hp-label="1"]').filter({ hasText: "重复" })
  ).toHaveCount(2);
  expect(await page.locator('.hp-mermaidbox [data-hp-label="no"]').filter({ hasText: "重复" }).count()).toBe(0);
});

test("片3 双击第二处：只改第二处，第一处一个字不动", async ({ page }) => {
  const 原文 = await openEdit(page, SEQ, "改第二处");
  await 双击第处(page, "重复", 1);
  await 换成(page, "提交放行");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => 源码块(page).innerText(), { timeout: 8000 })
    .toContain("乙->>甲: 提交放行");
  const 盘上 = await 存盘读盘(page, "改第二处");
  // 第一处照旧（这条是"点哪个改哪一处"的全部意义：写错地方比写不成更坏）
  expect(盘上).toContain("甲->>乙: 重复");
  expect(盘上).toContain("乙->>甲: 提交放行");
  expect(盘上).not.toContain("甲->>乙: 提交放行");
  expect(原文).toContain("甲->>乙: 重复");
});

test("片3 双击第一处：只改第一处（同一个夹具反方向再来一次）", async ({ page }) => {
  await openEdit(page, SEQ, "改第一处");
  await 双击第处(page, "重复", 0);
  await 换成(page, "发起");
  await page.keyboard.press("Enter");
  const 盘上 = await 存盘读盘(page, "改第一处");
  expect(盘上).toContain("甲->>乙: 发起");
  expect(盘上).toContain("乙->>甲: 重复");
  expect(盘上).not.toContain("乙->>甲: 发起");
});

test("片3 ER 两格相同注释：改第二格，第一格仍是原文字（HTML 标签那条路）", async ({ page }) => {
  await openEdit(page, ER重复, "ER两格");
  await 双击第处(page, "必填", 1);
  await 换成(page, "选填");
  await page.keyboard.press("Enter");
  await expect.poll(() => 源码块(page).innerText(), { timeout: 8000 }).toContain('string 备注 "选填"');
  const 盘上 = await 存盘读盘(page, "ER两格");
  expect(盘上).toContain('decimal 金额 "必填"');
  expect(盘上).toContain('string 备注 "选填"');
  expect(盘上.match(/必填/g), "只剩一处必填").toHaveLength(1);
});
