import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 120 的第二半：同一张矩阵判据，走**真实编辑链路**再验一次。
 *
 * `tests/unit/fidelity-matrix.spec.ts` 测的是「按块替换的局部性」这件事本身
 * （改哪一块、差集落在哪），它把「用户改了这一块」表达成新块的 Markdown。
 * 这里补的是那条链路的另一半：PM 文档模型 → `changedBlocks` → `patch` → 落盘，
 * 全程走浏览器里的 `EditView`，读的是 mock 文件系统上**已保存的字节**。
 *
 * 为什么必须两边都有：单元测试绕过了 NodeView、粘贴插件、IME、异步组件挂载；
 * E2E 又很难逐块穷举。矩阵负责穷举，这条负责证明「穷举的那套判据在真链路上也成立」。
 */

const PATH = "/demo/矩阵-混排.md";
const DOC = readFileSync(
  fileURLToPath(new URL("../fixtures/fidelity/12-mixed-prd.md", import.meta.url)),
  "utf8"
);

/** 被点名的那一行（结论段），断言时把它从两侧都剔掉，剩下的必须逐字节相同 */
const WITHOUT_TARGET = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.includes("结论段落"))
    .join("\n");

async function seedAndOpen(page: Page): Promise<void> {
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
  await expect(page.getByTestId("document-root")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );

test("恒等：整篇混排文档进编辑模式什么都不改 → 不脏、保存后逐字节等于原文", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();
  // 解析一遍再写回去，任何一处顺手规范化都会在这里亮出来
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  await page.keyboard.press("Control+s");
  await expect.poll(() => savedOf(page), { timeout: 3000 }).toBe(DOC);
});

test("实现：只改结论那一句，其余每一行逐字节回来", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await page.evaluate(() => {
    const p = [...document.querySelectorAll(".ProseMirror p")].find((el) =>
      el.textContent?.includes("结论段落")
    );
    if (!p) throw new Error("找不到结论段");
    p.focus?.();
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  });
  await page.keyboard.type("（已复核）", { delay: 40 });
  await page.keyboard.press("Control+s");

  const saved = (await savedOf(page)) ?? "";
  expect(saved).toContain("（已复核）");
  expect(saved).not.toBe(DOC);
  // 局部性判据：除了被点名那一行，其余每一行一个字节都没变
  expect(WITHOUT_TARGET(saved)).toBe(WITHOUT_TARGET(DOC));
});

test("恒等：矩阵里那几类「不需要可编辑就成立」的内容，编辑保存链路一个字节都不丢", async ({ page }) => {
  await seedAndOpen(page);
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await setMode(page, "read");
  await expect(page.getByTestId("document-root")).toBeVisible();
  // 一趟来回既没写盘也没改内容：不透明块（裸 HTML / 脚注 / [TOC]）在**文件**里原样躺着
  expect(await savedOf(page)).toBe(DOC);

  // 另一半是 M1 的既知坑，不是本颗的验收项：**阅读模式会把裸 HTML 整块丢掉**
  // （`allowDangerousHtml:false`，README「已知坑」记着）。这里按现状钉死，
  // 将来谁修了阅读模式渲染，这条会红 —— 那是提醒他回来把这条改成「文字显示出来」，
  // 不是让他悄悄改。矩阵要求的是「编辑保存链路不丢」，上面那条 `toBe(DOC)` 才是判据。
  const html = await page.locator(".hp-doc").innerHTML();
  expect(html).not.toContain("不能被丢");
  expect(html).not.toContain("这里有一段裸 HTML");
  // 但同一份内容在磁盘上仍然是完整的，两边不是一回事
  expect(DOC).toContain('<div class="notice">这里有一段裸 HTML，里面写着「不能被丢」</div>');
});
