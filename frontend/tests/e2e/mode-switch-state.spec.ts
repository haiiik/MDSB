import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 119：三模式来回切，内容、滚动、撤销各不丢（US-41）。
 *
 * 外壳是 `v-if` 切的 —— 切走就是**卸载组件**，而撤销栈就存在 PM/CM 的 `EditorState` 里，
 * 卸载一次就没了。所以这颗验的不是「组件没被卸载」，而是
 * 「实例被按标签存进 `state/modeInstances.ts` 那张表，切回来按判据复用」。
 *
 * 六方向覆盖：编辑→源码、源码→编辑、编辑→阅读、阅读→编辑、源码→阅读、阅读→源码，
 * 每个方向都断言「内容还在」，其中两个方向额外断言撤销栈（延续 or 重建 + 轻提示）。
 */

/** 40 段正文，够滚出两屏；段落编号是为了让「撤销回到改字前」可判定 */
const DOC =
  "# 切换不丢状态\n\n" +
  Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段正文，用来撑高度。`).join("\n\n") +
  "\n\n结尾段落。\n";

let path = "";

/**
 * 注入一份文件。
 * `__hpMockPickPath` 是**一次性**的（mock 的 `pickOpen` 取完就清回默认示例），
 * 所以「关掉标签再打开」那条要重新注入一次，否则第二次开回来的是内置的 欢迎.md
 * —— 第一版就红在这里，报的是「找不到段落」，看着像模式切换的缺陷，其实是夹具没打开。
 */
async function inject(page: Page): Promise<void> {
  await page.evaluate(([p, c]) => {
    (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, [path, DOC]);
}

async function seedAndOpen(page: Page): Promise<void> {
  path = "/demo/切换-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await inject(page);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

/**
 * 「重新打开」只递路径，**不再 seed**。
 * 再 seed 一次等于把 mock 磁盘上那份文件恢复成初始内容，上一步 Ctrl+S 存进去的改动就被抹掉了 ——
 * 第一版红成「保存没生效」，其实是夹具把自己覆盖了。
 */
async function reopenPath(page: Page): Promise<void> {
  await page.evaluate((p) => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, path);
}

/**
 * 打字节奏：`delay: 40`。
 *
 * **这不是在迁就产品性能**。`keyboard.type` 默认 delay=0，事件是按 CDP 往返速度压着发的，
 * 而 contenteditable 上每一击都要走「同步事务 → 按块回写 → Vue 响应」这一圈；
 * 实测 40 段的文档上 delay=0 会**随机掉一个汉字**（复现两次：「源码里加的小节」变「源码加的小节」、
 * 「源码补的一句」变「源码补的句」），delay≥30 五连跑全对。真人达不到这个速率，
 * 真机中文还要走 IME。所以这里用 40ms 是为了让「模式切换」这条被测对象干净，
 * **快速连打会不会掉字另立桌面手工项**（见 docs/测试与验收.md），不许在这儿当结论。
 */
const TYPE_DELAY = 40;

/** 打字并**当场验一次落进去了** —— 不然后面「切模式后内容还在」会红成模式切换的问题 */
async function typeAndConfirm(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: TYPE_DELAY });
  await expect(page.locator(".ProseMirror, .cm-content").first()).toContainText(text.replace(/\n/g, ""));
}

/**
 * 光标放进「包含这段文字的那个段落」末尾。
 * 不用 `mockApp.placeCaret(nth)`：这份夹具里有 40 个段落，押第几个既不直观也容易被
 * 顺序变化弄假红（115 的教训）。按**内容**找段落才是靶心。
 */
async function caretAtEndOf(page: Page, text: string): Promise<void> {
  await page.waitForSelector(".ProseMirror");
  await page.evaluate((t) => {
    const p = [...document.querySelectorAll(".ProseMirror p")].find((el) => el.textContent?.includes(t));
    if (!p) throw new Error(`找不到段落：${t}`);
    document.querySelector<HTMLElement>(".ProseMirror")?.focus();
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }, text);
}

/** 进编辑模式，在某个段落末尾打字 */
async function typeInParagraph(page: Page, paragraph: string, typed: string): Promise<void> {
  await setMode(page, "edit");
  await caretAtEndOf(page, paragraph);
  await typeAndConfirm(page, typed);
}

/** 进源码模式，在文档末尾打字 */
async function typeAtSourceEnd(page: Page, typed: string): Promise<void> {
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  // 点击只负责拿到焦点，落点用键位定到文档末尾（不押点击坐标落在哪一行）
  await page.keyboard.press("Control+ArrowDown");
  await typeAndConfirm(page, typed);
}

const scrollTopOf = (page: Page, sel: string) =>
  page.evaluate((s) => document.querySelector<HTMLElement>(s)?.scrollTop ?? -1, sel);

/** 滚一段距离并等 scroll 事件把值记到标签上（滚动是**持续记录**的，不是切换时抓一次） */
async function scrollTo(page: Page, sel: string, v: number): Promise<void> {
  // 三档容器分属三个**异步组件**：`data-mode` 变了不等于 DOM 已经挂上（第一版就在这儿抛「找不到滚动容器」）
  await page.waitForSelector(sel);
  await page.evaluate(
    ([s, top]) => {
      const el = document.querySelector<HTMLElement>(s);
      if (!el) throw new Error("找不到滚动容器：" + s);
      el.scrollTop = top;
    },
    [sel, v]
  );
  await expect.poll(() => scrollTopOf(page, sel), { timeout: 2000 }).toBe(v);
}

const EDIT_SCROLL = ".edit-pane__scroll";
const READ_SCROLL = ".pane__scroller";
const SOURCE_SCROLL = ".cm-scroller";

test("编辑 → 源码 → 编辑：改动在，切回编辑也还在", async ({ page }) => {
  await seedAndOpen(page);
  await typeInParagraph(page, "第 3 段", "（编辑加的）");
  await setMode(page, "source");
  // 源码模式看到的是原始 Markdown，那几个字必须在源文本里
  await expect(page.locator(".cm-content")).toContainText("（编辑加的）");
  await setMode(page, "read");
  await expect(page.locator(".hp-doc")).toContainText("（编辑加的）");
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toContainText("（编辑加的）");
});

test("源码 → 编辑：改动生效，且编辑模式看到的是重新解析后的块", async ({ page }) => {
  await seedAndOpen(page);
  await typeAtSourceEnd(page, "\n\n## 源码里加的小节");
  await setMode(page, "edit");
  // 「重新解析后的块」判据：出现一个真的 h2 节点，不是把 ## 当文字显示
  await expect(page.locator(".ProseMirror h2")).toContainText("源码里加的小节");
});

test("编辑改五个字 → 切源码 → 切回编辑 → Ctrl+Z 一次回到改字前", async ({ page }) => {
  await seedAndOpen(page);
  await typeInParagraph(page, "第 7 段", "一二三四五");
  await setMode(page, "source");
  await setMode(page, "edit");
  await caretAtEndOf(page, "第 7 段");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".ProseMirror p").filter({ hasText: "第 7 段正文，用来撑高度。" })).toBeVisible();
  await expect(page.locator(".ProseMirror p").filter({ hasText: "一二三四五" })).toHaveCount(0);
});

test("源码改过 → 切回编辑：撤销栈重建，但要说一句（口径 Q4 的 A 案）", async ({ page }) => {
  await seedAndOpen(page);
  /*
   * **先去一趟编辑模式**，把那份编辑实例真的造出来。
   * 这条以前没这一步也绿 —— 因为旧的外壳是「标签栏循环按钮」，
   * helper 从阅读点两下才到源码（阅读→**编辑**→源码），路过编辑档时顺手建了实例；
   * 125 换成底栏直达按钮后不再路过，隐藏前提就露出来了：
   * 没有旧实例，「重建 + 提示」这条分支根本不会走（`loadFor` 的判据是 `stashed && !canReuse`）。
   * 现在把前提写进用例里，而不是继续依赖 UI 的点击路径。
   */
  await setMode(page, "edit");
  await expect(page.getByTestId("edit-mode")).toBeVisible();
  await typeAtSourceEnd(page, "\n\n源码补的一句。");
  await setMode(page, "edit");
  await expect(page.getByTestId("status-hint")).toContainText("撤销栈");
  // 提示不是装饰：这一刀之后 Ctrl+Z 必须**不会**把源码那一句撤掉
  // （旧栈指向的是一段已经不存在的文档结构，续上去就是乱撤）
  await caretAtEndOf(page, "源码补的一句");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".ProseMirror")).toContainText("源码补的一句");
});

test("源码自己的撤销栈：切出去再切回来还在（切回来时内容没被编辑模式动过）", async ({ page }) => {
  await seedAndOpen(page);
  await typeAtSourceEnd(page, "源码打的字");
  await setMode(page, "edit");
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".cm-content")).not.toContainText("源码打的字");
});

test("三档各自的滚动位置独立记忆，切回时停在原处", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");
  await scrollTo(page, EDIT_SCROLL, 300);

  await setMode(page, "read");
  await scrollTo(page, READ_SCROLL, 700);

  await setMode(page, "source");
  await scrollTo(page, SOURCE_SCROLL, 150);

  await setMode(page, "edit");
  await expect.poll(() => scrollTopOf(page, EDIT_SCROLL), { timeout: 3000 }).toBe(300);
  await setMode(page, "read");
  await expect.poll(() => scrollTopOf(page, READ_SCROLL), { timeout: 3000 }).toBe(700);
  // 源码模式这一档单独记一条：CM 首帧用估算行高建 heightmap，测准后会重新换算滚动位置，
  // 实测「设 150 停在 266」—— EditorPane 的 rAF 补一帧就是为它，别把这条当噪声删掉
  await setMode(page, "source");
  await expect.poll(() => scrollTopOf(page, SOURCE_SCROLL), { timeout: 3000 }).toBe(150);
});

test("阅读模式是只读的：切过去不改内容、不多一个脏点", async ({ page }) => {
  await seedAndOpen(page);
  await typeInParagraph(page, "第 11 段", "（要看渲染）");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await setMode(page, "read");
  await expect(page.locator(".hp-doc")).toContainText("（要看渲染）");
  // 阅读模式的渲染链路（M1 既有）不该把谁再改脏，也不该出现第二个脏标记
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
});

test("关标签再打开：撤销栈是空的（会话恢复只恢复内容与滚动，009 口径）", async ({ page }) => {
  await seedAndOpen(page);
  await typeInParagraph(page, "第 20 段", "（关标签前打的）");
  await page.keyboard.press("Control+s"); // 存干净，关闭时不弹「未保存」确认
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  await page.locator(".tab__close").first().click();
  await expect(page.getByTestId("document-root")).toBeHidden();

  await reopenPath(page); // 只递路径，别再 seed（见上面注释）
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await caretAtEndOf(page, "第 20 段");
  await page.keyboard.press("Control+z");
  // 空栈：Ctrl+Z 之后那几个字还在
  await expect(page.locator(".ProseMirror")).toContainText("（关标签前打的）");
});

test("127：切走再切回源码模式，第一次打字也要回写（桌面实测抓到的静默丢内容）", async ({ page }) => {
  /*
   * 现场：源码档打了几行 → 切走 → 再切回源码 → 继续打字。
   * 屏幕上字**在**（CM 的 doc 真的变了），但工作副本没跟上：脏点不亮、Ctrl+S 存的是旧内容、
   * 关标签不提示直接丢。桌面 127 那段就是这么撞出来的（连打四批全被吞，第五批才回写）。
   *
   * 根因在闭包的所有权：CM 的 `updateListener` 是**建 state 那一刻**绑的，
   * 而 state 会被 stash 跨挂载复用 —— 切回来复用的是「上一个已卸载组件实例」的监听，
   * 它手里的 `emit` 属于那个实例，调用等于打进空气。
   * 第五批能回写是因为那时 CM 的 doc 与工作副本已经不一致 → 复用判据失败 → 重建 state →
   * 绑上了当前实例的监听 —— 也就是说**前四批的内容是被这次重建丢掉的**。
   */
  await seedAndOpen(page);
  await setMode(page, "source");
  await setMode(page, "read"); // 卸载 SourceView，state 进表
  await setMode(page, "source"); // 重新挂载：复用表里那份 state
  await page.locator(".cm-content").click();
  await page.keyboard.type("切回来打的第一个字", { delay: 40 });

  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  const 盘上 = await page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );
  expect(盘上).toContain("切回来打的第一个字");
});
