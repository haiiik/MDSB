import { expect, test, type Page } from "@playwright/test";
import { gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 107：任务清单点选与列表回车行为（US-37）。
 */

const PATH = "/demo/清单边界.md";

const DOC = [
  "# 待办清单",
  "",
  "- [ ] 指标口径已对齐",
  "- [ ] 慢单需要单独看板",
  "- [x] 超时提醒已上线",
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

test("点复选框：只改那一行的 [ ]→[x]，其余逐字节不变", async ({ page }) => {
  await seedAndOpen(page);

  const boxes = page.locator('.ProseMirror li[data-hp-task] input[type="checkbox"]');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).not.toBeChecked();

  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  await page.keyboard.press("Control+s");
  // 整串相等：这一条断言同时覆盖了「其他两项没被牵连」
  expect(await savedOf(page)).toBe(DOC.replace("- [ ] 指标口径已对齐", "- [x] 指标口径已对齐"));
});

test("取消已勾选项：[x]→[ ]", async ({ page }) => {
  await seedAndOpen(page);
  const boxes = page.locator('.ProseMirror li[data-hp-task] input[type="checkbox"]');
  await expect(boxes.nth(2)).toBeChecked();
  await boxes.nth(2).click();
  await expect(boxes.nth(2)).not.toBeChecked();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC.replace("- [x] 超时提醒已上线", "- [ ] 超时提醒已上线"));
});

test("点复选框不该把点击当成选区移动（勾选不被弹回去）", async ({ page }) => {
  await seedAndOpen(page);
  const box = page.locator('.ProseMirror li[data-hp-task] input[type="checkbox"]').nth(1);
  await box.click();
  // 连点两次 = 勾上再取消，状态应回到原样且文档不脏
  await box.click();
  await expect(box).not.toBeChecked();
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC);
});

test("列表末尾的空项按回车退出列表，而不是无限加项", async ({ page }) => {
  const src = "# 清单\n\n- 甲\n- 乙\n\n末段。\n";
  await seedAndOpen(page, src);

  // 光标放到「乙」末尾，按回车产生新空项，再按一次应退出列表
  await page.locator(".ProseMirror li").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("退出后的段落");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved).toContain("- 甲\n- 乙\n");
  expect(saved).toContain("退出后的段落");
  // 退出后那段不是列表项：不该出现 `- 退出后的段落`
  expect(saved).not.toContain("- 退出后的段落");
  expect(saved).toContain("末段。");
});

/**
 * 这条**曾经真的坏过**，坏形态记在这里（当时的落盘）：
 *
 *   -
 *   [ ]
 *     指标口径已对齐
 *   - [ ] 慢单需要单独看板
 *
 * `[ ]` 独占一行、前面没有列表符号 —— 拆出来的项掉出了列表结构。
 * 已排除序列化器：手工构造的 mdast 直接喂 `serializeMd`，
 * 「空项 + 任务项」「空项(false) + 任务项」「任务 + 空 + 任务」三种形态输出都干净，
 * 说明坏的是**真实拆分后的 PM 文档经 blockToMdast 产出的结构**。
 *
 * 2026-10-20 复测（140 收口时按注释里的复现路径原样走一遍：点第一项文字开头 → Home → Enter → 保存），
 * 落盘是 `-
- [ ] 指标口径已对齐
- [ ] 慢单…
- [ ] 超时…` —— 坏形态不再出现，**这条不是 fixme，是现役反证**：
 * 一旦那个形状回来，下面的 `not.toMatch(/^\[[ x]\]/m)` 会当场红。
 *
 * 顺带修掉的两个真问题（断言仍在下面）：
 * - `serializeBlock` 现在两头都削换行，否则空首项会把两个空行顶到**文件开头**；
 * - 空列表项的 `checked` 归一为 null（空项没有可勾的东西）。
 */
test("列表项行首按回车拆出新项：输出仍是合法列表，文字一项不丢", async ({ page }) => {
  await seedAndOpen(page);
  // 光标用 placeCaret 同步放进第一项的文字开头。
  // 原来写的是 `click()` + `Home`：点击产生的选区事务还没被 PM 处理，
  // 回车就已经发出去了 —— 负载高时回车打在旧光标上，表现成「没拆项」的假缺陷
  // （113 加完工具栏、版面下移之后撞上了这一次）。
  await placeCaret(page, ".ProseMirror li p", 0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const itemLines = saved.split("\n").filter((l) => /^(-|\[[ x]\]|- \[[ x]\])/.test(l));
  expect(itemLines).toHaveLength(4); // 拆出 1 项 → 共 4 项
  expect(saved).toContain("指标口径已对齐");
  expect(saved).toContain("慢单需要单独看板");
  expect(saved).toContain("超时提醒已上线");
  // 关键反证：不许出现「`[ ]` 独占一行、前面没有列表符号」的坏片段
  expect(saved).not.toMatch(/^\[[ x]\]/m);
  // 三项原文各自仍是带勾选的任务项
  expect((saved.match(/^- \[[ x]\] \S/gm) ?? []).length).toBe(3);
});
