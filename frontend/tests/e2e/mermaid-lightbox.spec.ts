import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 127（她选的 Q19 方案）：**大图点开看 —— 在灯箱里滚轮缩放、拖拽平移**。
 *
 * 判据不押「看起来变大了」，押三件可数的东西：
 * ① 灯箱里那份是**克隆**（正文里那张还在、位置没塌）；
 * ② 滚轮改的是 `transform` 里的 scale，「适应屏幕」能回到 fit；
 * ③ 关掉之后文档不脏、图还在 —— 阅读档是只读档，看大图不许留下任何改动。
 */

const PATH = "/demo/大图看全貌.md";
const DOC =
  "# 大图\n\n```mermaid\nflowchart LR\n  A[受理] --> B[形式审查] --> C[会签] --> D[批复] --> E[归档]\n" +
  "  C -->|退回| B\n  D -->|补正| B\n  E --> F[台账]\n```\n\n正文在后头。\n";

async function open(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.locator('.hp-mermaid[data-state="done"]')).toHaveCount(1, { timeout: 20_000 });
}

const stageTransform = (page: Page) =>
  page.evaluate(() => document.querySelector(".hp-lightbox__stage")?.style.transform ?? "");
const scaleOf = (t: string): number => Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? "0");

test("阅读模式双击图 → 进灯箱，正文里那张还在（是克隆不是搬走）", async ({ page }) => {
  await open(page);
  const 正文图 = page.locator('.hp-mermaid[data-state="done"] svg');
  await expect(正文图).toBeVisible();

  await page.locator(".hp-mermaid").first().dblclick();
  const box = page.getByTestId("lightbox");
  await expect(box).toBeVisible();
  await expect(box.locator("svg.hp-lightbox__stage")).toHaveCount(1);
  // 原图没被搬走：正文里那张仍在，且文档没塌
  await expect(正文图).toBeVisible();
  await expect(page.getByRole("heading", { name: "大图", level: 1 })).toBeVisible();
  // 提示条说清了能干什么
  await expect(box).toContainText("滚轮缩放");
  await expect(box.getByTestId("lightbox-fit")).toHaveText("适应屏幕");
});

test("滚轮放大、拖拽平移、适应屏幕回到 fit", async ({ page }) => {
  await open(page);
  await page.locator(".hp-mermaid").first().dblclick();
  const stage = page.locator(".hp-lightbox__stage");
  const fit = scaleOf(await stageTransform(page));
  expect(fit).toBeGreaterThan(0);
  expect(fit).toBeLessThanOrEqual(1);

  await page.locator(".hp-lightbox").dispatchEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true } as never);
  await page.locator(".hp-lightbox").dispatchEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true } as never);
  const 放大后 = scaleOf(await stageTransform(page));
  expect(放大后).toBeGreaterThan(fit);

  // 拖拽平移：translate 要跟着手指走
  const 盒 = (await stage.boundingBox())!;
  await page.mouse.move(盒.x + 盒.width / 2, 盒.y + 盒.height / 2);
  await page.mouse.down();
  await page.mouse.move(盒.x + 盒.width / 2 + 60, 盒.y + 盒.height / 2 + 24, { steps: 4 });
  await page.mouse.up();
  const 平移后 = await stageTransform(page);
  expect(平移后).toMatch(/translate\(\s*[1-9]\d*px,\s*[1-9]\d*px\)/, 平移后);

  await page.getByTestId("lightbox-fit").click();
  const 复位后 = await stageTransform(page);
  expect(scaleOf(复位后)).toBeCloseTo(fit, 3);
  expect(复位后).toContain("translate(0px, 0px)");
});

test("Esc 关掉灯箱：图还在、文档不脏（阅读档是只读档）", async ({ page }) => {
  await open(page);
  await page.locator(".hp-mermaid").first().dblclick();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await expect(page.locator('.hp-mermaid[data-state="done"] svg')).toBeVisible();
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
});

test("编辑模式双击图上的字仍然是改字，不会弹灯箱（两条语义不许抢同一处）", async ({ page }) => {
  await open(page);
  await setMode(page, "edit");
  const preview = page.getByTestId("pm-mermaid-preview");
  await expect(preview).toHaveAttribute("data-state", "done", { timeout: 20_000 });
  await preview.locator('[data-hp-label="1"]', { hasText: "受理" }).first().dblclick();
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  // 进的是就地编辑态
  await expect(preview.locator('[contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
});
