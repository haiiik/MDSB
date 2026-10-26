import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 151（10-22 把口径说死）：「直接在正文里那张图上按住右键，把图拖着看
 * （图比正文宽的时候，横向滑那段溢出，左键仍然留给选字 / 改字）」。
 *
 * 我第一版理解成了大图灯箱里的平移（149-D），那条也留着，但**要求的是正文里那张图**。
 * 判据钉三件：
 * ① 右键按住拖 → 那个横向溢出容器自己的 `scrollLeft` 变了（拖的是图，不是页面）；
 * ② 左键按住拖 → `scrollLeft` 不动（左键还是选字的，别抢）；
 * ③ 整页的 `scrollTop` 全程不变（拖图不该把文档滚走）。
 * 阅读档与编辑档共用一份实现（`kernel/panDrag`），两档各钉一条，防"只挂了一边"。
 */

// 一条 LR 长链：图的自然宽度远超正文容器（探针实测 ~1400px vs 容器 ~836px）
const 宽图源码 = [
  "flowchart LR",
  "  A[受理登记] --> B[形式审查] --> C[二级单位会签] --> D[主管部门复核] --> E[会签意见汇总] --> F[批复归档]",
].join("\n");

const DOC = ["# 宽图", "", "```mermaid", 宽图源码, "```", "", "图后面的正文。", ""].join("\n");

const 容器 = (档: "read" | "edit") =>
  档 === "read" ? '.hp-mermaid[data-state="done"] .hp-mermaidbox__svg' : '.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg';

const 量 = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) throw new Error("没有 " + s);
    const 页 = document.querySelector(".pane__scroller, .edit-pane__scroll") as HTMLElement;
    return { 横滚: Math.round(el.scrollLeft), 可滚: Math.round(el.scrollWidth - el.clientWidth), 页滚: Math.round(页.scrollTop) };
  }, sel);

/** 按住某颗键横向拖一段 */
async function 拖(page: Page, sel: string, 键: "left" | "right", 距 = -120) {
  const 盒 = (await page.locator(sel).boundingBox())!;
  const 中 = { x: 盒.x + 盒.width / 2, y: 盒.y + 盒.height / 2 };
  await page.mouse.move(中.x, 中.y);
  await page.mouse.down({ button: 键 });
  await page.mouse.move(中.x + 距, 中.y, { steps: 6 });
  await page.mouse.up({ button: 键 });
}

async function 打开(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    ["/demo/宽图右键拖.md", DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.locator('.hp-mermaid[data-state="done"] svg')).toBeVisible({ timeout: 20_000 });
}

for (const 档 of ["read", "edit"] as const) {
  test(档 + " 档：右键按住拖 = 滑那段溢出；左键不抢；页面不动", async ({ page }) => {
    test.setTimeout(180_000);
    await 打开(page);
    if (档 === "edit") {
      await setMode(page, "edit");
      await page.waitForSelector('.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg svg');
      await page.waitForTimeout(2_000);
    }
    const sel = 容器(档);
    const 前 = await 量(page, sel);
    // 前提：这张图确实宽出容器，否则"拖着看"这件事没有对象
    expect(前.可滚, "样本图没溢出，测不出拖动").toBeGreaterThan(80);

    await 拖(page, sel, "left");
    const 左 = await 量(page, sel);
    expect(左.横滚, "左键也能拖图 = 抢了选字/改字的手势").toBe(0);

    await 拖(page, sel, "right");
    const 右 = await 量(page, sel);
    expect(右.横滚, "右键按住拖没滑那段溢出").toBeGreaterThan(60);
    expect(右.页滚, `拖图把整页也滚走了（${前.页滚}→${右.页滚}）`).toBe(右.页滚);
    expect(右.页滚, "拖图期间整页不该动").toBe(前.页滚);
  });
}

test("图不溢出时右键拖动什么都不做（不给一个没有对象的反馈）", async ({ page }) => {
  test.setTimeout(180_000);
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    ["/demo/窄图.md", "# 窄图\n\n```mermaid\nflowchart TD\n  A[甲] --> B[乙]\n```\n\n正文。\n"]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.locator('.hp-mermaid[data-state="done"] svg')).toBeVisible({ timeout: 20_000 });
  const sel = 容器("read");
  const 前 = await 量(page, sel);
  expect(前.可滚, "样本不该溢出却溢出了（换字体/换缩放要改样本）").toBeLessThanOrEqual(0);
  await 拖(page, sel, "right");
  const 后 = await 量(page, sel);
  expect(后.横滚).toBe(0);
  expect(后.页滚, "没有可滑的溢出时，右键拖不该把页面滚走").toBe(前.页滚);
});

test("右键拖完不弹系统菜单（弹了就得再点一下才能继续拖）", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  const sel = 容器("read");
  let 冒了 = false;
  page.on("dialog", async (d) => {
    冒了 = true;
    await d.dismiss();
  });
  const 盒 = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(盒.x + 盒.width / 2, 盒.y + 盒.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(盒.x + 盒.width / 2 - 60, 盒.y + 盒.height / 2, { steps: 4 });
  // 拖的过程中 contextmenu 被 preventDefault 接住：页面仍然收得到 pointerup，
  // 且图停在拖出来的位置（菜单一旦弹出，指针就被系统抢走，后面什么都收不到）
  await page.mouse.up({ button: "right" });
  const 后 = await 量(page, sel);
  expect(后.横滚).toBeGreaterThan(0);
  expect(冒了, "弹了对话框说明指针事件没被接住").toBe(false);
  // 图还在：灯箱没被误开、文档没被改动
  await expect(page.locator(sel + " svg")).toBeVisible();
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
});
