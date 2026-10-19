import { expect, test } from "@playwright/test";
import { setMode } from "./mockApp";

/**
 * 138-A：公式走**真链路** —— 渲染落占位，`hydrate()` 动态取 KaTeX 后原地替换。
 *
 * 所以这个文件里所有判据都押在水合**之后**的 DOM 上：
 * 只测 `mdToHtml` 会漏掉「占位形状对但水合没接上」这类缺陷（那才是用户实际看得到的一层）。
 * 而「KaTeX 没被拖进主入口」是构建形状问题，记在 `perf.spec.ts` 的冷启动分包那条里，
 * 不在这里用时序去猜（网络快慢会让它假绿/假红）。
 */

const DOC = "/demo/公式自检.md";

test.beforeEach(async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent(DOC));
  await expect(page.getByRole("heading", { name: "公式自检", level: 1 })).toBeVisible();
});

/** 等水合落地：pending 的占位全被换掉（成功或降级），一个都不留 */
async function waitHydrated(page: import("@playwright/test").Page) {
  await expect(page.locator(".hp-doc .hp-math--pending")).toHaveCount(0, { timeout: 15000 });
}

test("阅读模式：公式真的被排版出来，占位全部落地", async ({ page }) => {
  await waitHydrated(page);
  const doc = page.locator(".hp-doc");
  // 夹具里是 5 条好公式（行内 4 + 块级 1）+ 1 条故意写坏的。
  // **写死数字是有意的**：占位换状态（hp-math-src → hp-math）只在水合成功时发生，
  // 所以这两个数就是"水合到底跑没跑"的判据 —— 第一次跑 e2e 时 testid 没换，
  // 页面看着有内容、断言却抓不到，正是这条把它逼出来的。
  await expect(page.getByTestId("hp-math")).toHaveCount(5);
  await expect(page.getByTestId("hp-math-error")).toHaveCount(1);
  // 排版出来的公式不再以原文形态出现（定界符 `$` 不见了）
  await expect(doc.locator(".hp-math--inline").first()).not.toContainText("$E=mc^2$");
});

test("块级公式独占一块并真的被排版（不是原文换个颜色）", async ({ page }) => {
  await waitHydrated(page);
  const block = page.locator(".hp-doc .hp-math--block");
  await expect(block).toHaveCount(1);
  // 判据挑的是**排版产物里才有、源码里没有的字符**，不押 KaTeX 的内部类名
  // （`.katex` `.base` `.strut` 是它的实现细节，押了就是每次升级都要重修一遍断言）。
  // 原文写的是 `-b`（ASCII 减号），数学排版会换成 U+2212 `−`；`\pm` 换成 `±`。
  await expect(block).toContainText("−");
  await expect(block).toContainText("±");
  // 分数是**两行高**的东西：只靠文字判不出"排没排版"，量一下盒子才稳
  const box = await block.boundingBox();
  expect(box?.height ?? 0, `块级分数应当明显高于一行文字（实得 ${box?.height}）`).toBeGreaterThan(28);
  // 水合过的那条不再带 pending
  await expect(block).not.toHaveClass(/hp-math--pending/);
});

test("坏公式降级：原文仍然看得见，且不牵连其它内容与整页", async ({ page }) => {
  await waitHydrated(page);
  const err = page.getByTestId("hp-math-error");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("\\typeout{x}");
  await expect(err).toHaveClass(/hp-math--error/);
  // title 里带本地化前缀 + KaTeX 的报错第一句（她鼠标停上去能知道为什么没渲出来）
  const title = await err.getAttribute("title");
  expect(title ?? "").toContain("公式语法错误");
  // 其它内容照常：正文、那条好公式、以及"收尾"两个字都在
  await expect(page.locator(".hp-doc")).toContainText("收尾");
  await expect(page.getByRole("heading", { name: "公式自检", level: 1 })).toBeVisible();
});

test("切到 English 后错误提示跟着换，判据的 testid 不变", async ({ page }) => {
  await waitHydrated(page);
  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  await page.keyboard.press("Escape");
  // 语言变了要重渲染（渲染缓存键里带语言，136 那次踩过），重渲后要再水合一次
  await waitHydrated(page);
  await expect(page.getByTestId("hp-math-error")).toHaveCount(1);
  const title = await page.getByTestId("hp-math-error").getAttribute("title");
  expect(title ?? "").toContain("Formula not rendered");
  await expect(page.getByTestId("hp-math")).toHaveCount(5);
});

test("只是在阅读模式里看了一眼，不该把文档改成未保存", async ({ page }) => {
  await waitHydrated(page);
  await expect(page.getByTestId("status-dirty")).toHaveCount(0);
});

/**
 * 138-A 阶段公式在编辑模式还是**占位**（138-B 才做成「预览 + 就地改源码」），
 * 但占位必须带着她的原文 —— 这条是桌面第 17 段逼出来的：
 * 第一版 label 写的是 `（inlineMath）`，等于"做了公式功能之后编辑模式反而更难读"
 * （没做之前 `$E=mc^2$` 就是看得见的一段普通文字）。
 */
test("编辑模式：公式占位里看得见原文，不是类型名黑话", async ({ page }) => {
  await waitHydrated(page);
  await setMode(page, "edit");
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible();
  const 文本 = (await editor.textContent()) ?? "";
  expect(文本).toContain("$E=mc^2$");
  expect(文本).toContain("$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$");
  expect(文本).not.toContain("（inlineMath）");
  expect(文本).not.toContain("（math）");
  // 占位不许被改成"可编辑文字"：改档保存后文件仍然是原文（字节判据在单元/保真矩阵里）
  await expect(page.getByTestId("opaque-block").first()).toBeVisible();
});
