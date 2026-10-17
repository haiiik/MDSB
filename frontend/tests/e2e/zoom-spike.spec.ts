import { expect, test } from "@playwright/test";

/**
 * 025：CSS `zoom` 容器里 ProseMirror 的坐标映射。
 *
 * 判定方式是自动的：每个可点词带 data-w，点它的几何中心，
 * 再看 PM 自己算出的光标落在哪个词上。人眼截图只用于输入法候选框那一项。
 */

interface HitResult {
  want: string;
  got: string;
  ok: boolean;
}

const ZOOMS = ["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"];

for (const z of ZOOMS) {
  test(`zoom ${Math.round(Number(z) * 100)}% 下逐词点击全部命中`, async ({ page }) => {
    await page.goto("/?page=zoom-spike");
    await page.selectOption("#spike-zoom", z);
    await page.waitForFunction(() => !!(window as unknown as { __spikeRun?: unknown }).__spikeRun);

    const results = await page.evaluate(() => (window as unknown as { __spikeRun: () => HitResult[] }).__spikeRun());
    const missed = results.filter((r) => !r.ok);
    expect(missed, `偏移的词：${JSON.stringify(missed)}`).toEqual([]);
    expect(results).toHaveLength(10);
  });
}

test("150% 下跨块拖选覆盖两端（段落 → 列表）", async ({ page }) => {
  await page.goto("/?page=zoom-spike");
  await page.selectOption("#spike-zoom", "1.5");
  await page.waitForFunction(() => !!(window as unknown as { __spikeDrag?: unknown }).__spikeDrag);

  // 选 w1 → w5：跨过标题、段落与无序列表，两端都在同一屏内。
  // 刻意不选到文末的 w10 —— 那需要把终点滚进视口，滚动本身会改变起点的可见性，
  // 量出来的偏差属于测量方式而不是坐标映射（逐词命中测试已单独覆盖 w9/w10）。
  const r = await page.evaluate(() =>
    (window as unknown as { __spikeDrag: (a: string, b: string) => { text: string; ok: boolean } }).__spikeDrag(
      "w1",
      "w5"
    )
  );
  expect(r.ok, `两端未各自落在目标词区间内；选区：${JSON.stringify(r.text.slice(0, 60))}`).toBe(true);
});

test("缩放只改视觉尺寸，不改文档内容", async ({ page }) => {
  await page.goto("/?page=zoom-spike");
  // 等编辑器真正有内容再取基线，否则会和挂载中的空 DOM 比
  await page.waitForFunction(() => (document.querySelector(".ProseMirror")?.textContent ?? "").length > 50);
  const before = await page.locator(".ProseMirror").textContent();
  await page.selectOption("#spike-zoom", "2");
  const after = await page.locator(".ProseMirror").textContent();
  expect(after).toBe(before);
});
