import { expect, test } from "@playwright/test";
import { placeCaret, setMode } from "./mockApp";

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
 * 138-B：编辑模式里公式是**可就地编辑的节点**。
 *
 * 定界符由 CSS 伪元素按 `data-hp-math-left/right` 画，**不在 DOM 文字里** ——
 * 这条纪律是 136-B 用真缺陷换来的（装饰进 DOM 就会被 PM 的 domAtPos 认成内容区，打字落进标记）。
 * 所以这里判的是：属性带着定界符、正文改得动、界面上仍然看得见 `$`（伪元素），
 * 而 138-A 那条「占位里看得见原文」的判据已经升级成「节点本身就能改」——
 * 更难读的那种状态（label 写 `（inlineMath）`）不会再回来，这条也在钉它。
 */
test("编辑模式：块级公式上面排版、下面能改源码", async ({ page }) => {
  await waitHydrated(page);
  await setMode(page, "edit");
  const block = page.getByTestId("pm-math-block");
  await expect(block).toHaveCount(1);
  const src = page.getByTestId("pm-math-src");
  // 预览区是 NodeView 自己建的，testid 只在这一条上，所以限定在块里找
  const preview = block.getByTestId("pm-math-preview");
  await expect(src).toHaveCount(1);
  // 源码区里只有正文：`$$` 不进 DOM 文字
  await expect(src).not.toContainText("$$");
  await expect(src).toContainText("\\frac{-b");

  // 改一个字 → 上面的预览跟着变。
  // **先等"变成了什么"（β 出现），再看状态**：打字之前 `data-state` 就已经是 `done`，
  // 拿它当起点判据会当场成立、读到旧渲染（桌面第 17 段就是这么假红的）。
  //
  // 落点用 `placeCaret`（DOM Range 显式放进去），不用「点击 + End」：
  // `End` 跳的是**点击所在那一行的行尾**，而且那一下点击产生的选区事务还没落地时键盘就发出去，
  // 光标会留在原地（105/106 记过这条；本文件下面那条行内公式的用例也是为这个改成 Range 的）。
  // 下面「把公式改坏」那条就栽过一次：字打进别的块，`data-state` 停在 `done`，看着像功能坏了。
  await placeCaret(page, '[data-testid="pm-math-src"]', -1);
  await page.keyboard.type(" \\beta");
  await expect(preview).toContainText("β", { timeout: 20_000 });
  await expect(preview).toHaveAttribute("data-state", "done");
});

test("编辑模式：把公式改坏 → 退回原文 + 提示行报错，源码仍可继续改", async ({ page }) => {
  await waitHydrated(page);
  await setMode(page, "edit");
  const src = page.getByTestId("pm-math-src");
  // 落点同上：显式 Range 放到源码末尾，不靠「点击 + End」
  await placeCaret(page, '[data-testid="pm-math-src"]', -1);
  await page.keyboard.type("\\typeout{x}");
  const preview = page.getByTestId("pm-math-block").getByTestId("pm-math-preview");
  await expect(preview).toHaveAttribute("data-state", "error", { timeout: 20_000 });
  // 降级三件事：原文还看得见、报错说得出来、源码框仍可编辑（004 那条口径）
  await expect(preview).toContainText("\\typeout{x}");
  await expect(page.getByTestId("pm-math-hint")).toContainText("公式语法错误");
  await expect(src).toBeEditable();
});

test("编辑模式：行内公式可点进去改，定界符不在文字里", async ({ page }) => {
  await waitHydrated(page);
  await setMode(page, "edit");
  const 行内 = page.getByTestId("pm-math-inline");
  // 夹具里 5 处行内（4 条好公式 + 那条故意写坏的）：写坏的在编辑模式**照样是可改的正文**，
  // 报错只在阅读模式的预览里出现 —— 编辑模式不该因为渲染失败就把字锁住。
  await expect(行内).toHaveCount(5);
  await expect(行内.first()).toHaveText("E=mc^2");
  await expect(行内.first()).toHaveAttribute("data-hp-math-left", "$");
  await expect(行内.first()).toHaveAttribute("data-hp-math-right", "$");
  // 点进去打字，字落在正文里而不是标记里（136-B 那个坑的行内版）。
  // **落点用 DOM Range 显式放进这个节点内部**，不靠"点击 + End"：
  // `End` 跳的是**点击所在那一行的行尾**，这里那一行是整段话，光标会跑到句号后面
  // （105/106 就记过这条，拿它当靶心会误判"没改进公式"）。
  await 行内.first().evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  });
  await page.keyboard.type("!");
  await expect(行内.first()).toHaveText("E=mc^2!");
});

test("编辑模式改完保存：只有动过的那一处变化，其余逐字节不动", async ({ page }) => {
  await waitHydrated(page);
  await setMode(page, "edit");
  const src = page.getByTestId("pm-math-src");
  // 145 之后公式源码默认整段收起：点不到，也**不该**去点 —— 用 Range 直接把光标放进末尾，
  // 光标一进块，块当场展开（这条正是那套收起规则要保住的路径）
  await placeCaret(page, '[data-testid="pm-math-src"]', -1);
  await page.keyboard.type(" \\beta");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  const 存 = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    DOC
  );
  // 块级只在末尾多了 ` \beta`；`$$` 三行式与别处一个字节没动
  expect(存).toContain("$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a} \\beta\n$$");
  expect(存).toContain("行内一句：质能 $E=mc^2$ 与勾股 $a^2+b^2=c^2$ 混排，后面还有**粗体**。");
  expect(存).toContain("求和与积分：$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$，$\\int_0^1 x\\,dx$。");
  expect(存).toContain("坏公式这条应当降级但看得见：$\\typeout{x}$ 收尾。");
});
