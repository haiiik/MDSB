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
async function inject(page: Page, 内容 = DOC): Promise<void> {
  await page.evaluate(([p, c]) => {
    (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, [path, 内容]);
}

async function seedAndOpen(page: Page, 内容 = DOC): Promise<void> {
  path = "/demo/切换-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await inject(page, 内容);
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

/**
 * 140（要求：「切换模式时定位到相同位置」）。
 *
 * 这条**取代** 119 那条「三档各自独立记忆滚动位置」：各档内容高度不同
 * （渲染 DOM / PM / 源码行），把 scrollTop 原样搬过去落到的是别的内容上，
 * 所以肉眼看到的是"切一下模式就跑回上面去"。现在换算的是相对位置，
 * 判据也按真正在意的那件事下 —— **视口顶端是不是还停在同一段**。
 */
const 比例 = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) return -1;
    const max = el.scrollHeight - el.clientHeight;
    return max <= 0 ? 0 : el.scrollTop / max;
  }, sel);

/** 视口顶端那一段的段号（三档都数得出来：阅读/编辑看段落，源码看那一行） */
const 顶部段号 = (page: Page, 条目: string, 容器: string) =>
  page.evaluate(
    ([itemSel, boxSel]) => {
      const box = document.querySelector<HTMLElement>(boxSel);
      if (!box) return -99;
      const 线 = box.getBoundingClientRect().top + 24;
      for (const el of Array.from(document.querySelectorAll(itemSel))) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 线) {
          // 用 [0-9] 而不是 \d：这行字面量是脚本写进去的，反斜杠在这一层被吞过一次
          // 源码档里"顶端那一行"常是空行（md 段落之间有空行），所以要**跳过不匹配的行**，
          // 取顶端往下第一个数得出来的段号
          const m = (el.textContent ?? "").match(/第 ([0-9]+) 段/);
          if (m) return Number(m[1]);
        }
      }
      return -2;
    },
    [条目, 容器]
  );

/** 与起点段号的差（还没渲染出段号时返回 99，让 poll 继续等而不是当场判红） */
const 段号差 = (page: Page, 条目: string, 容器: string, 起点: number) =>
  page
    .evaluate(
      ([itemSel, boxSel]) => {
        const box = document.querySelector<HTMLElement>(boxSel);
        if (!box) return -99;
        const 线 = box.getBoundingClientRect().top + 24;
        for (const el of Array.from(document.querySelectorAll(itemSel))) {
          const r = el.getBoundingClientRect();
          if (r.bottom > 线) {
            const m = (el.textContent ?? "").match(/第 ([0-9]+) 段/);
            if (m) return Number(m[1]);
          }
        }
        return -1;
      },
      [条目, 容器]
    )
    .then((n) => (n < 0 ? 99 : Math.abs(n - 起点)));

test("三档换档落到同一段内容（相对位置换算，不是搬 scrollTop 像素）", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "read");
  await scrollTo(page, READ_SCROLL, 700);
  const 起点 = await 顶部段号(page, ".hp-doc p", READ_SCROLL);
  expect(起点, "夹具没滚开，这条判据就没意义了").toBeGreaterThan(5);
  const 原比例 = await 比例(page, READ_SCROLL);
  expect(原比例).toBeGreaterThan(0.05);

  // 四条判据一律用 poll：编辑/源码是异步组件，4 worker 并行时"落点还没稳"是常态，
  // 当场读一次会把负载抖动读成产品缺陷（本轮全量跑就这么红过一次）
  await setMode(page, "edit");
  await expect.poll(() => 段号差(page, ".ProseMirror p", EDIT_SCROLL, 起点), { timeout: 8000 }).toBeLessThanOrEqual(1);
  // 搬像素的话编辑档会落在别处：编辑档内容更矮，700px 的比例会比阅读档大 —— 这里要的是比例一致
  await expect
    .poll(async () => Math.abs((await 比例(page, EDIT_SCROLL)) - 原比例), { timeout: 8000 })
    .toBeLessThanOrEqual(0.08);

  await setMode(page, "source");
  await expect.poll(() => 段号差(page, ".cm-line", SOURCE_SCROLL, 起点), { timeout: 8000 }).toBeLessThanOrEqual(1);

  // 绕一圈回来仍停在原来那一段附近（各档记忆已被换算同步，不该弹回顶部）
  await setMode(page, "read");
  await expect.poll(() => 段号差(page, ".hp-doc p", READ_SCROLL, 起点), { timeout: 8000 }).toBeLessThanOrEqual(1);
});

/**
 * 140 review 补的两篇夹具。
 *
 * 原来这篇夹具全是干净的「第 N 段正文」，于是锚点机制的两个破口一个都没被测到：
 * ① 顶端段落带 `[文字](地址)` 时，源码行有括号而渲染后的 DOM 没有 —— 键配不上，只能退回比例；
 * ② 短标题重复出现时，「文档里第一个配得上的」会撞到更早的那一句。
 * 这条要求写的是「定位到相同位置」，这两类正是文档里最常见的形状。
 */
/*
 * 夹具里的换行一律用 `String.fromCharCode(10)` 拼，**不写反斜杠转义**：
 * 这段内容经由工具链写进文件时 `\n` 被还原成过真实换行，字符串字面量当场断掉
 * （Playwright 报的是「No tests found」，看着像文件没测试，其实是语法被吃了）。
 */
const NL = String.fromCharCode(10);
const 空行 = NL + NL;

const 带链接的DOC =
  "# 带链接的样本" + 空行 +
  Array.from({ length: 60 }, (_, i) => `铺垫 ${i + 1}：这一段没有花活，只负责把位置拉开。`).join(空行) +
  空行 +
  "打开 [审批时效看板](https://example.com/board) 看第一列的口径。" + 空行 +
  "再看一张 ![说明截图](assets/pic.png) 图，图下面这句才是目标段。" + 空行 +
  Array.from({ length: 40 }, (_, i) => `收尾 ${i + 1}：继续撑高度。`).join(空行) +
  NL;

const 重复标题DOC =
  "# 重复短标题的样本" + 空行 +
  "## 概述" + 空行 +
  Array.from({ length: 60 }, (_, i) => `中间段 ${i + 1}，把两份「概述」拉开距离。`).join(空行) +
  空行 +
  "## 细节" + 空行 +
  "一句细节。" + 空行 +
  "## 概述" + 空行 +
  "这第二句「概述」才是换档要落的地方。" + 空行 +
  // 目标后面还得有正文：不然它根本滚不到顶（scrollTo 那道「等落位」会先红），
  // 而这个夹具的全部意义就是「第二个概述停在视口顶端」
  Array.from({ length: 40 }, (_, i) => `尾段 ${i + 1}：让第二处概述能滚到视口上沿。`).join(空行) + NL;


const 顶端文字 = (page: Page, 条目: string, 容器: string) =>
  page.evaluate(
    ([itemSel, boxSel]) => {
      const box = document.querySelector<HTMLElement>(boxSel);
      if (!box) return "";
      const 压 = (s: string) => {
        let o = "";
        for (const c of s) if (c.charCodeAt(0) > 32) o += c;
        return o;
      };
      const 线 = box.getBoundingClientRect().top + 12;
      for (const el of Array.from(box.querySelectorAll(itemSel))) {
        if (el.getBoundingClientRect().bottom <= 线) continue;
        const t = 压(el.textContent ?? "");
        if (t) return t.slice(0, 14);
      }
      return "";
    },
    [条目, 容器]
  );
/** 视口顶端那一块**和它后面那块**的文字 —— 两个同名小标题只有靠下一块才分得清是哪一处 */
const 顶端两块 = (page: Page, 条目: string, 容器: string) =>
  page.evaluate(
    ([itemSel, boxSel]) => {
      const box = document.querySelector<HTMLElement>(boxSel);
      if (!box) return "";
      const 压 = (t: string) => {
        let o = "";
        for (const c of t) if (c.charCodeAt(0) > 32) o += c;
        return o;
      };
      const 块 = Array.from(box.querySelectorAll(itemSel));
      const 线 = box.getBoundingClientRect().top + 12;
      for (let i = 0; i < 块.length; i++) {
        const t = 压(块[i].textContent ?? "");
        if (块[i].getBoundingClientRect().bottom <= 线 || !t) continue;
        return t.slice(0, 10) + "|" + 压(块[i + 1]?.textContent ?? "").slice(0, 10);
      }
      return "";
    },
    [条目, 容器]
  );

test("顶端段落带链接或图片时，换档仍落在同一段（键两边归一化到同一个）", async ({ page }) => {
  await seedAndOpen(page, 带链接的DOC);
  await setMode(page, "read");
  await page.waitForSelector('[data-testid="document-root"]');
  const 偏移 = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".pane__scroller");
    const 目标 = Array.from(document.querySelectorAll(".hp-doc > *")).find((el) =>
      (el.textContent ?? "").includes("审批时效看板")
    );
    if (!box || !目标) return -1;
    return Math.round(目标.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop);
  });
  expect(偏移, "夹具里找不到带链接那句").toBeGreaterThan(0);
  // scrollTo 里带了「等 scrollTop 真的等于目标值」这一道：内容不够长时被夹小、平滑滚动没落位，都会在这儿红
  await scrollTo(page, READ_SCROLL, 偏移 - 12);
  const 阅读顶端 = await 顶端文字(page, ".hp-doc > *", READ_SCROLL);
  expect(阅读顶端, "夹具没把带链接那句滚到顶端，下面的判据就没意义").toContain("审批时效看板");

  await setMode(page, "source");
  await page.waitForSelector(".cm-content");
  // 源码那一行带着 `[…](…)`，归一化之后必须与渲染文字同键；配不上会静默退回比例（真壳里实测偏 3 段）
  await expect
    .poll(() => 顶端文字(page, ".cm-line", SOURCE_SCROLL), { timeout: 8000 })
    .toContain("审批时效看板");
});

test("重复短标题：换档按「离预测位置最近」挑，不换到前面那句同名的", async ({ page }) => {
  await seedAndOpen(page, 重复标题DOC);
  await setMode(page, "read");
  await page.waitForSelector('[data-testid="document-root"]');
  // 目标是**第二个** `## 概述`：它的键只有「概述」两个字，文档前面还有一个一模一样的
  const 偏移 = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".pane__scroller");
    const 全部 = Array.from(document.querySelectorAll(".hp-doc > *")).filter(
      (el) => (el.textContent ?? "").trim() === "概述"
    );
    if (!box || 全部.length !== 2) return -1;
    const 目标 = 全部[1];
    return Math.round(目标.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop);
  });
  expect(偏移, "夹具里应该正好有两个同名的「概述」小标题").toBeGreaterThan(0);
  await scrollTo(page, READ_SCROLL, 偏移 - 12);
  const 阅读顶端 = await 顶端两块(page, ".hp-doc > *", READ_SCROLL);
  expect(阅读顶端, "夹具没停在第二个概述上（下一句才是那段的正文）").toContain("这第二句");

  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  // 按「文档里第一个配得上的」挑就会落到前面那个概述（下一块是「中间段 1」）—— 这才是这条要防的错
  await expect
    .poll(() => 顶端两块(page, ".ProseMirror > *", EDIT_SCROLL), { timeout: 8000 })
    .toContain("这第二句");
});

const 乙篇DOC =
  "# 乙篇" + 空行 +
  Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段（乙篇）：另一篇文档，起始就在顶上。`).join(空行) + NL;

test("换档当帧就切标签：没兑现完的那笔换算作废，另一篇不被拽到旧位置", async ({ page }) => {
  /*
   * 档是**按标签记的**（`tab.mode`）：在乙篇上点「源码」，紧接着同一帧切回甲篇，
   * 甲篇仍是阅读档。真正的风险在另一头 ——
   * 第二次回位由 rAF 补，回调执行时活动标签已经是甲篇了，
   * 于是那笔「为乙篇做的换算」可能拿着甲篇顶端那段字去找落点（review 抓的泄漏）。
   * 这里把两边都钉住：甲篇一步没动，乙篇切回来仍停在自己开头。
   */
  await seedAndOpen(page);
  await setMode(page, "read");
  await scrollTo(page, READ_SCROLL, 700);
  const 起点 = await 顶部段号(page, ".hp-doc p", READ_SCROLL);
  expect(起点, "甲篇没滚开，这条判据就没意义").toBeGreaterThan(5);

  // 乙篇另开一份**真文件**（未命名标签在阅读档不渲染正文，拿它当夹具会红在别处）
  await page.evaluate(([p, c]) => {
    (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, ["/demo/切换-乙篇.md", 乙篇DOC]);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
  await page.waitForSelector('[data-testid="document-root"]');
  expect(await 顶部段号(page, ".hp-doc p", READ_SCROLL), "乙篇应当停在开头").toBeLessThanOrEqual(2);

  // 同一个任务里：先给乙篇换到源码档，再切回甲篇 —— 第二次回位就会撞上「活动标签已经换了」
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="mode-source"]')!.click();
    document.querySelectorAll<HTMLElement>(".tab")[0].click();
  });
  await page.waitForTimeout(700);

  // 甲篇仍是阅读档，且仍停在它自己那一段（既没被换成源码档，也没被拽走）
  await expect(page.locator(".pane__scroller")).toBeVisible();
  await expect
    .poll(() => 段号差(page, ".hp-doc p", READ_SCROLL, 起点), { timeout: 8000 })
    .toBeLessThanOrEqual(0);

  // 切回乙篇：它的源码档落的是**乙篇自己**的开头，不是甲篇第 N 段那种位置
  await page.locator(".tab").nth(1).click();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(600);
  const 乙源码顶 = await 顶部段号(page, ".cm-line", SOURCE_SCROLL);
  expect(
    乙源码顶 === -2 || 乙源码顶 <= 3,
    `乙篇被甲篇那笔没兑现完的换算拽到了第 ${乙源码顶} 段`
  ).toBeTruthy();
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
