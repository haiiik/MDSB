import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 146-A：她「mermaid 图新增支持单独缩放，缩放功能放编辑功能右侧」。
 *
 * 三件事必须一起成立：
 * ① 控件在**那颗「编辑源码」的右边**（同一行工具条）；
 * ② 缩放只作用在**这一张图**上（不是整篇 025 那个全局缩放）；
 * ③ 倍率是视图属性，**一个字节都不进文档**（Ctrl+S 之后文件逐字节等于原文）。
 * 另外按她那条「不可用的选项干脆不摆」：到顶 / 到底那一侧的键要 disable。
 */

const 边 = Array.from({ length: 16 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n");
const 文档 = "# 缩放对照\n\n```mermaid\nflowchart TD\n" + 边 + "\n```\n\n正文段落。\n";

const 状态 = (page: Page) =>
  page.evaluate(() => {
    const 组 = document.querySelector<HTMLElement>('[data-testid="pm-mermaid-zoom"]');
    const svg = document.querySelector(".hp-mermaidbox__svg svg");
    const 倍 = document.querySelector<HTMLElement>('[data-testid="pm-mermaid-zoom-reset"]');
    return {
      在不在: !!组 && !组.hidden,
      文案: 倍 ? (倍.textContent ?? "").trim() : null,
      图宽: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
      缩小禁用: (document.querySelector('[data-testid="pm-mermaid-zoom-out"]') as HTMLButtonElement)?.disabled ?? null,
      放大禁用: (document.querySelector('[data-testid="pm-mermaid-zoom-in"]') as HTMLButtonElement)?.disabled ?? null,
      在编辑键右边: (() => {
        const 编 = document.querySelector<HTMLElement>('[data-testid="pm-code-fold"]');
        if (!组 || !编) return false;
        return 编.getBoundingClientRect().right <= 组.getBoundingClientRect().left + 1;
      })(),
    };
  });

async function 打开(page: Page, 正文 = 文档) {
  const path = "/demo/图缩放-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, 正文]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await page.waitForSelector(".hp-codebox");
  await page.waitForTimeout(400);
  return path;
}

const 读盘 = (page: Page, path: string) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

test("缩放控件在「编辑源码」右边，初始 100%", async ({ page }) => {
  await 打开(page);
  const s = await 状态(page);
  expect(s.在不在, "Mermaid 块的工具条上没有缩放控件").toBe(true);
  expect(s.文案).toBe("100%");
  expect(s.在编辑键右边, "控件没放在「编辑源码」右侧（她点名的位置）").toBe(true);
});

test("放大两档：图真的变宽，文档一个字节没变", async ({ page }) => {
  const path = await 打开(page);
  const 原 = await 状态(page);
  await page.getByTestId("pm-mermaid-zoom-in").click();
  await page.getByTestId("pm-mermaid-zoom-in").click();
  const 后 = await 状态(page);
  expect(后.文案).toBe("150%");
  expect(后.图宽, "倍率换了，图却没变大").toBeGreaterThan(Math.round(原.图宽 * 1.4));

  await page.keyboard.press("Control+s");
  await page.waitForTimeout(700);
  expect(await 读盘(page, path), "缩放被写进文档了").toBe(文档);
});

test("点倍率回 100%；到顶 / 到底那一侧的键 disable", async ({ page }) => {
  await 打开(page);
  // 一路按到 disable 为止（倍率只有 8 档，按过头那颗键会自己变灰，Playwright 会一直等它可点）
  for (let i = 0; i < 8; i++) {
    const 键 = page.getByTestId("pm-mermaid-zoom-in");
    if (await 键.isDisabled()) break;
    await 键.click();
  }
  const 顶 = await 状态(page);
  expect(顶.文案).toBe("300%");
  expect(顶.放大禁用, "已经到最大倍率，放大那颗还摆着能点").toBe(true);
  await page.getByTestId("pm-mermaid-zoom-reset").click();
  expect((await 状态(page)).文案).toBe("100%");
  for (let i = 0; i < 8; i++) {
    const 键 = page.getByTestId("pm-mermaid-zoom-out");
    if (await 键.isDisabled()) break;
    await 键.click();
  }
  const 底 = await 状态(page);
  expect(底.文案).toBe("30%");
  expect(底.缩小禁用, "已经到最小倍率，缩小那颗还摆着能点").toBe(true);
});

test("倍率跟着这张图走：换到阅读档再换回来还是那一档", async ({ page }) => {
  await 打开(page);
  await page.getByTestId("pm-mermaid-zoom-in").click();
  await page.getByTestId("pm-mermaid-zoom-in").click();
  expect((await 状态(page)).文案).toBe("150%");
  await setMode(page, "read");
  await page.waitForTimeout(500);
  await setMode(page, "edit");
  await page.waitForSelector(".hp-mermaidbox__svg svg");
  await page.waitForTimeout(400);
  expect((await 状态(page)).文案, "换一次模式就被打回 100%（她调过的倍率没记住）").toBe("150%");
});

test("普通代码块不给缩放控件（缩放的是图，不是文字）", async ({ page }) => {
  await 打开(page, "# 码\n\n```sql\nSELECT 1;\nSELECT 2;\n```\n\n正文。\n");
  const s = await 状态(page);
  expect(s.在不在, "普通代码块上摆了缩放键").toBe(false);
});
