import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 024 性能基线（浏览器侧可自动化的部分）+ 121 把同一条线扩展到所见即所得。
 *
 * 数字随机器波动，所以断言的是**量级门槛**而不是精确值；
 * 精确数字由 `pnpm test:e2e --grep @perf` 打印出来，抄进 README 性能表。
 * 采样口径与单测一致：**三轮取最优**（4 worker 并行时单轮会把「别人在抢 CPU」算进产品耗时）。
 */

type Perf = {
  bootMs: number;
  renderMs: number;
  inputMs: number;
  tabSwitchMs: number;
  editCommitMs: number;
  editParseMs: number;
  editMountMs: number;
  editReadyMs: number;
};

/**
 * 样本用**真的那一份** `samples/大图样本文档.md`（1899 行 / 96,105 B ≈ 94KB）。
 *
 * 原先这里另写了一个 `bigMarkdown()` 生成器，注释说「≈1900 行 / 45KB，与样本同量级」——
 * 两份并不是一份（真实样本 94KB），于是 README 那行「打开 1900 行 / 45KB → 168~203ms」
 * 对不上任何一边（审计指出过）。现在只有一个事实来源：文件在就用它。
 * 缺文件就跑 `node scripts/gen-perf-sample.mjs`。
 */
const samplePath = fileURLToPath(new URL("../../../samples/大图样本文档.md", import.meta.url));
if (!existsSync(samplePath)) throw new Error("缺性能样本，先跑 node scripts/gen-perf-sample.mjs");
const SAMPLE_MD = readFileSync(samplePath, "utf8");
const SAMPLE_LINES = SAMPLE_MD.split("\n").length;
const SAMPLE_KB = Math.round(Buffer.byteLength(SAMPLE_MD, "utf8") / 1024);

async function seedBigDoc(page: Page): Promise<void> {
  await gotoApp(page);
  await page.evaluate(
    ([md]) => {
      (window as unknown as { __hpMockSeedFile: (p: string, c: string) => void }).__hpMockSeedFile(
        "/perf/大图样本.md",
        md
      );
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/perf/大图样本.md";
    },
    [SAMPLE_MD]
  );
}

const summary = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __hpPerf?: { summary(): Perf } }).__hpPerf;
    return p ? p.summary() : null;
  });

async function openBigDoc(page: Page): Promise<void> {
  await seedBigDoc(page);
  await page.getByTestId("tab-open").click();
  await expect(page.locator(".hp-doc h2").first()).toBeVisible({ timeout: 30000 });
}

/** 光标放进编辑模式第一个段落末尾（按内容找，不押 nth 落点） */
async function caretInFirstParagraph(page: Page): Promise<void> {
  await page.waitForSelector(".ProseMirror");
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".ProseMirror")?.focus();
    const p = document.querySelector<HTMLElement>(".ProseMirror p");
    if (!p) throw new Error("编辑模式没有段落");
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  });
}

test("@perf 首屏可交互时间", async ({ page }) => {
  await gotoApp(page);
  await page.waitForFunction(() => typeof (window as unknown as { __hpReady?: number }).__hpReady === "number");
  const s = await summary(page);
  const boot = s?.bootMs ?? -1;
  console.log(`[perf] 导航 → App 挂载完成: ${boot.toFixed(1)}ms`);
  expect(boot).toBeGreaterThan(0);
  expect(boot).toBeLessThan(1500);
});

test("@perf 打开大文档到阅读渲染完成（M1 基线，不许因 M2 退化）", async ({ page }) => {
  await seedBigDoc(page);
  const t0 = Date.now();
  await page.getByTestId("tab-open").click();
  await expect(page.locator(".hp-doc h2").first()).toBeVisible({ timeout: 30000 });
  const wall = Date.now() - t0;
  const s = await summary(page);
  const headings = await page.locator(".hp-doc h2").count();
  console.log(
    `[perf] 样本 ${SAMPLE_LINES} 行 / ${SAMPLE_KB}KB：点击打开→可见 ${wall}ms；其中渲染 ${(s?.renderMs ?? -1).toFixed(1)}ms；标题 ${headings}`
  );
  expect(s?.renderMs ?? -1).toBeGreaterThan(0);
  expect(s?.renderMs ?? -1).toBeLessThan(800);
});

test("@perf 源码模式连续输入的单次提交耗时", async ({ page }) => {
  await openBigDoc(page);
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round++) {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) await page.keyboard.type("字");
    best = Math.min(best, (performance.now() - t0) / 50);
  }
  console.log(`[perf] 源码模式连打 50 字：三轮取最优 ${best.toFixed(1)}ms/字`);
  expect(best).toBeLessThan(60);
});

test("@perf 进编辑模式的开销：解析与建视图两段分开看（121 的核心问题）", async ({ page }) => {
  await openBigDoc(page);
  const t0 = Date.now();
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  const wall = Date.now() - t0;
  const s = await summary(page);
  const blocks = await page.evaluate(() => document.querySelectorAll(".ProseMirror > *").length);
  const parse = s?.editParseMs ?? -1;
  const mount = s?.editMountMs ?? -1;
  console.log(
    `[perf] 编辑模式挂载（${SAMPLE_LINES} 行 / ${SAMPLE_KB}KB，${blocks} 个顶层块）：` +
      `点击→可输入 ${wall}ms；其中 mdast→PM ${parse.toFixed(1)}ms、建视图 ${mount.toFixed(1)}ms`
  );
  /*
   * **门槛写的是现状线，不是理想值。** 工单定的判定线是「>300ms 就另开工单、不要在这颗里优化」，
   * 实测踩到了（94KB / 474 块的文档 ~1.4s），结论与后续动作在 123 那颗里，
   * 出处见 `.scratch/m2/tickets/123-编辑模式大文档视口化.md`。
   * 这里留一条能过的线只为「谁改坏了能看出来」，不许有人把它读成「编辑模式达标了」。
   */
  expect(parse).toBeGreaterThan(0);
  expect(wall).toBeLessThan(1800);
});

test("@perf 编辑模式连续输入 + 104 回写口径的开销（决定手感的那个数）", async ({ page }) => {
  await openBigDoc(page);
  await setMode(page, "edit");
  await caretInFirstParagraph(page);
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round++) {
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) await page.keyboard.type("字");
    best = Math.min(best, (performance.now() - t0) / 30);
  }
  const s = await summary(page);
  const commit = s?.editCommitMs ?? -1;
  console.log(
    `[perf] 编辑模式连打 30 字：三轮取最优 ${best.toFixed(1)}ms/字；` +
      `其中 104 的「块比较 + patch」平均 ${commit.toFixed(2)}ms/次事务`
  );
  /*
   * 两个数分别属于两件事，别混着读：
   * - `editCommitMs`（**这条才是 121 要单独打点的那个开销**）实测 0.2~0.3ms/事务，
   *   门槛 8ms。它证明「按块比较 + patch」不是瓶颈 —— D23 这条路没有把成本搬到输入路径上。
   * - 总输入延迟实测 **150 ~ 175ms/字**（同一份文档源码模式是 15.8ms/字，差 ~10 倍），
   *   门槛写现状线 250ms —— 这台机器上同一用例连跑三次拿到过 150 / 160 / 175，
   *   线留 40% 余量是为了「抖不算红、改坏一定红」，不是为了好看。
   *   热点在 PM 视图规模（摘掉代码块降到 93ms/字、再摘表格降到 75ms/字、
   *   40 块的小文档只要 6ms/字），**不在我们的回写链路**，处置归 123。
   */
  expect(best).toBeLessThan(250);
  expect(commit).toBeGreaterThan(0);
  expect(commit).toBeLessThan(8);
});

test("@perf 撤销栈深度：大文档连续改动后的内存与撤到底耗时（观察值）", async ({ page }) => {
  test.setTimeout(180_000);
  await openBigDoc(page);
  await setMode(page, "edit");
  await caretInFirstParagraph(page);
  const heap = () =>
    page.evaluate(
      () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
    );
  const heapBefore = await heap();
  /*
   * 每轮打 5 个字、轮间停 620ms（>117 的合并窗口 500ms），于是**一轮 = 一步**。
   * 工单原话是 200 步；这台机器单字就要 ~150ms，200 步（每步至少等过合并窗口）会把这条
   * 拖成一分钟的常驻用例，所以实测取 20 步 ——
   * 这一条本来就是「观察值」而非门槛，局限写在 121 的完成记录里，不假装测过 200 步。
   */
  const STEPS = 20;
  for (let round = 0; round < STEPS; round++) {
    await page.keyboard.type("改五个字");
    await page.waitForTimeout(620);
  }
  const heapAfter = await heap();
  const perStepMb = (heapAfter - heapBefore) / 1048576 / STEPS;
  // 撤的次数必须**少于**步数，否则把栈撤空，下面那句「改动还在」就成了假断言
  // （第一版 20 步配 20 次撤销，红在「找不到『改五个字』」—— 那是我把栈撤干了，不是产品问题）
  const UNDOS = 10;
  const t0 = Date.now();
  for (let i = 0; i < UNDOS; i++) await page.keyboard.press("Control+z");
  const undoMs = Date.now() - t0;
  console.log(
    `[perf] ${STEPS} 步编辑（每步 5 字，间隔 620ms >合并窗口）：堆内存 ` +
      `${(heapBefore / 1048576).toFixed(1)}MB → ${(heapAfter / 1048576).toFixed(1)}MB` +
      `（每步 ${perStepMb.toFixed(3)}MB；**这台机器上这个数会随 GC 正负翻面，只能当观察值，不能当结论**）；` +
      `连按 ${UNDOS} 次 Ctrl+Z 用时 ${undoMs}ms（${(undoMs / UNDOS).toFixed(1)}ms/次）`
  );
  // 观察值按工单要求只打印；这里只锁两条行为：撤销一直在起作用、文档没被搞崩
  const text = await page.locator(".ProseMirror").innerText();
  expect(text).toContain("改五个字"); // 只撤了 UNDOS < STEPS 步，最早的改动还在
  expect(await page.locator(".ProseMirror p").count()).toBeGreaterThan(0);
  /*
   * 撤销的单次成本实测 ~230ms（474 块文档）—— 与输入那 150ms 同一个根因：
   * PM 每次状态更新都要走一遍整篇视图。**这条门槛同样是现状线（400ms），不是达标线**，
   * 4 worker 并行时它会跟着抖，所以留了余量；处置归 123。
   */
  expect(undoMs / UNDOS).toBeLessThan(400);
});

test("@perf 冷启动分包：PM 与 CM 仍在独立 chunk，没被主入口拖进去", async ({ page }) => {
  await gotoApp(page);
  // 读的是 e2e webServer 刚构建出来的 dist（`vite build` 后 `preview`），
  // 所以这条测的就是「这次改动的产物形状」，不是记忆里的结论
  const dir = fileURLToPath(new URL("../../dist/assets", import.meta.url));
  const files = readdirSync(dir);
  const entry = files.filter((f) => /^index-.*\.js$/.test(f));
  expect(entry.length, `找不到主入口 chunk（${dir}）`).toBeGreaterThan(0);
  const main = readFileSync(`${dir}/${entry[0]}`, "utf8");
  const editChunk = files.find((f) => /^EditView-.*\.js$/.test(f));
  const sourceChunk = files.find((f) => /^SourceView-.*\.js$/.test(f));
  console.log(
    `[perf] 主入口 ${entry[0]} ${(main.length / 1024).toFixed(0)}KB；` +
      `EditView chunk ${editChunk ? Math.round((readFileSync(`${dir}/${editChunk}`, "utf8").length) / 1024) : -1}KB；` +
      `SourceView chunk ${sourceChunk ? Math.round((readFileSync(`${dir}/${sourceChunk}`, "utf8").length) / 1024) : -1}KB`
  );
  // 判据按**内容**不按大小：主入口里不许出现 ProseMirror / CodeMirror 的运行时痕迹
  expect(main).not.toMatch(/prosemirror/i);
  expect(main).not.toMatch(/CodeMirror|codemirror/i);
  expect(editChunk, "编辑模式必须是自己一个 chunk").toBeTruthy();
  expect(sourceChunk, "源码模式必须是自己一个 chunk").toBeTruthy();
});

test("@perf 标签切换耗时", async ({ page }) => {
  await seedBigDoc(page);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = "/demo/欢迎.md";
  });
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);

  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round++) {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      await page.getByTestId("tabbar").locator(".tab").nth(i % 2).click();
    }
    best = Math.min(best, (performance.now() - t0) / 10);
  }
  console.log(`[perf] 标签切换三轮取最优 ${best.toFixed(1)}ms/次（含 Playwright 往返开销，真实更快）`);
  expect(best).toBeLessThan(900);
});
