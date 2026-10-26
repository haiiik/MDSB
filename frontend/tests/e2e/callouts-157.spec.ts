import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 157：GFM 提示块（`> [!NOTE]` 那一族，GitHub / Typora 都认）。
 *
 * 已定的口径是**只做阅读档渲染**，所以判据两头都要钉：
 * ① 阅读档认出来了（五种 + 大小写 + 标记与正文挤在一段的情形）；
 * ② **没往文档里写东西** —— 编辑档里 `[!NOTE]` 仍然是看得见的文字（这一档不认这个语法，
 *    不能"看着像被吃了"），盘上那行标记读回来还是 `> [!NOTE]` 原样。
 * ③ 未知类型不猜：`> [!FOO]` 那行是一个真写了方括号的引用，不是提示块。
 *    给它套个底色会让人以为软件认这种语法，而他的文件在 GitHub 上是纯文本。
 * ④ 幂等：换主题会重跑 hydrate，套两层标题就是重跑没兜住。
 *
 * 深色档那五个色是另写一套变量的（深底上要提亮才够对比度），
 * 纸面既然强制浅色，最后一条量的就是"深色档按打印时提示块标题的颜色有没有压回浅色那套"。
 */

const 五种 = [
  "> [!NOTE]",
  "> 这一条是注意。",
  "",
  "> [!TIP]",
  "> 这一条是提示。",
  "",
  "> [!important]",
  "> 小写也要认。",
  "",
  "> [!WARNING] 标记和正文挤在同一段里。",
  "",
  "> [!CAUTION]",
  "> 最后一类。",
].join("\n");

const DOC = [
  "# 提示块",
  "",
  五种,
  "",
  "> [!FOO]",
  "> 这不是提示块。",
  "",
  "> 这是一条普通引用。",
  "",
].join("\n");

async function 打开(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    ["/demo/提示块.md", DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("read-mode")).toBeVisible();
}

test("阅读档：五种都认出来了，标记字样不再出现在正文里", async ({ page }) => {
  await 打开(page);
  const 块 = page.locator(".hp-doc .hp-callout");
  await expect(块).toHaveCount(5);
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll(".hp-doc .hp-callout")).map((e) =>
        (e as HTMLElement).dataset.callout
      )
    )
  ).toEqual(["note", "tip", "important", "warning", "caution"]);

  // 每块一个标题（图标 + 名称），标题是界面文案所以押 testid 之外的结构：数 `.hp-callout__title`
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll(".hp-doc .hp-callout")).map(
        (e) => e.querySelectorAll(".hp-callout__title").length
      )
    )
  ).toEqual([1, 1, 1, 1, 1]);
  // 图标是画的：每块标题里有一颗 svg（不是 emoji 字符）
  expect(
    await page.evaluate(() => document.querySelectorAll(".hp-callout__title svg").length)
  ).toBe(5);
  // `[!XXX]` 那串字面量在渲染出来的正文里一个都不该剩下（FOO 那条除外，它不是提示块）
  const 正文 = await page.evaluate(() => document.querySelector(".hp-doc")!.innerText);
  for (const 串 of ["[!NOTE]", "[!TIP]", "[!important]", "[!WARNING]", "[!CAUTION]"])
    expect(正文).not.toContain(串);
  // 挤在同一段那种：正文留下了，只是剥掉了前面的标记
  expect(正文).toContain("标记和正文挤在同一段里");
  // 内容一个字没少
  expect(正文).toContain("这一条是注意。");
  expect(正文).toContain("最后一类。");
});

test("未知类型不猜：`[!FOO]` 还是普通引用，字样原样留着", async ({ page }) => {
  await 打开(page);
  const 那条 = page.locator(".hp-doc blockquote", { hasText: "这不是提示块" });
  await expect(那条).toHaveCount(1);
  // 普通引用根本没有 class 属性（null）—— 那也是"没被认成提示块"，所以先归成空串再判
  expect((await 那条.getAttribute("class")) ?? "").not.toContain("hp-callout");
  expect(await 那条.evaluate((e) => e.textContent ?? "")).toContain("[!FOO]");
});

test("幂等：连换两次主题，每块标题仍然只有一个", async ({ page }) => {
  await 打开(page);
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html[data-theme='dark']")).toHaveCount(1);
  await page.getByTestId("theme-light").click();
  await expect(page.locator(".hp-doc .hp-callout")).toHaveCount(5);
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll(".hp-doc .hp-callout")).map(
        (e) => e.querySelectorAll(".hp-callout__title").length
      )
    )
  ).toEqual([1, 1, 1, 1, 1]);
  // 标题也别跟着换档消失：换回浅色后 `[!NOTE]` 仍然不该在正文里
  expect(await page.evaluate(() => document.querySelector(".hp-doc")!.innerText)).not.toContain("[!NOTE]");
});

test("编辑档不认这个语法，盘上那份 md 一个字节没改", async ({ page }) => {
  await 打开(page);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  // 编辑档里那行标记是看得见的文字（这一档没做转换，不能"看着像被吃了"）
  const 文本 = await page.evaluate(() => document.querySelector(".ProseMirror")!.innerText);
  expect(文本).toContain("[!NOTE]");
  expect(文本).toContain("[!FOO]");
  // 盘上那行标记还是原样：阅读档的转换只活在 DOM 里，没往文档里写样式
  const 盘 = await page.evaluate(
    () =>
      (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(
        "/demo/提示块.md"
      ) ?? ""
  );
  expect(盘).toContain("> [!NOTE]");
  expect(盘).toContain("> [!FOO]");
  expect(盘).not.toContain("hp-callout");
});

test("深色档按打印：提示块那五个色压回浅色那套（不是留在深底提亮版）", async ({ page }) => {
  await 打开(page);
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html[data-theme='dark']")).toHaveCount(1);
  const 深色 = await page.evaluate(
    () => getComputedStyle(document.querySelector(".hp-callout--tip .hp-callout__title")!).color
  );
  expect(深色).toBe("rgb(111, 211, 154)"); // 深底上那套提亮的绿
  await page.emulateMedia({ media: "print" });
  const 纸 = await page.evaluate(
    () => getComputedStyle(document.querySelector(".hp-callout--tip .hp-callout__title")!).color
  );
  expect(纸).toBe("rgb(47, 125, 81)"); // 纸上就是纸上那套
});
