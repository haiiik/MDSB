import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 127：Mermaid 双击改字**不再只限 flowchart / ER / 状态图**。
 *
 * 做法换成「从渲染产物倒查源码」：屏幕上这行字，在源码里**只出现一次**才给改，
 * 出现多次或有歧义就拒绝并说明原因（认错会把用户的图改坏）。
 * 这条路的代价是不用再为每种图写一个解析器，好处是 mermaid 加图类型我们不跟着改。
 *
 * SVG `<text>` 那类（sequence / pie / gantt / timeline）不能挂 contenteditable
 * —— 探针实测 `contentEditable` 属性在 SVG 元素上不存在、focus 也进不去，
 * 所以它们走**盖在字上面的输入框**。用例里两条路都要验到，且都验「只改那一处」。
 */

const PATH = "/demo/各类型改字.md";

async function openDiagram(page: Page, body: string) {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, `# 图\n\n\`\`\`mermaid\n${body}\`\`\`\n`]
  );
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");
  const preview = page.getByTestId("pm-mermaid-preview");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  return preview;
}

const disk = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );

/**
 * Ctrl+S 落盘后读文件。
 *
 * 「双击改字」只动**编辑档的工作副本**，不自动写文件（010/006 的口径：保存是显式动作），
 * 所以断言「源码那一处真的换了」必须先按一次 Ctrl+S。
 * 等脏点熄灭再读 —— 不然拿到的是保存还没落地时的旧内容（异步边界，不是产品问题）。
 */
async function saveThenRead(page: Page, 期望出现在源码里的新字: string): Promise<string> {
  // 同步点①：图下方那个源码块是 PM 的 code_block，它换字 = 事务真的落地了
  await expect(page.locator('pre[data-language="mermaid"] code')).toContainText(期望出现在源码里的新字, {
    timeout: 10_000,
  });
  // 同步点②：104 的回写是防抖的，脏点熄了才说明 `tab.markdown` 已经带着新内容存进文件
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0, { timeout: 10_000 });
  return disk(page);
}

/** 找到图上那段字（HTML 标签或 SVG 文字都算），返回它的定位描述 */
const label = (preview: Page, text: string) =>
  preview.locator(`[data-hp-label]`, { hasText: text }).first();

/** 覆盖输入框（SVG 文字那条路） */
const input = (preview: Page) => preview.getByTestId("pm-mermaid-label-input");

const SEQ = "sequenceDiagram\n  participant 员工\n  participant 系统\n  员工->>系统: 提交申请\n  系统-->>员工: 受理回执\n";

test("sequenceDiagram：双击消息文字改成新内容，参与者名与其余行不动", async ({ page }) => {
  const preview = await openDiagram(page, SEQ);

  // ① 这条走覆盖输入框：`<text class="messageText">` 是 SVG 文字
  const box = label(preview, "提交申请");
  await expect(box).toHaveAttribute("data-hp-label", "1");
  const 字 = await box.boundingBox();
  await box.dblclick();
  await expect(input(preview)).toBeVisible();
  await expect(input(preview)).toHaveValue("提交申请");
  // 输入框要盖在那行字上 —— 不是随便找个地方弹个框
  const 框 = await input(preview).boundingBox();
  expect(框!.x + 框!.width / 2).toBeGreaterThanOrEqual(字!.x - 8);
  expect(框!.x + 框!.width / 2).toBeLessThanOrEqual(字!.x + 字!.width + 8);
  expect(框!.y + 框!.height / 2).toBeGreaterThanOrEqual(字!.y - 10);
  expect(框!.y + 框!.height / 2).toBeLessThanOrEqual(字!.y + 字!.height + 10);

  await input(preview).fill("递交申请单");
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 20_000 });

  const src = await saveThenRead(page, "递交申请单");
  expect(src).toContain("员工->>系统: 递交申请单");
  expect(src).toContain("participant 员工");
  expect(src).toContain("系统-->>员工: 受理回执");
  expect(src).not.toContain("提交申请");
  // 输入框用完就走，不留一个空壳在图上
  await expect(input(preview)).toHaveCount(0);
});

test("sequenceDiagram：Esc 取消什么都不写", async ({ page }) => {
  const preview = await openDiagram(page, SEQ);
  await label(preview, "受理回执").dblclick();
  await input(preview).fill("改坏了也不该留");
  await page.keyboard.press("Escape");
  await expect(input(preview)).toHaveCount(0);
  expect(await disk(page)).toContain("系统-->>员工: 受理回执");
});

test("pie：图例文字可改；百分比是算出来的，拒绝并说明", async ({ page }) => {
  const preview = await openDiagram(page, 'pie title 各状态占比\n  "草稿" : 34\n  "审核中" : 12\n');

  await expect(label(preview, "草稿")).toHaveAttribute("data-hp-label", "1");
  await label(preview, "草稿").dblclick();
  await input(preview).fill("待提交");
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  const src = await saveThenRead(page, "待提交");
  expect(src).toContain('"待提交" : 34');
  expect(src).toContain('"审核中" : 12');

  // 百分比不是用户写的字 → 挂「不能改」，双击给的是**具体**理由
  const pct = preview.locator("text.slice").first();
  await expect(pct).toHaveAttribute("data-hp-label", "no");
  const title = await pct.getAttribute("title");
  expect(title).toContain("算出来");
});

test("gantt：任务名可改，日期与刻度不跟着动", async ({ page }) => {
  const preview = await openDiagram(
    page,
    "gantt\n  title 排期\n  dateFormat YYYY-MM-DD\n  section 第一阶段\n  写草稿 : a1, 2026-01-01, 3d\n"
  );
  await expect(label(preview, "写草稿")).toHaveAttribute("data-hp-label", "1");
  await label(preview, "写草稿").dblclick();
  await input(preview).fill("起草");
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  const src = await saveThenRead(page, "起草 : a1");
  expect(src).toContain("起草 : a1, 2026-01-01, 3d");
  expect(src).toContain("dateFormat YYYY-MM-DD");
  expect(src).toContain("section 第一阶段");
});

test("classDiagram：成员行可改；被别处引用的类名拒绝", async ({ page }) => {
  const preview = await openDiagram(
    page,
    "classDiagram\n  class 审批单 {\n    +编号 String\n  }\n  审批单 --> 员工 : 归属\n"
  );
  // class 图的文字是 foreignObject 里的 HTML（探针实测）→ 走 contenteditable 那条老路。
  // **别按 Ctrl+A**：进了编辑态脚本已经把那段字全选了，再按 Ctrl+A 选的是**整篇文档**，
  // 接着打字等于把整篇换成那几个字 —— 代码块没了，预览自然找不到（实测踩过）。
  const 成员 = label(preview, "+编号 String");
  await expect(成员).toHaveAttribute("data-hp-label", "1");
  await 成员.dblclick();
  await page.keyboard.type("+单号 String");
  await page.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  const src = await saveThenRead(page, "+单号 String");
  expect(src).toContain("+单号 String");
  expect(src).not.toContain("+编号 String");

  // 类名在 `class 审批单 {` 和关系行里各出现一次 → 有歧义，必须拒绝
  const 类名 = preview.locator('[data-hp-label="no"]', { hasText: "审批单" }).first();
  await expect(类名).toBeVisible();
});

test("journey / mindmap / timeline：三种新图也认得出唯一出处", async ({ page }) => {
  const cases: [string, string, string, string][] = [
    ["journey", "journey\n  title 报销旅程\n  section 提交\n    填单: 5: 员工\n", "填单", "填报"],
    ["mindmap", "mindmap\n  root((审批))\n    提交\n", "提交", "发起"],
    ["timeline", "timeline\n  title 演进\n  2026\n    Q1 : 立项\n", "立项", "开题"],
  ];
  for (const [name, body, from, to] of cases) {
    const preview = await openDiagram(page, body);
    await expect(label(preview, from), name + " 应该标成可改").toHaveAttribute("data-hp-label", "1");
    await label(preview, from).dblclick();
    const 输入 = preview.getByTestId("pm-mermaid-label-input");
    if (await 输入.count()) {
      await 输入.fill(to);
      await page.keyboard.press("Enter");
    } else {
      // contenteditable 那条：进来时脚本已全选那段字，直接打字替换（别再按 Ctrl+A，见上一条用例的注释）
      await page.keyboard.type(to);
      await page.keyboard.press("Enter");
    }
    await expect(preview, name + " 改完要重绘").toHaveAttribute("data-state", "done", { timeout: 20_000 });
    const src = await saveThenRead(page, to);
    expect(src, name + " 源码里那处文字应该换掉").toContain(to);
    expect(src, name + " 不该留旧文字").not.toContain(from);
  }
});

test("源码里出现多次的同一行字：标成不能改，双击给得出理由", async ({ page }) => {
  const preview = await openDiagram(
    page,
    "sequenceDiagram\n  participant 甲\n  participant 乙\n  甲->>乙: 重复\n  乙->>甲: 重复\n"
  );
  const 重复 = preview.locator('[data-hp-label="no"]', { hasText: "重复" }).first();
  await expect(重复).toHaveAttribute("data-hp-label", "no");
  expect(await 重复.getAttribute("title")).toContain("出现多次");
});
