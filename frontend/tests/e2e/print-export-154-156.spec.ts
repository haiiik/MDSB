import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 154 / 155 / 156：打印、导出 HTML、导出 PDF。
 *
 * 这一批的判据全部钉在**纸面与导出件的几何/内容**上，不钉"我把值写进去了"：
 * - 打印：先证明屏幕上确实有那个坑（正文在内滚动容器里，最后一块落在视口外、
 *   容器自己在滚），再证明 `@media print` 之下坑没了（容器不滚了、整篇流到两屏之外）。
 *   只测"print.css 里有这条规则"证明不了任何东西 —— 规则没生效也是绿的。
 * - 导出：读回**真正落盘的那份文件**逐块对，而不是看界面上那个 `<div>`。
 *   图片那条尤其要绕开"问嫌疑人"：mock 的 `assetUrl` 对已种好的图直接回 data URL，
 *   屏幕上就已经是内嵌的了，导出的件里出现 `data:` 说明不了导出干过活。
 *   所以这里用一张**没种进 mock 文件系统的本地路径图**——它走 mock 的兜底分支，
 *   回的是一个相对地址 `/__missing_asset__.png`（形状与桌面的 `/hp-file?path=` 同类：
 *   都是"只在应用里才解得开的地址"），再用 route 把那个地址喂成真 PNG 字节。
 *   这样"导出件里出现 `data:image/png;base64,`"只能是导出抓下来重新内嵌的。
 * - 档位还原：从**编辑档**按 Ctrl+P，在 print 被调用的那一刻记下当时是哪一档，
 *   调用完了再看界面回到编辑档 —— 两头都钉，才排掉"根本没换档"和"换了没换回"两种假绿。
 *
 * 已知无法在这里证的（如实标，别当成过了）：
 * 打印对话框本体、以及"背景图形"那颗勾对代码块底色的影响，都要桌面实测。
 */

const 长文 = Array.from(
  { length: 60 },
  (_, i) => `第 ${i + 1} 段：受理登记之后要过形式审查，这一段的用处是把正文拉得超过两屏。`
).join("\n\n");

/** 三种内容都要有：表格（表头重复那条判据用得上）、图（装饰栏要藏、图本体不能藏）、图后面的正文 */
const DOC = [
  "# 纸面验收",
  "",
  长文,
  "",
  "## 一张表",
  "",
  "| 环节 | 时限 |",
  "| --- | --- |",
  "| 受理 | 1 天 |",
  "| 审查 | 3 天 |",
  "| 批复 | 5 天 |",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[受理] --> B[批复]",
  "```",
  "",
  "图后面的正文，用来证明图没有把后面的内容顶丢。",
  "",
].join("\n");

/** 一张 1x1 的合法 PNG（route 的回复体；导出件里 `data:image/png;base64,` 就是它） */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function 打开(page: Page, md = DOC, path = "/demo/纸面验收.md"): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, md]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("read-mode")).toBeVisible();
}

/** 量屏幕上与纸面上这两套媒体查询下的排版。量的是元素自己的盒子，不是样式表里写了什么 */
function 量排版(page: Page) {
  return page.evaluate(() => {
    const 滚 = document.querySelector<HTMLElement>(".pane__scroller")!;
    const 文 = document.querySelector<HTMLElement>(".hp-doc")!;
    const 末块 = 文.lastElementChild as HTMLElement;
    return {
      容器在滚: 滚.scrollHeight - 滚.clientHeight > 4,
      容器溢出: getComputedStyle(滚).overflowY,
      文高: Math.round(文.getBoundingClientRect().height),
      视口高: window.innerHeight,
      末块底: Math.round(末块.getBoundingClientRect().bottom),
      屏外: 末块.getBoundingClientRect().top > window.innerHeight,
      字色: getComputedStyle(document.querySelector<HTMLElement>(".hp-doc p")!).color,
      纸底: getComputedStyle(document.body).backgroundColor,
    };
  });
}

test("屏幕上确实只有那一屏（这条红了说明长文没造出来，后面几条都不用看）", async ({ page }) => {
  await 打开(page);
  const m = await 量排版(page);
  expect(m.文高).toBeGreaterThan(m.视口高 * 2);
  expect(m.容器在滚).toBe(true);
  expect(m.屏外).toBe(true);
});

test("154 纸面：内滚动放开，整篇流到纸外；容器不再自己滚", async ({ page }) => {
  await 打开(page);
  await page.emulateMedia({ media: "print" });
  const m = await 量排版(page);
  // 容器还"在滚"就意味着纸上只有那一屏 —— 这是内滚动应用打印的头号坑
  expect(m.容器溢出).toBe("visible");
  expect(m.容器在滚).toBe(false);
  expect(m.文高).toBeGreaterThan(m.视口高 * 2);
  // 最后一块仍然排在流里（在纸面的第二屏之后，而不是被裁掉）
  expect(m.末块底).toBeGreaterThan(m.视口高);
});

test("154 纸面：深色档也打白底黑字（量的是一真正画字的那颗 p）", async ({ page }) => {
  await 打开(page);
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html[data-theme='dark']")).toHaveCount(1);
  const 深色屏 = await 量排版(page);
  expect(深色屏.字色).toBe("rgb(216, 221, 228)");

  await page.emulateMedia({ media: "print" });
  const 纸 = await 量排版(page);
  // 浅色档那一份的正文色（style.css 的 --hp-text），不是随手写的一个灰
  expect(纸.字色).toBe("rgb(43, 47, 54)");
  expect(纸.纸底).toBe("rgb(255, 255, 255)");
});

test("154 纸面：界面控件不进纸，图本体必须还在", async ({ page }) => {
  await 打开(page);
  await expect(page.locator('.hp-mermaid[data-state="done"] svg')).toBeVisible({ timeout: 20_000 });
  await page.emulateMedia({ media: "print" });
  for (const sel of [
    ".topbar",
    ".tabbar",
    ".statusbar",
    ".sidebar",
    ".edit-toolbar", // 阅读档那条同高的栏（149-C 补的、2026-10-26 起右端放着三颗动作）也是它
    '[data-testid="output-actions"]', // 动作组自己点名量一次：以后栏的 class 改了也不会漏藏
    ".hp-mermaid__bar",
    ".hp-mermaidbox__hint",
    ".toast",
  ]) {
    const n = await page.locator(sel).count();
    if (n === 0) continue;
    // 有一条藏漏了就是纸面上多一排按钮 —— 这里逐颗量，不看样式表里写了什么
    await expect(page.locator(sel).first()).toBeHidden();
  }
  // 反向判据：藏多了会把图一起藏掉，那才是真出事
  await expect(page.locator('.hp-mermaid[data-state="done"] svg').first()).toBeVisible();
  await expect(page.locator(".hp-doc table").first()).toBeVisible();
  // 表头每页重复这条也得有个着落：thead 仍在渲染树里（display 不是 none）
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".hp-doc thead")!).display)).toBe(
    "table-header-group"
  );
});

/**
 * 2026-10-26：入口在**阅读档顶上那条栏的左端**（与编辑档工具栏同一个起点），
 * 形状是「打印」单独一颗 + 「导出 ▾」收两份导出；**设置里那一组撤掉了**
 * （一个功能只留一个入口，122 收模式切换时定的口径）。
 */

/** 从栏上走一次导出：点「导出 ▾」→ 菜单里挑一项 → 菜单要自己收掉 */
async function 从栏上导出(page: Page, 挑: "html" | "pdf"): Promise<void> {
  await page.getByTestId("bar-output-export").click();
  await expect(page.getByTestId("output-menu")).toBeVisible();
  await page.getByTestId(挑 === "html" ? "menu-output-html" : "menu-output-pdf").click();
  await expect(page.getByTestId("output-menu")).toBeHidden();
}

test("154 出口：栏上「打印」+「导出」两颗都在，点打印走同一条通道", async ({ page }) => {
  await 打开(page);
  await 装打印探针(page);
  for (const id of ["bar-output-print", "bar-output-export"]) {
    await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId(id)).toBeEnabled();
  }
  // 两颗都在**栏的左端**：与编辑档工具栏第一颗的左缘对齐（同一层东西不许一种靠左一种靠右）
  const 栏左缘 = await page.getByTestId("output-actions").evaluate((el) => el.getBoundingClientRect().left);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  const 工具栏左缘 = await page.getByTestId("edit-toolbar").evaluate((el) => {
    const b = el.querySelector("button");
    if (!b) throw new Error("编辑档工具栏没有按钮");
    return b.getBoundingClientRect().left;
  });
  expect(Math.abs(栏左缘 - 工具栏左缘), `阅读档动作组左缘 ${栏左缘} 与编辑档第一颗 ${工具栏左缘} 不齐`).toBeLessThan(
    2
  );
  await setMode(page, "read");
  await page.getByTestId("bar-output-print").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __打印次数?: number }).__打印次数))
    .toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __按下时档位?: string }).__按下时档位)).toBe(
    "mode-read"
  );
});

test("155/156 出口：「导出 ▾」里两项，挑 PDF 走打印通道并说清下一步", async ({ page }) => {
  await 打开(page);
  await 装打印探针(page);
  await 从栏上导出(page, "pdf");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __打印次数?: number }).__打印次数))
    .toBe(1);
  await expect(page.getByTestId("output-notice")).toBeVisible();
});

test("154 出口：菜单点外面与 Esc 都要收起来（不收就是挡着正文的一块浮层）", async ({ page }) => {
  await 打开(page);
  await page.getByTestId("bar-output-export").click();
  await expect(page.getByTestId("output-menu")).toBeVisible();
  await page.getByTestId("output-menu-mask").click({ position: { x: 5, y: 400 } });
  await expect(page.getByTestId("output-menu")).toBeHidden();

  await page.getByTestId("bar-output-export").click();
  await expect(page.getByTestId("output-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("output-menu")).toBeHidden();
});

test("154 出口：设置里不再有「输出」那一组（一个功能只留一个入口）", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await expect(page.getByTestId("output-group")).toHaveCount(0);
  for (const id of ["output-print", "output-html", "output-pdf"]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
});

/** 在页面里把 print 换成一颗能记账的探针，顺手记下"按下去那一刻是哪一档" */
async function 装打印探针(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { print: () => void; __打印次数?: number; __按下时档位?: string };
    w.__打印次数 = 0;
    const 原 = w.print.bind(w);
    w.print = () => {
      w.__打印次数!++;
      const 档 = document.querySelector<HTMLElement>('.statusbar__mode.is-on[data-testid^="mode-"]');
      w.__按下时档位 = 档?.getAttribute("data-testid") ?? "无";
      // 真 print 在无头 Edge 里是空操作；这里不调它，免得某些平台把页面挂住
      void 原;
    };
  });
}

test("154 Ctrl+P：从编辑档打出去的是一次阅读档纸面，回来还在编辑档", async ({ page }) => {
  await 打开(page);
  await setMode(page, "edit");
  await 装打印探针(page);
  await page.keyboard.press("Control+P");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __打印次数?: number }).__打印次数))
    .toBe(1);
  // 打印那一刻挂的必须是阅读档（编辑档的 DOM 里是 PM 的光标与 NodeView）
  expect(await page.evaluate(() => (window as unknown as { __按下时档位?: string }).__按下时档位)).toBe(
    "mode-read"
  );
  // 回来还得是编辑档，而且内容没被这一趟打印改脏
  await expect(page.locator('[data-testid="mode-picker"] .is-on[data-testid="mode-edit"]')).toBeVisible();
  await expect(page.getByTestId("edit-mode")).toBeVisible();
  await page.waitForSelector(".ProseMirror");
  expect(await page.evaluate(() => document.querySelectorAll(".ProseMirror > *").length)).toBeGreaterThan(10);
});

// 2026-10-26：设置里那组撤了，「先把对话框让开再打印」这条路径随之作废（栏上那颗不需要）。

test("156 导出 PDF：同一条通道 + 必须说清下一步做什么", async ({ page }) => {
  await 打开(page);
  await 装打印探针(page);
  await 从栏上导出(page, "pdf");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __打印次数?: number }).__打印次数))
    .toBe(1);
  // 回声判据押 testid（存在=说了话），文本内容由桌面实测那趟去认
  await expect(page.getByTestId("output-notice")).toBeVisible();
});

/** route 把 mock 的兜底地址喂成真 PNG 字节：导出件里的 base64 只能是抓下来重内嵌的 */
async function 挂图片服务(page: Page): Promise<void> {
  await page.route("**/__missing_asset__.png", (r) =>
    r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_B64, "base64") })
  );
}

const 带图文档 = ["# 带图", "", "![样图](assets/没种.png)", "", "图后的正文。", ""].join("\n");

async function 导出读回(page: Page, md: string, path = "/demo/带图.md", 导出前撤服务 = false) {
  await 打开(page, md, path);
  // 屏幕上先能加载（所以不会走 021 的失效占位把 `<img>` 换掉），
  // 导出那一刻服务撤掉 —— 剩下的失败才是"导出抓不到"这一条分支，不是"文档里本来就是坏图"。
  if (导出前撤服务) await page.unroute("**/__missing_asset__.png");
  // mock 的 pickSaveAs 回 `/demo/${默认名}`，而默认名来自标签名（去 .md 加 .html）
  const 目标 = "/demo/" + path.split("/").pop()!.replace(/\.md$/i, "") + ".html";
  await 从栏上导出(page, "html");
  await expect(page.getByTestId("output-notice")).toBeVisible({ timeout: 30_000 });
  const 文本 = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    目标
  );
  return { 文本, 目标 };
}

test("155 导出 HTML：单文件——图片是真抓下来重内嵌的，不是本来就在应用里的地址", async ({ page }) => {
  await 挂图片服务(page);
  const { 文本 } = await 导出读回(page, 带图文档);
  expect(文本).not.toBeNull();
  const html = 文本!;
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(html).toContain("data:image/png;base64,");
  // 只在应用里解得开的那个地址不能留进导出件，否则发给别人就是碎图
  expect(html).not.toContain("/__missing_asset__.png");
  expect(html).toContain("<style>");
  // 纸面规则一起带走：别人拿这份去打印，同样是浅色纸面
  expect(html).toContain("@media print");
  // 外壳控件不该在导出件里（它只装了 `.hp-doc` 那一支）
  expect(html).not.toContain("data-testid=\"tabbar\"");
  expect(html).toContain("图后的正文");
});

test("155 导出 HTML：逐块对得上原文，块数与屏幕上的阅读档一致", async ({ page }) => {
  await 打开(page);
  await expect(page.locator('.hp-mermaid[data-state="done"]')).toHaveCount(1, { timeout: 20_000 });
  const 屏幕块数 = await page.evaluate(() => document.querySelectorAll(".hp-doc > *").length);
  await 从栏上导出(page, "html");
  await expect(page.getByTestId("output-notice")).toBeVisible({ timeout: 30_000 });
  const html = await page.evaluate(
    () =>
      (
        window as unknown as { __hpMockReadFile?: (a: string) => string | null }
      ).__hpMockReadFile!("/demo/纸面验收.html")
  );
  expect(html).not.toBeNull();
  // 在页面外没法解析，就把它塞回一个隐藏容器里数块 —— 数的是导出件自己的 DOM
  const 数 = await page.evaluate((s) => {
    const 盒 = document.createElement("div");
    盒.style.display = "none";
    盒.innerHTML = s;
    document.body.append(盒);
    const doc = 盒.querySelector(".hp-doc")!;
    const r = {
      块数: doc.children.length,
      标题: doc.querySelector("h1")?.textContent ?? "",
      表头重复: doc.querySelectorAll("table thead tr").length,
      表行: doc.querySelectorAll("table tbody tr").length,
      有图: !!doc.querySelector(".hp-mermaid svg"),
      末块: doc.lastElementChild?.textContent ?? "",
    };
    盒.remove();
    return r;
  }, html!);
  expect(数.块数).toBe(屏幕块数);
  expect(数.标题).toBe("纸面验收");
  expect(数.表头重复).toBe(1);
  expect(数.表行).toBe(3);
  expect(数.有图).toBe(true);
  expect(数.末块).toContain("图后面的正文");
});

test("155 取不到的图要报数，并且留着原地址（不静默丢图）", async ({ page }) => {
  await 挂图片服务(page);
  const { 文本 } = await 导出读回(page, 带图文档, "/demo/断供.md", true);
  expect(文本).not.toBeNull();
  expect(文本!).not.toContain("data:image/png;base64,");
  // 留原样：导出件里至少还看得出这是一张什么图，而不是凭空少一张
  expect(文本!).toContain("/__missing_asset__.png");
  // 报数的证据：提示里带了数字（全都内嵌成功那条是"已导出 HTML"，没有数字）
  const 文 = await page.getByTestId("output-notice").textContent();
  expect(/[0-9]/.test(文 ?? "")).toBe(true);
});

test("155 导出不改用户档位、不弄脏文档", async ({ page }) => {
  await 打开(page, DOC, "/demo/纸面验收.md");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  const 原 = await page.evaluate(() => document.querySelector(".ProseMirror")?.textContent?.length ?? 0);
  // 进编辑档本身有没有改写盘上的 md，不是这颗按钮的责任 —— 所以基准在按下去之前取
  const 盘前 = await page.evaluate(
    () =>
      (
        window as unknown as { __hpMockReadFile?: (a: string) => string | null }
      ).__hpMockReadFile!("/demo/纸面验收.md")
  );
  // 2026-10-26：入口只在阅读档那条栏上，所以这条路是"切阅读档 → 导出 → 切回编辑档"。
  // 要验的还是那件事：导出这一趟不写盘、不把编辑档的内容改脏（纸面态的切换是临时的）。
  await setMode(page, "read");
  await 从栏上导出(page, "html");
  await expect(page.getByTestId("output-notice")).toBeVisible({ timeout: 30_000 });
  await setMode(page, "edit");
  await expect(page.locator('[data-testid="mode-picker"] .is-on[data-testid="mode-edit"]')).toBeVisible();
  await page.waitForSelector(".ProseMirror");
  const 后 = await page.evaluate(() => document.querySelector(".ProseMirror")?.textContent?.length ?? 0);
  expect(后).toBe(原);
  // 磁盘上那份 md 一个字节都没动（导出不是另存）
  const 盘后 = await page.evaluate(
    () =>
      (
        window as unknown as { __hpMockReadFile?: (a: string) => string | null }
      ).__hpMockReadFile!("/demo/纸面验收.md")
  );
  expect(盘后).toBe(盘前);
});
