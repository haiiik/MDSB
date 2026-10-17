import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 124：她这轮点的三条 bug + 三条优化的回归钉子。
 * 每条都写成「她看到的那个现象」而不是「我改的那个属性」——
 * 现象级的断言以后被人改坏了会红，属性级的不会。
 */

const LONG_LABEL = "二级单位会签：设备管理主管确认并出具意见后归档";
const MERMAID =
  "```mermaid\nflowchart TD\n  A[开始] --> B{" +
  LONG_LABEL +
  "}\n  B -->|审批退回-转驳回修改后重新提交| C[草稿]\n  B -->|通过| D[归档办结]\n```\n";

async function openDoc(page: Page, body: string, name: string) {
  await freshSession(page);
  await gotoApp(page);
  const path = "/demo/外壳124-" + name + ".md";
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, body]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

/** 长文档：够滚，也够让缩放把内容高度改掉一截 */
const TALL =
  "# 缩放锚点样本\n\n" +
  Array.from({ length: 60 }, (_, i) => `## 第 ${i + 1} 节\n\n第 ${i + 1} 节的正文内容，需要足够长才能撑出滚动条来。`).join(
    "\n\n"
  ) +
  "\n";

/** 光标位置（视口坐标）：锚点判据围绕它 */
const CURSOR_Y = 400;

/**
 * 锚点判据：离光标最近的那段内容，相对光标偏了多少像素。
 *
 * 前两版都量「离视口顶边多远」，结果把正常缩放判成漂移：
 * 缩放本来就是围绕一个点把内容摊开，顶边锚住时下方 217px 的元素必然走到 238px（×1.1）。
 * 浏览器自己的 Ctrl+滚轮 锚的是**光标**，所以判据也得锚光标 —— 那才是她说的「内容上下跑」。
 */
const anchorNearCursor = (page: Page, sel: string) =>
  page.evaluate(([s, cy]) => {
    const sc = document.querySelector<HTMLElement>(s);
    if (!sc) return { text: "", off: 0 };
    const box = sc.getBoundingClientRect();
    let best: { text: string; off: number; d: number } | null = null;
    for (const n of Array.from(sc.querySelectorAll<HTMLElement>("h1, h2, h3, p, li"))) {
      if ((n.textContent ?? "").trim().length < 6) continue; // 表格里也有空 p，别拿它当锚
      const r = n.getBoundingClientRect();
      if (r.top >= box.bottom || r.bottom <= box.top) continue;
      const d = Math.abs(r.top + r.height / 2 - cy);
      if (!best || d < best.d)
        best = { text: (n.textContent ?? "").trim().slice(0, 14), off: Math.round(r.top - cy), d };
    }
    return best ? { text: best.text, off: best.off } : { text: "", off: 0 };
  }, [sel, CURSOR_Y]);

const zoomPercent = (page: Page) => page.getByTestId("zoom-name").innerText();

/**
 * 发一次「按住 Ctrl 的滚轮」，带上光标位置。
 *
 * 不用 `page.mouse.wheel()`：Playwright 那个 API **不带修饰键状态**
 * （`keyboard.down("Control")` 不会跟着进 wheel 事件），测出来是「Ctrl 没按住」。
 * 这里派发真 `WheelEvent`（`cancelable: true`），返回值 `defaultPrevented`
 * 就是「我们有没有接管」的凭据 —— 真浏览器里那一下同时掐掉原生滚动与整页缩放。
 * （「原生到底滚不滚」只能桌面实测：桌面脚本用 CDP `Input.dispatchMouseEvent` 发真事件。）
 */
const ctrlWheel = (page: Page, sel: string, deltaY: number) =>
  page.evaluate(([s, dy, cy]) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) throw new Error("找不到容器：" + s);
    const ev = new WheelEvent("wheel", {
      deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true, clientY: cy, clientX: 600,
    });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [sel, deltaY, CURSOR_Y]);

async function assertZoomAnchored(page: Page, sel: string, tag: string): Promise<void> {
  const before = await anchorNearCursor(page, sel);
  expect(before.text, "光标附近没有可当锚点的块").toBeTruthy();
  expect(await ctrlWheel(page, sel, -120)).toBe(true);
  await expect.poll(() => zoomPercent(page), { timeout: 3000 }).not.toBe("100%");
  await page.waitForTimeout(250); // 等那一帧锚点补偿
  const after = await anchorNearCursor(page, sel);
  console.log(`DRIFT ${tag} 「${before.text}」离光标 ${before.off}px → 「${after.text}」${after.off}px`);
  expect(after.text).toBe(before.text);
  expect(Math.abs(after.off - before.off)).toBeLessThanOrEqual(8);
}

test("Ctrl+滚轮：只缩放，光标底下那段不跑（阅读模式）", async ({ page }) => {
  await openDoc(page, TALL, "缩放");
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="read-mode"]')!.scrollTop = 1200;
  });
  await page.waitForTimeout(150);
  await assertZoomAnchored(page, '[data-testid="read-mode"]', "阅读");
});

test("Ctrl+滚轮：编辑模式也归我们管，不是 WebView2 整页缩放", async ({ page }) => {
  await openDoc(page, TALL, "缩放编辑");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".edit-pane__scroll")!.scrollTop = 900;
  });
  await page.waitForTimeout(150);
  // 原来这个监听只挂在阅读模式上，编辑模式里 Ctrl+滚轮 会漏给 WebView2 整页缩放
  await assertZoomAnchored(page, ".edit-pane__scroll", "编辑");
});

test("Mermaid：长中文标签不裁字，宽图不压扁", async ({ page }) => {
  await openDoc(page, "# 图\n\n" + MERMAID, "mermaid");
  await page.waitForSelector('.hp-mermaid[data-state="done"] svg', { timeout: 30000 });
  const r = await page.evaluate(() => {
    const svg = document.querySelector(".hp-mermaid svg")!;
    const sr = svg.getBoundingClientRect();
    const vb = (svg.getAttribute("viewBox") ?? "0 0 0 0").split(" ").map(Number);
    let 裁 = 0;
    let 最宽标签 = 0;
    for (const n of [...svg.querySelectorAll(".node")]) {
      const fo = n.querySelector("foreignObject");
      const inner = fo?.querySelector("div") as HTMLElement | null;
      if (!fo || !inner) continue;
      const cs = getComputedStyle(inner);
      最宽标签 = Math.max(最宽标签, inner.getBoundingClientRect().width);
      // 文字实际占的宽度超过 foreignObject 给的宽度 = 被裁
      if (inner.scrollWidth > fo.clientWidth + 2 && cs.whiteSpace !== "normal") 裁++;
      if (cs.whiteSpace === "nowrap" && inner.getBoundingClientRect().width > fo.clientWidth + 2) 裁++;
    }
    return {
      压扁比: +(sr.width / (vb[2] || 1)).toFixed(2),
      裁切节点数: 裁,
      最宽标签: Math.round(最宽标签),
      换行: getComputedStyle(svg.querySelector(".nodeLabel")!).whiteSpace,
    };
  });
  // 压扁比 1 = 按真实尺寸画（超宽交给容器横向滚动），小于 1 就是她看到的「字糊掉」
  expect(Math.abs(r.压扁比 - 1)).toBeLessThan(0.06);
  expect(r.换行).toBe("normal");
  expect(r.裁切节点数).toBe(0);
});

test("深色档：滚动条跟着变深（color-scheme 没声明时它一直是白的）", async ({ page }) => {
  await openDoc(page, TALL, "滚动条");
  const light = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    thumb: getComputedStyle(document.documentElement).getPropertyValue("--hp-scroll-thumb").trim(),
  }));
  expect(light.scheme).toContain("light");
  expect(light.thumb).toBe("#c3bcb0");

  // 127：主题开关从设置里挪到了标签栏齿轮右侧，这里直接点月亮那一格
  await page.getByTestId("theme-dark").click();
  await page.waitForTimeout(300);
  const dark = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    thumb: getComputedStyle(document.documentElement).getPropertyValue("--hp-scroll-thumb").trim(),
    bg: getComputedStyle(document.documentElement).getPropertyValue("--hp-bg").trim(),
  }));
  expect(dark.scheme).toContain("dark");
  expect(dark.bg).toBe("#1e2126");
  expect(dark.thumb).toBe("#565e69");
});

test("侧栏收起后只剩一条窄边", async ({ page }) => {
  await openDoc(page, TALL, "窄栏");
  const wide = (await page.getByTestId("sidebar").boundingBox())!;
  await page.getByTestId("collapse-sidebar").click();
  const rail = (await page.getByTestId("sidebar-rail").boundingBox())!;
  expect(rail.width).toBeLessThanOrEqual(18);
  // 收起省下来的宽度真的还给正文，不是留一条比正文边距还宽的灰条
  expect(wide.width - rail.width).toBeGreaterThanOrEqual(240);
});
