import { expect, test } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * M3-134：语言设置真的能切、能记住。
 *
 * 判据一律押「切语言后**该变的变了、不该变的没变**」：
 * 底栏模式按钮的文案要跟着换（它是 i18n 出来的），testid 不许换（那是判据的落脚点）。
 */
test("设置里选 English → 对话框自身文案立刻换英文（改语言不需要重启）", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("界面语言")).toBeVisible();

  await page.selectOption("[data-testid=setting-lang]", "en");
  await expect(page.getByText("Language")).toBeVisible();
  await expect(page.getByText("界面语言")).toHaveCount(0);
  // 结构没动：切语言不许把判据的落脚点一起换掉
  await expect(page.getByTestId("setting-lang")).toHaveValue("en");
  // 顶栏窗口三键的提示也换了（title 是给人看的，属于界面文案）
  await expect(page.getByTestId("win-close")).toHaveAttribute("title", "Close");
});

test("切回中文；未打开文档的提示两档都对", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await expect(page.getByTestId("status-not-opened")).toHaveText("未打开文档");

  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  await expect(page.getByTestId("status-not-opened")).toHaveText("No document open");

  await page.selectOption("[data-testid=setting-lang]", "zh");
  await expect(page.getByTestId("status-not-opened")).toHaveText("未打开文档");
});

/**
 * 139：JS 建元素时塞进 DOM 的那批文案（代码块工具条、`[TOC]` 标题、不透明块说明）。
 *
 * 为什么单独押这一条：133 那轮只把 `.vue` 模板接上了字典，而 139 之前这些位置是**硬编码中文**，
 * 默认语言是中文时**全绿也看不出来** —— 一切English 才现形。所以判据必须押在「切了英文之后它真变了」，
 * 而不是「它现在有字」。
 */
test("切 English 后阅读模式里 JS 注入的文案一起换（代码块工具条 + [TOC] 标题）", async ({ page }) => {
  await freshSession(page);
  await page.goto("/?file=" + encodeURIComponent("/demo/增强自检.md"));
  await expect(page.getByRole("heading", { name: "增强自检", level: 1 })).toBeVisible();

  // 中文档先看一眼现状：这两处本来就是中文，切换后才谈得上「跟着换」
  await expect(page.locator(".hp-toc__title")).toHaveText("目录");
  await expect(page.locator(".hp-code__copy").first()).toHaveText("复制");

  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  await expect(page.locator(".hp-toc__title")).toHaveText("Contents");
  await expect(page.locator(".hp-code__copy").first()).toHaveText("Copy");
  // 结构没动：class 与数量是判据的落脚点，不随语言变
  await expect(page.locator(".hp-toc")).toHaveCount(1);
  await expect(page.locator(".hp-code")).toHaveCount(2);
  // 字典里没这条英文就不算换成功（防「空文案」假绿）
  expect(await page.locator(".hp-toc__title").textContent()).not.toBe("");
  // 主题开关那两颗的提示（`{label} theme` 是模板拼接出来的，139 之前一直写死中文）
  await expect(page.getByTestId("theme-light")).toHaveAttribute("title", "Light theme");
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-label", "Dark theme");
  // 底栏统计：`{{ n }} 字` 这种「插值 + 文本」混排的节点，旧闸完全看不见
  const 统计 = page.getByTestId("status-stats");
  await expect(统计).toContainText("words");
  await expect(统计).toContainText("lines");
  await expect(统计).toContainText("headings");
  expect(await 统计.textContent()).not.toMatch(/[一-鿿]/);
});

/**
 * 139 的第二层：`.vue` 的 **script** 里那些 `label:` / `title:` 与 `actions:`
 * （编辑工具栏、查找条的开关提示）。这批连「模板那道闸」和「kernel 那道闸」都不管，
 * 是最容易漏的一层 —— 而且它们大多写在**模块级常量**里，
 * 就算换成 `t("…")` 也会把语言烘死在 import 那一刻，所以判据要押在切换之后。
 */
test("切 English 后编辑工具栏与查找条的提示也是英文（script 里那批）", async ({ page }) => {
  await freshSession(page);
  await page.goto("/?file=" + encodeURIComponent("/demo/增强自检.md"));
  await expect(page.getByRole("heading", { name: "增强自检", level: 1 })).toBeVisible();

  // 中文基线（不先看一眼，下面「变英文」可能只是没渲染）
  await setMode(page, "edit");
  await expect(page.getByTestId("tb-bold")).toHaveAttribute("title", "加粗");
  await expect(page.getByTestId("tb-h1")).toHaveAttribute("title", "一级标题");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-opt-regex")).toHaveAttribute("title", "正则表达式");
  await page.keyboard.press("Escape");

  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  await setMode(page, "read");
  await setMode(page, "edit");
  await expect(page.getByTestId("tb-bold")).toHaveAttribute("title", "Bold");
  await expect(page.getByTestId("tb-h1")).toHaveAttribute("title", "Heading 1");
  await expect(page.getByTestId("tb-paragraph")).toHaveText("Body");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-opt-regex")).toHaveAttribute("title", "Regular expression");
  // 「替换全部」在收起的替换行里，且**替换入口只在编辑档出现**（阅读模式没有可替换的编辑器适配器）
  await page.getByTestId("search-toggle-replace").click();
  await expect(page.getByTestId("replace-all")).toHaveText("Replace all");
});

test("切 English 后进编辑模式，不透明块占位说明是英文", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("open-settings").click();
  await page.selectOption("[data-testid=setting-lang]", "en");
  // 这里不押 Esc：焦点还停在 select 上时 Esc 会不会落到对话框没有保证，
  // 而下一步要点的是被遮罩盖住的「打开」按钮 —— 用关闭按钮，别赌键盘落点
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

  // 先切语言、再打开文档：占位原子的说明文字在解析时写进 attrs，
  // 已经挂在编辑模式里的老节点不会就地改口（要重新挂载才刷新）—— 这条口径记在工单里
  const path = "/demo/不透明英文自检.md";
  const body = ["---", "title: 甲", "---", "", "# 标题", "", '<div class="x">原样保留</div>', "", "正文段落。", ""].join("\n");
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, body]
  );
  await page.getByTestId("tab-open").click();
  await setMode(page, "edit");

  const blocks = page.getByTestId("opaque-block");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toContainText("Document properties (YAML)");
  await expect(blocks.nth(1)).toContainText("Raw HTML");
  // 原文仍在节点上：换了语言不许把不透明内容本身弄丢
  await expect(page.locator(".ProseMirror p").filter({ hasText: "正文段落" }).first()).toBeVisible();
});
