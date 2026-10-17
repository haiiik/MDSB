import { expect, test } from "@playwright/test";

/**
 * 阅读模式的异步增强：本地图片路径解析 + Mermaid 渲染（含失败降级）。
 * 走 mock 宿主，因此这些断言在 CI 里不需要桌面壳。
 */

const DOC = "/demo/渲染自检.md";

test.beforeEach(async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent(DOC));
  await expect(page.getByRole("heading", { name: "渲染自检", level: 1 })).toBeVisible();
});

test("相对路径图片按文档目录解析后交给宿主", async ({ page }) => {
  const img = page.locator('img[data-local-path="/demo/diagrams/arch.png"]');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("src", /^data:image\/svg\+xml/);
});

test("含中文与空格的 ../ 相对路径也能解析", async ({ page }) => {
  const img = page.locator('img[data-local-path="/共享/时间 线.svg"]');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("src", /^data:image\/svg\+xml/);
});

test("网络图片原样保留，不经过宿主", async ({ page }) => {
  const SRC = "https://example.com/img/chart.png";
  // 先给一个**同步点**：等宿主解析真的跑过（本地那两张图挂上 data-local-path），
  // 否则「外部图没有 data-local-path」会因为增强还没执行而 trivially 成立。
  await expect(page.locator('.hp-doc img[data-local-path]').first()).toBeVisible();
  // 这条钉的是「外部 URL 不进宿主解析」，**不是**「这张图能加载」。
  // example.com 那张图必然失败，而 enhance 的失效占位是 `img.replaceWith(span)`（021）——
  // 于是「按 src 找 img」取决于 error 事件落在断言之前还是之后：
  // 4 worker 并行时它常来不及触发（绿），单机复跑时它早触发了（红，报 element(s) not found）。
  // 那是**用例的判据不稳定**，不是产品退化。改押两种状态下都成立的不变量：
  // ① 没有元素因为这个 URL 而挂上 `data-local-path`（= 宿主介入了）；
  // ② 原 URL 一字不改地还在 DOM 里 —— 要么是 img 的 src，要么是占位块的 title。
  await expect(page.locator('[data-local-path*="example.com"]')).toHaveCount(0);
  await expect(
    page.locator(`.hp-doc img[src="${SRC}"], .hp-doc .hp-img-broken[title="${SRC}"]`)
  ).toHaveCount(1);
});

test("语法正确的 Mermaid 渲染出 SVG", async ({ page }) => {
  const ok = page.locator('.hp-mermaid[data-state="done"]');
  await expect(ok).toHaveCount(1, { timeout: 15_000 });
  await expect(ok.locator("svg")).toBeVisible();
  // 图里应能看到节点文字
  await expect(ok).toContainText("开始");
});

test("语法错误的 Mermaid 显示错误块与原始源码，不白屏", async ({ page }) => {
  const bad = page.locator('.hp-mermaid--error');
  await expect(bad).toHaveCount(1, { timeout: 15_000 });
  await expect(bad).toContainText("Mermaid 语法错误");
  await expect(bad.locator("pre code")).toContainText("flowchart TD");
  // 错误块不影响同页其它内容
  await expect(page.locator('.hp-mermaid[data-state="done"]')).toHaveCount(1, { timeout: 15_000 });
});

test("图中不存在 language-mermaid 的裸代码块残留", async ({ page }) => {
  await expect(page.locator('.hp-mermaid[data-state="done"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("code.language-mermaid")).toHaveCount(0);
});
