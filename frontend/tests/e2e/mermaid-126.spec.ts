import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 126：她贴的两张图（erDiagram / stateDiagram-v2）也要能双击改字。
 *
 * 125 那套就地编辑是靠 flowchart 的 DOM id 反查源码的，ER 与 state 的语法完全不同 ——
 * 这一颗补的是**按图类型分派的解析**，以及「解析得出来但故意不给改」的那一类：
 * 实体名 / 状态名是标识符，关系行里还引用着它，只改一处会让图对不上，所以只给理由不开编辑。
 */

const ER = `erDiagram
    采购申请 ||--o{ 验收单 : "发起验收"
    验收单 ||--|{ 设备清单行 : "逐行填报"
    采购申请 {
        string apply_no PK "采购申请编号"
        decimal project_amount "立项金额"
    }`;

const STATE = `stateDiagram-v2
    [*] --> 草稿: 保存草稿
    草稿 --> 审核中: 提交
    审核中 --> 已完成: 审批通过
    note right of 审核中: 提交环节阻断`;

async function openEdit(page: Page, src: string, name: string) {
  await freshSession(page);
  await gotoApp(page);
  const path = "/demo/126-" + name + ".md";
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, "# 126 " + name + "\n\n```mermaid\n" + src + "\n```\n\n段落。\n"]
  );
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");
  await page.waitForSelector('.hp-mermaidbox[data-state="done"] svg', { timeout: 30000 });
}

const 源码块 = (page: Page) => page.locator('pre[data-language="mermaid"][data-testid="pm-code-block"]');

/** 双击某段文字（按文字找元素，不押第几个 —— 渲染顺序会变） */
async function dblclickText(page: Page, text: string) {
  const box = page.locator('.hp-mermaidbox [data-hp-label="1"]', { hasText: text }).first();
  await box.dblclick({ timeout: 8000 });
  await expect(page.locator('.hp-mermaidbox [contenteditable="true"]')).toHaveCount(1, { timeout: 5000 });
}

test("erDiagram：关系标签能双击改", async ({ page }) => {
  await openEdit(page, ER, "关系标签");
  await dblclickText(page, "逐行填报");
  await page.keyboard.type("逐行核对", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect
    .poll(() => 源码块(page).innerText(), { timeout: 5000 })
    .toContain('验收单 ||--|{ 设备清单行 : "逐行核对"');
  // 别的关系行一个字没动（用 innerText 断字符串：`expect(locator).toContain` 是错的 matcher 组合）
  expect(await 源码块(page).innerText()).toContain('"发起验收"');
});

test("erDiagram：属性注释能双击改，且只有那一处变", async ({ page }) => {
  await openEdit(page, ER, "属性注释");
  const before = await 源码块(page).innerText();
  await dblclickText(page, "立项金额");
  await page.keyboard.type("立项金额（含税）", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect
    .poll(() => 源码块(page).innerText(), { timeout: 5000 })
    .toBe(before.replace('"立项金额"', '"立项金额（含税）"'));
});

test("erDiagram：实体名不给改，并说清为什么", async ({ page }) => {
  await openEdit(page, ER, "实体名");
  const before = await 源码块(page).innerText();
  await page.locator('.hp-mermaidbox [data-hp-label="no"]', { hasText: "采购申请" }).first().dblclick({ timeout: 8000 });
  await page.waitForTimeout(300);
  expect(await page.locator('.hp-mermaidbox [contenteditable="true"]').count()).toBe(0);
  await expect(page.locator(".hp-mermaidbox__hint")).toContainText("实体名");
  expect(await 源码块(page).innerText()).toBe(before);
});

test("erDiagram：属性名里打空格会被拒绝（会把一行拆成两个 token）", async ({ page }) => {
  await openEdit(page, ER, "属性名空格");
  const before = await 源码块(page).innerText();
  await dblclickText(page, "apply_no");
  await page.keyboard.type("apply no", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".hp-mermaidbox__hint")).toContainText("不带空格");
  await page.waitForTimeout(300);
  expect(await 源码块(page).innerText()).toBe(before);
});

test("stateDiagram：迁移标签能改，状态名不给改", async ({ page }) => {
  await openEdit(page, STATE, "迁移标签");
  await dblclickText(page, "审批通过");
  await page.keyboard.type("审批放行", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect.poll(() => 源码块(page).innerText(), { timeout: 5000 }).toContain("审核中 --> 已完成: 审批放行");

  const 改后 = await 源码块(page).innerText();
  await page.locator(".hp-mermaidbox g.node", { hasText: "草稿" }).first().dblclick({ timeout: 8000 });
  await page.waitForTimeout(300);
  expect(await page.locator('.hp-mermaidbox [contenteditable="true"]').count()).toBe(0);
  await expect(page.locator(".hp-mermaidbox__hint")).toContainText("状态名");
  expect(await 源码块(page).innerText()).toBe(改后);
});

test("stateDiagram：note 正文能改（单行位置，换行会被拒绝）", async ({ page }) => {
  await openEdit(page, STATE, "note");
  await dblclickText(page, "提交环节阻断");
  await page.keyboard.type("不合格时阻断提交", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect.poll(() => 源码块(page).innerText(), { timeout: 5000 }).toContain("note right of 审核中: 不合格时阻断提交");
});
