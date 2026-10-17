import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 125：Mermaid 两件事 —— ① 长中文标签折行后**不许溢出形状**（方案 A：渲染前我们自己折行）；
 * ② 双击图上的文字就地改（回车提交 + 失焦提交，只改文字不动结构）。
 */

const LONG = "二级单位会签：设备管理主管确认并出具意见后归档办结";
const SRC = "flowchart TD\n  A[" + LONG + "] -->|退回重报| B[结束]\n";

async function openDiagram(page: Page, src = SRC, name = "mermaid125") {
  await freshSession(page);
  await gotoApp(page);
  const path = "/demo/外壳125-" + name + ".md";
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, "# Mermaid 125\n\n```mermaid\n" + src + "```\n\n段落。\n"]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

/** 编辑模式里的图（预览区） */
async function openInEdit(page: Page, src?: string, name = "mermaid125") {
  await openDiagram(page, src, name);
  await setMode(page, "edit");
  await page.waitForSelector('.hp-mermaidbox[data-state="done"] svg', { timeout: 30000 });
}

/**
 * 源码块当前的文本（改完对照用）。
 * 注意 `innerText` 不吐末尾换行，所以对照串一律不带尾部 `\n`（押错了会红成「产品丢了换行」）。
 */
const sourceOf = (page: Page) => page.locator('[data-testid="pm-code-block"]').innerText();

/** 量「文字框有没有跑出形状框」——溢出的定义就是这一条 */
const overflowOf = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector('.hp-mermaidbox svg, .hp-mermaid svg');
    if (!svg) return null;
    let 溢出px = 0;
    let 行数最多 = 0;
    for (const n of svg.querySelectorAll(".node")) {
      const fo = n.querySelector("foreignObject");
      const inner = fo?.querySelector("div");
      const shape = n.querySelector("rect,polygon,path,ellipse,circle");
      if (!fo || !inner || !shape) continue;
      const t = inner.getBoundingClientRect();
      const s = shape.getBoundingClientRect();
      溢出px = Math.max(溢出px, t.bottom - s.bottom, s.top - t.top, t.right - s.right, s.left - t.left);
      行数最多 = Math.max(行数最多, Math.round(t.height / parseFloat(getComputedStyle(inner).lineHeight || "16")));
    }
    return { 溢出px: Math.round(溢出px), 行数最多 };
  });

test("① 长中文标签折行后，文字仍在形状框里（她说的「溢出了」）", async ({ page }) => {
  await openDiagram(page);
  await page.waitForSelector('.hp-mermaid[data-state="done"] svg', { timeout: 30000 });
  const r = await overflowOf(page);
  expect(r, "图没渲出来").not.toBeNull();
  // 前提：确实折了行（不折行就没有「折行后溢出」这回事）
  expect(r!.行数最多).toBeGreaterThanOrEqual(2);
  // 判据：文字框任何一边都不许越过形状框（负数是「还差多少」，正数就是溢出）
  expect(r!.溢出px, `文字跑出形状 ${r!.溢出px}px`).toBeLessThanOrEqual(0);
});

test("② 双击节点文字 → 改 → 回车：只换那一处，图原地变", async ({ page }) => {
  await openInEdit(page);
  const before = await sourceOf(page);
  expect(before).toContain(LONG);

  await page.dblclick('.hp-mermaidbox g.node [data-hp-label="1"] >> nth=0');
  await expect(page.locator('.hp-mermaidbox [contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.type("科室会签", { delay: 40 });
  await page.keyboard.press("Enter");

  await expect.poll(() => sourceOf(page), { timeout: 5000 }).toBe(
    "flowchart TD\n  A[科室会签] -->|退回重报| B[结束]"
  );
  // 图真的重绘了：新字在图上，旧字没了
  await page.waitForSelector('.hp-mermaidbox[data-state="done"] svg', { timeout: 30000 });
  await expect(page.locator(".hp-mermaidbox .nodeLabel").first()).toContainText("科室会签");
  await expect(page.locator(".hp-mermaidbox")).not.toContainText(LONG.slice(0, 8));
});

test("③ 点别处（失焦）也算提交", async ({ page }) => {
  await openInEdit(page, SRC, "失焦提交");
  await page.dblclick('.hp-mermaidbox g.node [data-hp-label="1"] >> nth=0');
  await page.keyboard.type("会签", { delay: 40 });
  // 不敲回车，直接点预览区的空白处（提示条）
  await page.locator(".hp-mermaidbox__hint").click();
  await expect.poll(() => sourceOf(page), { timeout: 5000 }).toContain("A[会签]");
});

test("④ Esc 取消：一个字都不写，源码原样", async ({ page }) => {
  await openInEdit(page, SRC, "esc取消");
  const before = await sourceOf(page);
  await page.dblclick('.hp-mermaidbox g.node [data-hp-label="1"] >> nth=0');
  await page.keyboard.type("删了也不该生效", { delay: 40 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  expect(await sourceOf(page)).toBe(before);
});

test("⑤ 连线标签也能双击改", async ({ page }) => {
  await openInEdit(page, SRC, "连线标签");
  await page.dblclick('.hp-mermaidbox .edgeLabels [data-hp-label="1"] >> nth=0');
  await expect(page.locator('.hp-mermaidbox [contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.type("驳回", { delay: 40 });
  await page.keyboard.press("Enter");
  await expect.poll(() => sourceOf(page), { timeout: 5000 }).toContain("|驳回|");
});

test("⑥ 写不进去就拒绝，并且说清为什么（不猜、不悄悄写坏）", async ({ page }) => {
  await openInEdit(page, SRC, "拒绝写入");
  const before = await sourceOf(page);
  await page.dblclick('.hp-mermaidbox g.node [data-hp-label="1"] >> nth=0');
  await page.keyboard.type('含 " 和 ] 的文字', { delay: 40 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".hp-mermaidbox__hint")).toContainText("源码模式");
  await page.waitForTimeout(400);
  expect(await sourceOf(page)).toBe(before);
});

test("⑦ 改完 Ctrl+Z 一次回到改字前（117 的粒度：一次改字 = 一步）", async ({ page }) => {
  await openInEdit(page, SRC, "撤销一步");
  const before = await sourceOf(page);
  await page.dblclick('.hp-mermaidbox g.node [data-hp-label="1"] >> nth=0');
  await page.keyboard.type("甲乙丙丁", { delay: 40 });
  await page.keyboard.press("Enter");
  // 押**改成了什么**，不押「变了没有」—— 上一版只押「不等于改前」，
  // 于是字被打进源码开头（双击根本没生效）也算过，这条判据当时是虚的
  await expect.poll(() => sourceOf(page), { timeout: 5000 }).toBe(
    "flowchart TD\n  A[甲乙丙丁] -->|退回重报| B[结束]"
  );
  await page.keyboard.press("Control+z");
  await expect.poll(() => sourceOf(page), { timeout: 5000 }).toBe(before);
});

test("⑧ 阅读模式双击不改文档（阅读是只读档，006/119 的口径）", async ({ page }) => {
  await openDiagram(page, SRC, "阅读只读");
  await page.waitForSelector('.hp-mermaid[data-state="done"] svg', { timeout: 30000 });
  await page.dblclick(".hp-mermaid .nodeLabel >> nth=0");
  await page.keyboard.type("不该进去", { delay: 40 });
  await page.waitForTimeout(300);
  await expect(page.locator(".hp-doc")).toContainText(LONG.slice(0, 8));
  await expect(page.locator(".hp-doc")).not.toContainText("不该进去");
  // 没弄脏文档：不该出现脏点
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
});
