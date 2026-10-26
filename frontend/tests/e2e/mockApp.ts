import type { Page } from "@playwright/test";

/**
 * 打开应用，并等 **mock 宿主真的挂上 window**。
 *
 * `src/host/index.ts` 按 `window.go` 是否存在分派宿主，浏览器分支走的是
 * `await import("./browser-mock")`（动态 import 是有意的：桌面主包不带 mock）。
 * 那是一次真正的异步边界 —— `__hpMockSeedFile` / `__hpMockPickPath` / `__hpMockReadFile`
 * 这些钩子要等它完成才存在，而 `page.goto` 返回的 `load` 事件**不保证**在这之后。
 *
 * 直接 `goto` 完就 `evaluate` 会在机器负载高时偶发
 * `TypeError: window.__hpMockSeedFile is not a function`（4 worker 并行跑全量时实测会红）。
 * 测试要的是「钩子可用」，那就等它，不要赌时序。
 */
export async function gotoApp(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(
    () => typeof (window as unknown as { __hpMockSeedFile?: unknown }).__hpMockSeedFile === "function"
  );
}

/**
 * 让这一条用例从「没有会话」开始。
 *
 * mock 宿主的持久化走 localStorage，而同一份文件路径（`/demo/xxx.md`）在多条用例间复用；
 * 上一条用例保存过的工作副本会被**会话恢复**重新打开，把这一条的起点改掉
 * （115 就撞过：并入表格那条用例读回来的是上一条 TSV 粘贴的结果）。
 * 测「会话恢复 / 未保存确认」的用例**不要用**这个 —— 那正是它们要验的东西。
 */
export async function freshSession(page: Page): Promise<void> {
  await page.context().addInitScript(() => window.localStorage.clear());
}

/**
 * 把当前标签切到指定模式。
 *
 * 125 之后**只有一个入口**：底栏那三个直达按钮（`mode-read` / `mode-edit` / `mode-source`），
 * 点哪档就是哪档。标签栏那个「点击循环」的按钮按已定口径 Q10 删了，
 * helper 也因此不用再把「当前在哪档」算进循环次数 —— 直接点目标档，再等 `is-on` 走过来。
 */
export async function setMode(page: Page, want: "read" | "edit" | "source"): Promise<void> {
  await page.getByTestId(`mode-${want}`).click();
  await page
    .locator(`[data-testid="mode-picker"] .statusbar__mode.is-on[data-testid="mode-${want}"]`)
    .waitFor();
}

/**
 * 把光标精确放进 `selector` 命中的第一个元素内部（`offset`：0=文字开头，-1=末尾）。
 *
 * 为什么不用 `click()` + `Home`：这两步之间**没有同步点** —— 点击产生的选区事务
 * 还没被 PM 处理，键盘事件就发出去了，回车会打在**上一个**光标位置上。
 * 机器负载高（4 worker 并行）时偶发，表现成「按回车没拆项」这种假产品缺陷。
 * 直接改 DOM 选区是同步的，PM 通过 selectionchange 立刻跟上。
 */
export async function placeCaret(
  page: Page,
  selector: string,
  offset: number,
  nth = 0
): Promise<void> {
  // EditView 是 defineAsyncComponent（PM 只在进所见即所得时才加载），
  // 所以「点了模式按钮」不等于「编辑器已挂载」—— 先等它和目标元素都在，再动选区。
  await page.waitForSelector(".ProseMirror");
  const count = await page.locator(selector).count();
  if (count <= nth) throw new Error(`等不到第 ${nth} 个 ${selector}（当前只有 ${count} 个）`);
  await page.evaluate(
    ([sel, off, which]) => {
      const host = document.querySelector<HTMLElement>(".ProseMirror");
      if (!host) throw new Error("编辑器还没挂载");
      host.focus();
      const target = document.querySelectorAll<HTMLElement>(sel)[which];
      if (!target) throw new Error("找不到第 " + which + " 个元素：" + sel);
      // 落到最里层的文字节点上
      const walk = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      const text = walk.nextNode() as Text | null;
      const range = document.createRange();
      if (off < 0) {
        // -1 = 整块末尾（跨多个文字节点也行，比如「正文 + 行内代码」的最后一格后面）
        range.selectNodeContents(target);
      } else if (text) {
        range.setStart(text, Math.min(off, text.data.length));
      } else {
        range.selectNodeContents(target);
      }
      range.collapse(off < 0 ? false : true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    [selector, offset, nth]
  );
}
