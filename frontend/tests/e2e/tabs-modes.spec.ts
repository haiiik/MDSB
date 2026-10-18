import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 005 三模式切换 + 010 多标签。
 * mock 下用 __hpMockPickPath 注入「对话框里选中的文件」，等价于桌面选同一个文件。
 */

const DEMO = "/demo/欢迎.md";
const OTHER = "/demo/项目 周报 v1.md";

async function pickAndOpen(page: Page, path: string) {
  await page.evaluate((p) => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, path);
  await page.getByTestId("tab-open").click();
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await pickAndOpen(page, DEMO);
  await expect(page.getByTestId("document-root")).toBeVisible();
});

test("再开一个文件形成第二个标签，点击可切回", async ({ page }) => {
  await pickAndOpen(page, OTHER);

  const tabs = page.getByTestId("tabbar").locator(".tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveClass(/is-active/);
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("项目 周报 v1.md");

  await tabs.nth(0).click();
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("欢迎.md");
});

test("同一文件重复打开不产生第二个标签", async ({ page }) => {
  await pickAndOpen(page, OTHER);
  await pickAndOpen(page, DEMO);
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
});

test("阅读 → 源码 → 阅读：文本逐字节不变", async ({ page }) => {
  const before = await page.evaluate(() => document.querySelector(".hp-doc")?.textContent ?? "");

  await setMode(page, "source");
  await expect(page.getByTestId("source-view")).toBeVisible();
  const cmText = await page.locator(".cm-content").innerText();

  await setMode(page, "read");
  const after = await page.evaluate(() => document.querySelector(".hp-doc")?.textContent ?? "");
  expect(after).toBe(before);
  expect(cmText).toContain("欢迎使用 MDStar");
});

test("源码模式改动后切回阅读，渲染即时更新", async ({ page }) => {
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  await page.keyboard.type("\n\n## 新增小节\n\n刚写的内容。\n");

  await setMode(page, "read");
  await expect(page.getByRole("heading", { name: "新增小节", level: 2 })).toBeVisible();
});

test("所见即所得：编辑模式渲染出文档结构并可编辑", async ({ page }) => {
  await setMode(page, "edit");
  const pane = page.getByTestId("edit-mode");
  await expect(pane).toBeVisible();

  const pm = pane.locator(".ProseMirror");
  await expect(pm).toBeVisible();
  // 不再是占位页
  await expect(pane).not.toContainText("该模式在下一里程碑");

  // 结构映射到位
  await expect(pm.locator("h1")).toHaveText("欢迎使用 MDStar");
  await expect(pm.locator("h2")).toHaveCount(3);
  await expect(pm.locator("table th")).toHaveCount(3); // 表头行 → table_header
  await expect(pm.locator("table td").first()).toHaveText("阅读");
  await expect(pm.locator('[data-testid="pm-code-block"]')).toHaveAttribute("data-language", "ts");
  await expect(pm.locator('li[data-hp-task] input[type="checkbox"]')).toHaveCount(2);
  await expect(pm.locator('li[data-hp-task] input[type="checkbox"]').first()).toBeChecked();

  // 104 起放开编辑（回写口径已落地），102 阶段这里是 false
  await expect(pm).toHaveAttribute("contenteditable", "true");
});

test("编辑模式与阅读模式来回切不残留 DOM", async ({ page }) => {
  const pm = page.getByTestId("edit-mode").locator(".ProseMirror");
  await setMode(page, "edit");
  await expect(pm).toBeVisible();
  await setMode(page, "read");
  await expect(page.getByTestId("document-root")).toBeVisible();
  await expect(pm).toHaveCount(0);
  await setMode(page, "edit");
  await expect(pm).toBeVisible();
});

test("脏点出现、关闭时弹确认，取消不关、丢弃才关", async ({ page }) => {
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  await page.keyboard.type("x");

  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  await page.locator(".tab").first().hover();
  await page.locator(".tab__close").first().click();

  const dlg = page.getByTestId("confirm-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("未保存的改动");

  await page.getByTestId("confirm-cancel").click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(1);

  await page.locator(".tab__close").first().click();
  await page.getByTestId("confirm-丢弃").click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(0);
  await expect(page.getByTestId("open-button")).toBeVisible();
});

test("右键菜单在 mock 下把「在资源管理器中显示」置灰", async ({ page }) => {
  await page.locator(".tab").first().click({ button: "right" });
  const item = page.locator(".menu li", { hasText: "在资源管理器中显示" });
  await expect(item).toHaveClass(/is-disabled/);
});

test("切标签不丢源码模式的编辑内容", async ({ page }) => {
  await pickAndOpen(page, OTHER);
  // 新标签是活动位，先切回 A 再改，确保改的是 A
  await page.getByTestId("tabbar").locator(".tab").nth(0).click();
  await setMode(page, "source");
  await page.locator(".cm-content").click();
  await page.keyboard.type("只在 A 里加的字");

  await page.getByTestId("tabbar").locator(".tab").nth(1).click();
  await setMode(page, "source");
  await expect(page.locator(".cm-content")).not.toContainText("只在 A 里加的字");

  await page.getByTestId("tabbar").locator(".tab").nth(0).click();
  // 模式按标签各自记忆：回到 A 时仍是源码模式，且内容还在
  await expect(page.getByTestId("source-view")).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("只在 A 里加的字");
});

/* ---------- 外壳：模式入口只剩底栏三按钮（122 循环按钮 → 124 加直达 → 125 删循环） ---------- */

/** 当前档：底栏按钮组里唯一带 is-on 的那个（原来是一行状态文字，看着能点其实不能点） */
const onMode = (page: Page) => page.locator('[data-testid="mode-picker"] .statusbar__mode.is-on');

test("模式入口只有一个：标签栏与顶栏都不再有模式按钮", async ({ page }) => {
  // 125 按她的口径 Q10 删掉标签栏的循环按钮，`mode-switch` 这个 testid 从此不存在
  await expect(page.getByTestId("mode-switch")).toHaveCount(0);
  await expect(page.getByTestId("tabbar").locator('[data-testid^="mode-"]')).toHaveCount(0);
  await expect(page.getByTestId("topbar").locator('[data-testid^="mode-"]')).toHaveCount(0);
  // 底栏三个 + 没有别处重复的
  await expect(page.getByTestId("mode-picker").getByTestId(/^mode-/)).toHaveCount(3);
});

test("底栏三按钮直达：点哪档就是哪档，is-on 与 aria-pressed 跟着走", async ({ page }) => {
  await expect(onMode(page)).toHaveText("阅读");
  await page.getByTestId("mode-source").click();
  await expect(page.getByTestId("source-mode")).toBeVisible();
  await expect(onMode(page)).toHaveText("源码");
  await expect(page.getByTestId("mode-source")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("mode-read")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("mode-edit").click();
  await expect(page.getByTestId("edit-mode")).toBeVisible();
  await expect(onMode(page)).toHaveText("编辑");
  await page.getByTestId("mode-read").click();
  await expect(onMode(page)).toHaveText("阅读");
  // 名字改口的硬判据：界面上不许再出现「所见即所得」这个旧称
  await expect(page.getByTestId("mode-picker")).not.toContainText("所见即所得");
});

test("按钮 title 只说去哪档，不写快捷键（D18：模式切换不占键）", async ({ page }) => {
  await expect(page.getByTestId("mode-edit")).toHaveAttribute("title", "切到编辑模式");
  await expect(page.getByTestId("mode-picker")).not.toContainText("Ctrl");
});

test("标签栏右端是齿轮 + 主题开关；「+」紧跟最后一个标签", async ({ page }) => {
  /*
   * DOM 顺序（127 之后）：
   * ... .tab → tabbar__new（新增标签）→ tabbar__open（打开文件）→ spacer → tabbar__settings → themepill
   * 这条断言就是这条线的守门人：谁再往右端塞按钮、或者把「+」钉回栏右端，这里会先红。
   */
  const order = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="tabbar"]')!;
    return [...bar.children].map((el) => el.className);
  });
  expect(order[order.length - 1]).toContain("themepill"); // 主题开关是这一栏最右的一个
  expect(order[order.length - 2]).toContain("tabbar__settings"); // 齿轮在它左边
  expect(order[order.length - 3]).toContain("tabbar__spacer");
  expect(order[order.length - 4]).toContain("tabbar__open");
  expect(order[order.length - 5]).toContain("tabbar__new");
  expect(order[order.length - 6]).toContain("tab"); // 最后一个标签就在「+」左边
  expect(order.join(" ")).not.toContain("tabbar__mode"); // 循环按钮真的不在了

  // 一个标签时：+ 贴着标签，而不是贴在栏的右端
  const box = async (sel: string) => page.getByTestId(sel).boundingBox();
  const plus = await box("tab-new");
  const lastTab = (await page.locator(".tab").last().boundingBox())!;
  expect(plus!.x).toBeGreaterThan(lastTab.x + lastTab.width - 2);
  expect(plus!.x - (lastTab.x + lastTab.width)).toBeLessThan(20);

  const gear = await box("open-settings");
  const pill = await box("theme-switch");
  const bar = await page.getByTestId("tabbar").boundingBox();
  expect(pill!.x + pill!.width).toBeLessThanOrEqual(bar!.x + bar!.width);
  // 这一栏右端那两个键（齿轮 + 主题）挤在同一条 10px 内缩线上，合计约 90px
  expect(gear!.x + gear!.width).toBeGreaterThan(bar!.x + bar!.width - 90);
  // 顶栏不再有设置按钮（只有一个 open-settings，就在标签栏）
  await expect(page.getByTestId("open-settings")).toHaveCount(1);
  await expect(page.getByTestId("topbar").getByTestId("open-settings")).toHaveCount(0);
});

test("没有活动标签时底栏整组模式按钮不出现（不能凭空切档）", async ({ page }) => {
  await page.locator(".tab__close").first().click();
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(0);
  await expect(page.getByTestId("mode-picker")).toHaveCount(0);
});


/**
 * 134：标签多到溢出时，当前标签必须自己滚进可视区。
 * 之前只有 `overflow-x: auto`：从资源管理器双击打开一篇排在后面的文档，
 * 窗口跳到前台、标签也在最右边缘之外，看上去就像"没打开"。
 */
test("标签溢出时：激活最右那一篇，它会滚进可视区", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  for (let i = 1; i <= 12; i++) {
    const p = "/demo/长名字标签-" + i + ".md";
    await page.evaluate(
      ([path, text]) => {
        (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(path, text);
        (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = path;
      },
      [p, "# 标签 " + i + "\n\n正文。\n"]
    );
    await page.getByTestId("tab-open").click();
    await page.waitForTimeout(120);
  }
  const tabs = page.locator(".tab");
  expect(await tabs.count()).toBe(12);

  const bar = await page.getByTestId("tabbar").boundingBox();
  const last = tabs.last();
  await last.click();
  await page.waitForTimeout(400);

  const lb = await last.boundingBox();
  expect(lb).not.toBeNull();
  // 右缘要落在可视区内（留 1px 容差），否则用户看不到当前标签
  expect(lb!.x + lb!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
  // 而且它是当前标签（高亮在滚过去的那一篇上，不是滚到别处）
  await expect(last).toHaveClass(/is-active/);
});
