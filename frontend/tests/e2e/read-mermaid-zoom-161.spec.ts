import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 161（要求：「阅读模式的 mermaid 加上缩放功能」）。
 *
 * 146-A 已经把"每张图自己缩放"做在编辑档（`edit-mermaid-zoom-146.spec.ts` 钉着），
 * 这一份**不是把那些判据换个 testid 再跑一遍**，只钉 161 真正新增的东西：
 * ① 阅读档那条栏上真有这组键（并且不再对读屏藏起来）；
 * ② **两档同一个键**：在阅读档放大这张图，切去编辑档还是那一档，反过来也一样
 *    （这就是把倍率表从 NodeView 里搬出来的理由 —— 同一个功能不许两档各存一份）；
 * ③ 倍率仍然**一个字节都不进文档**；
 * ④ 连点两次「放大」不许把大图灯箱弹出来（栏在图的盒子里，dblclick 会冒泡）；
 * ⑤ 这组键不许把 149-C 那条"两档整块等高"弄坏；
 * ⑥ 两张图各调各的（序号口径）。
 */

const 图甲 = "flowchart TD\n  A[受理] --> B[形式审查]\n";
const 图乙 = "flowchart LR\n  X[起草] --> Y[会签] --> Z[归档]\n";
const 原文 =
  "# 阅读档缩放\n\n```mermaid\n" + 图甲 + "```\n\n中间一段正文。\n\n```mermaid\n" + 图乙 +
  "```\n\n```sql\nSELECT 1;\n```\n\n结尾段落。\n";

/**
 * 这一档里第 n 张图的缩放状态。
 * **按块取**（不许全文档找第一颗 —— 146 的桌面判据就是这么红过一次），
 * 而且两档各用各的块选择器：阅读档是 `.hp-mermaid`，编辑档是带 `data-mermaid="1"` 的 `.hp-codebox`
 * （编辑档里还住着普通代码块，混着数会把序号数错 —— 序号正是这次倍率键的全部内容）。
 */
const 缩放态 = (page: Page, 档: "rd" | "pm", 第几张 = 0) =>
  page.evaluate(
    ([前, n]) => {
      const 块选 = 前 === "rd" ? ".hp-doc .hp-mermaid[data-state=\"done\"]" : ".ProseMirror .hp-codebox[data-mermaid=\"1\"]";
      const 盒 = document.querySelectorAll<HTMLElement>(块选)[n];
      const 挑 = (sel: string) => 盒?.querySelector<HTMLElement>(sel);
      const 组 = 挑(`[data-testid="${前}-mermaid-zoom"]`);
      const 倍 = 挑(`[data-testid="${前}-mermaid-zoom-reset"]`);
      const 容器 = 挑(".hp-mermaidbox__svg");
      const svg = 容器?.querySelector("svg");
      return {
        有块: !!盒,
        在不在: !!组 && !组.hidden,
        文案: (倍?.textContent ?? "").trim(),
        图宽: svg ? Math.round(svg.getBoundingClientRect().width) : -1,
        写在容器上的倍率: 容器 ? 容器.style.zoom : "",
        整块高: 盒 ? Math.round(盒.getBoundingClientRect().height) : -1,
        栏藏没藏: (() => {
          const 栏 = 挑(".hp-mermaid__bar");
          if (!栏) return "无栏";
          const 值 = 栏.getAttribute("aria-hidden");
          return 值 === null ? "无标记" : "aria-hidden=" + 值;
        })(),
      };
    },
    [档, 第几张]
  );

async function 打开(page: Page, 档: "rd" | "edit" = "rd"): Promise<string> {
  const path = "/demo/阅读档缩放-" + test.info().title.replace(/[^\w\u4e00-\u9fff]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, 原文]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  if (档 === "rd") {
    await setMode(page, "read");
    await page.waitForSelector('.hp-mermaid[data-state="done"] svg', { timeout: 40_000 });
  } else {
    await setMode(page, "edit");
    await page.waitForSelector('.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg svg', { timeout: 40_000 });
  }
  await page.waitForTimeout(400);
  return path;
}

const 读盘 = (page: Page, path: string) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

test("阅读档每张图的功能栏上都有那三颗键，初始 100%，且栏不再对读屏藏着", async ({ page }) => {
  await 打开(page);
  const 甲 = await 缩放态(page, "rd", 0);
  expect(甲.有块, "阅读档没找到 Mermaid 块").toBe(true);
  expect(甲.在不在, "阅读档的功能栏上没有缩放这组键").toBe(true);
  expect(甲.文案, "一开始不是 100%").toBe("100%");
  expect(甲.写在容器上的倍率).toBe("1");
  // 栏里现在有真能点的键：再挂着 aria-hidden 就等于把控件对读屏藏起来（152 那条同类：别处理没人看见的东西）
  expect(甲.栏藏没藏, "栏里摆了控件却还标着 aria-hidden").toBe("无标记");
});

test("放大两档：图真的变宽，而文件一个字节没变", async ({ page }) => {
  const path = await 打开(page);
  const 原 = await 缩放态(page, "rd", 0);
  await page.locator('[data-testid="rd-mermaid-zoom-in"]').first().click();
  await page.locator('[data-testid="rd-mermaid-zoom-in"]').first().click();
  const 后 = await 缩放态(page, "rd", 0);
  expect(后.文案).toBe("150%");
  expect(后.图宽, "倍率换了，图却没变大").toBeGreaterThan(Math.round(原.图宽 * 1.4));

  await page.keyboard.press("Control+s");
  await page.waitForTimeout(700);
  expect(await 读盘(page, path), "缩放被写进文档了").toBe(原文);
});

test("两张图各调各的：放大第一张，重挂之后第二张还是 100%", async ({ page }) => {
  await 打开(page);
  const 乙原宽 = (await 缩放态(page, "rd", 1)).图宽;
  await page.locator('[data-testid="rd-mermaid-zoom-in"]').first().click();
  const 甲 = await 缩放态(page, "rd", 0);
  const 乙 = await 缩放态(page, "rd", 1);
  expect(甲.文案).toBe("125%");
  expect(乙.文案, "第二张跟着变了（键没按张分开）").toBe("100%");
  expect(乙.写在容器上的倍率, "第二张的图容器被一起写了倍率").toBe("1");
  expect(乙.图宽, "第二张的图被一起放大了").toBe(乙原宽);

  /*
   * 光看当下这一屏抓不住"两张共用一格"：控件只在挂载那一刻读表，之后不重画，
   * 所以共用同一格时第二张的读数**当场看不出变化**（我第一版判据就这么绿着骗了自己一次）。
   * 认错要到**重挂之后**才现形：换一档再换回来，阅读档整块 DOM 是重建的，
   * 每张图重新读一次自己那一格。
   */
  await setMode(page, "source");
  await page.waitForSelector(".cm-content", { timeout: 20_000 });
  await setMode(page, "read");
  await page.waitForSelector('.hp-mermaid[data-state="done"] svg', { timeout: 40_000 });
  await page.waitForTimeout(500);
  expect((await 缩放态(page, "rd", 0)).文案, "第一张的倍率没记住").toBe("125%");
  expect((await 缩放态(page, "rd", 1)).文案, "第二张被第一张带跑了（两格共用成一格）").toBe("100%");
});

test("点倍率那格回 100%；到顶 / 到底那一侧的键 disable", async ({ page }) => {
  await 打开(page);
  const 放大 = page.locator('[data-testid="rd-mermaid-zoom-in"]').first();
  for (let i = 0; i < 8; i++) {
    if (await 放大.isDisabled()) break;
    await 放大.click();
  }
  const 顶 = await 缩放态(page, "rd", 0);
  expect(顶.文案).toBe("300%");
  const 顶组 = page.locator('[data-testid="rd-mermaid-zoom"]').first();
  await expect(顶组.locator('[data-testid="rd-mermaid-zoom-in"]')).toBeDisabled();

  await page.locator('[data-testid="rd-mermaid-zoom-reset"]').first().click();
  expect((await 缩放态(page, "rd", 0)).文案).toBe("100%");

  const 缩小 = page.locator('[data-testid="rd-mermaid-zoom-out"]').first();
  for (let i = 0; i < 8; i++) {
    if (await 缩小.isDisabled()) break;
    await 缩小.click();
  }
  expect((await 缩放态(page, "rd", 0)).文案).toBe("30%");
  await expect(顶组.locator('[data-testid="rd-mermaid-zoom-out"]')).toBeDisabled();
});

test("倍率两档互通：阅读档调到 150%，切去编辑档还是 150%", async ({ page }) => {
  await 打开(page);
  await page.locator('[data-testid="rd-mermaid-zoom-in"]').first().click();
  await page.locator('[data-testid="rd-mermaid-zoom-in"]').first().click();
  expect((await 缩放态(page, "rd", 0)).文案).toBe("150%");

  await setMode(page, "edit");
  await page.waitForSelector('.hp-codebox[data-mermaid="1"]', { timeout: 20_000 });
  await page.waitForTimeout(600);
  const 编 = await 缩放态(page, "pm", 0);
  expect(编.在不在, "编辑档那组键没了（146 的功能被这次改动弄坏）").toBe(true);
  expect(编.文案, "同一张图换到编辑档就变了倍率（两档各存一份）").toBe("150%");
});

test("反向也通：编辑档调到 200%，切回阅读档还是 200%", async ({ page }) => {
  await 打开(page, "edit");
  const 放大 = page.locator('[data-testid="pm-mermaid-zoom-in"]').first();
  await 放大.click();
  await 放大.click();
  await 放大.click();
  expect((await 缩放态(page, "pm", 0)).文案).toBe("200%");

  await setMode(page, "read");
  await page.waitForSelector('.hp-mermaid[data-state="done"] svg', { timeout: 40_000 });
  await page.waitForTimeout(600);
  const 阅 = await 缩放态(page, "rd", 0);
  expect(阅.文案, "编辑档调的倍率没带到阅读档").toBe("200%");
});

test("连点两次「放大」不许把大图灯箱弹出来", async ({ page }) => {
  await 打开(page);
  const 键 = page.locator('[data-testid="rd-mermaid-zoom-in"]').first();
  // 快速两下 = 一次 dblclick，会冒到 `.hp-mermaid` 那颗"双击看大图"上
  await 键.dblclick();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("lightbox"), "点控件的手势被当成了双击图").toBeHidden();
  // 而这两下确实各走了一档（不是被 preventDefault 吞掉变成"点了没反应"）
  expect((await 缩放态(page, "rd", 0)).文案).toBe("150%");
});

test("这组键不许把 149-C 那条两档等高弄坏", async ({ page }) => {
  await 打开(page);
  const 阅 = await 缩放态(page, "rd", 0);
  await setMode(page, "edit");
  await page.waitForSelector('.hp-codebox[data-mermaid="1"]', { timeout: 20_000 });
  await page.waitForTimeout(600);
  const 编 = await 缩放态(page, "pm", 0);
  expect(编.有块, "编辑档没找到那块").toBe(true);
  // 两档整块高度差 ≤2px：栏里多了一组键也只占同一条栏（高度是 --hp-codebar-h 那个 token 定的）
  expect(
    Math.abs(编.整块高 - 阅.整块高),
    `加这组键把两档的等高顶坏了（阅读 ${阅.整块高} / 编辑 ${编.整块高}）`
  ).toBeLessThanOrEqual(2);
});

test("普通代码块不给这组键（缩放的是图，不是文字）", async ({ page }) => {
  await 打开(page);
  const 数 = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.hp-doc .hp-codebox, .hp-doc .hp-mermaid')).filter((盒) =>
        盒.querySelector('[data-testid="rd-mermaid-zoom"]')
      ).length
  );
  // 两张图 → 两组键；那块 sql 没有第三组
  expect(数).toBe(2);
});
