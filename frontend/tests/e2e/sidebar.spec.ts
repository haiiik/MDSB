import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 侧栏：最近列表（011）、导航（014，原名「大纲」）、折叠（016）。
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
});

test("打开过的文件出现在最近列表，点击可再打开", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await pickAndOpen(page, OTHER);

  const items = page.locator(".recent__item");
  await expect(items).toHaveCount(2);
  // 最新在前
  await expect(items.first()).toContainText("项目 周报 v1.md");

  await page.locator(".recent__item").nth(1).locator(".recent__main").click();
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("欢迎.md");
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
});

test("悬停可移除单条；清空只清列表不动标签", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await pickAndOpen(page, OTHER);

  await page.locator(".recent__item").first().hover();
  await page.locator(".recent__item").first().locator(".recent__ops button").nth(1).click();
  await expect(page.locator(".recent__item")).toHaveCount(1);

  await page.getByTestId("clear-recent").click();
  await page.getByTestId("confirm-清空").click();
  await expect(page.getByTestId("recent-list")).toContainText("还没有打开过文件");
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
});

/**
 * 140 报的那条：「星星图标两种状态的位置不一样」。
 *
 * 根因是 127 那轮把行内星标换成独立的 `.recent__flag` 塞进名字后面 —— 那是**会占宽度的元素**，
 * 一置顶整行内容就左移，操作列那颗星星跟着挪。
 * 现在改成：行内不再插旗，操作列那颗按钮自己「未 hover 也常驻」表示已置顶，
 * 所以两态是同一个盒子、同一个位置。判据直接量两态的 x 中心，而不是量"有没有那颗星"。
 */
test("置顶项排最前，且星星两态位置一模一样（140）", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await pickAndOpen(page, OTHER);

  const 行 = page.locator(".recent__item");
  const 星 = (n: number) => 行.nth(n).locator('[data-testid="recent-pin"]');
  /** 同一行里星星的水平中心 + 名字列宽度：这两个数只要一动，就是"置顶把行推歪了" */
  const 量 = (n: number) =>
    星(n).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const name = el.closest(".recent__item")!.querySelector(".recent__name")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, 名字宽: name.width, 可见: getComputedStyle(el).opacity !== "0" };
    });

  // 未置顶那一行（第二行）先量一次
  const 未置顶 = await 量(1);
  expect(未置顶.可见, "未置顶且不悬停时不该露出按钮").toBe(false);

  await 行.nth(1).hover();
  await 星(1).click();
  await expect(行.first()).toContainText("欢迎.md");

  const 置顶后 = await 量(0);
  expect(置顶后.可见, "已置顶那颗要常驻（不靠 hover 才看得见）").toBe(true);
  // 核心判据：**星星还在同一列、名字列没被挤窄**（原来一置顶就在名字后面插一枚旗，整行左移）
  expect(Math.abs(置顶后.x - 未置顶.x), "置顶前后星星的横向中心不许移动").toBeLessThanOrEqual(1);
  expect(Math.abs(置顶后.名字宽 - 未置顶.名字宽), "名字列宽度也不许跟着变").toBeLessThanOrEqual(1);

  // 行内不再插第二枚旗（两态位置一错，一半原因是它占宽度）；不可用那枚文字标记不在此列
  await expect(行.first().locator(".recent__flag:not(.is-bad)")).toHaveCount(0);
  await expect(星(0)).toHaveClass(/is-on/);
});

test("文件被删除后条目仍在但标为不可用，点击给提示", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "mdsb.mock.recent.v2",
      JSON.stringify([
        { path: "/demo/已消失.md", at: Date.now(), pinned: false },
        { path: "/demo/欢迎.md", at: Date.now() - 1000, pinned: false },
      ])
    );
  });
  await page.reload();

  const bad = page.locator('.recent__item[data-path="/demo/已消失.md"]');
  await expect(bad).toContainText("不可用");

  await bad.locator(".recent__main").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("已不存在或无法读取");
});

test("大纲列出标题、点击跳转、滚动后高亮跟随", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await page.getByTestId("page-outline").click();

  const links = page.getByTestId("outline-link");
  await expect(links).toHaveCount(4); // 欢迎 + 代码块 + 表格 + 待办
  await expect(links.nth(3)).toHaveText("待办");

  const before = await page.locator(".pane__scroller").evaluate((el) => el.scrollTop);
  await links.nth(3).click();
  const after = await page.locator(".pane__scroller").evaluate((el) => el.scrollTop);
  expect(after).toBeGreaterThan(before);

  await expect(page.locator(".outline__row.is-active")).toContainText("待办");
});

test("切到另一篇文档时大纲跟着换，不残留上一篇", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await pickAndOpen(page, OTHER);
  await page.getByTestId("page-outline").click();

  await expect(page.getByTestId("outline-link")).toHaveCount(1);
  await expect(page.getByTestId("outline-link").first()).toHaveText("项目 周报 v1");
});

test("没有标题的文档显示空态而不是空白", async ({ page }) => {
  await pickAndOpen(page, "/demo/无标题.md");
  await page.getByTestId("page-outline").click();
  await expect(page.getByTestId("outline-list")).toContainText("这份文档没有标题");
  await expect(page.getByTestId("outline-link")).toHaveCount(0);
});

test("侧栏折叠后正文变宽，状态跨重启保持", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  const widthBefore = await page.locator(".pane").evaluate((el) => el.clientWidth);

  await page.getByTestId("collapse-sidebar").click();
  await expect(page.getByTestId("sidebar-rail")).toBeVisible();
  const widthAfter = await page.locator(".pane").evaluate((el) => el.clientWidth);
  expect(widthAfter - widthBefore).toBeGreaterThan(200);

  await page.reload();
  await expect(page.getByTestId("sidebar-rail")).toBeVisible();

  await page.getByTestId("sidebar-rail").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
});

test("折叠态下点大纲链接不报错（正文未渲染时静默失败）", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await page.getByTestId("collapse-sidebar").click();
  await page.getByTestId("sidebar-rail").click();
  await page.getByTestId("page-outline").click();
  await page.getByTestId("outline-link").first().click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
});

/* ---------- 外壳改造：页签居中、叫「导航」、收起把手贴在栏的右侧边 ---------- */

test("「大纲」改名「导航」，两个页签铺满这一行，收起把手在栏的右侧边", async ({ page }) => {
  await pickAndOpen(page, DEMO);

  await expect(page.getByTestId("page-outline")).toHaveText("导航");
  await expect(page.getByTestId("page-recent")).toHaveText("最近");

  const box = async (t: string) => page.getByTestId(t).boundingBox();
  const sidebar = (await box("sidebar"))!;
  const recent = (await box("page-recent"))!;
  const outline = (await box("page-outline"))!;
  const edge = (await box("collapse-sidebar"))!;

  /*
   * 127 第二批定的是「整组居中、两侧留白相等」，153 改口了：
   * 「继续加宽标签宽度和底部色条宽度，尽可能对齐下方滚动条左侧」——
   * 于是两颗页签改成**平分这一行**：左缘贴住栏的左边界，右缘停在收起把手的左边界。
   * 这条判据跟着换成新口径（不是删掉）：两侧留白一旦又变成 44px 那种"往中间缩"，这里要红。
   */
  expect(Math.round(recent.x - sidebar.x), "第一颗没贴住栏的左边界").toBeLessThanOrEqual(1);
  expect(Math.round(edge.x - (outline.x + outline.width)), "第二颗右缘没停在把手左边界").toBeLessThanOrEqual(1);
  expect(Math.abs(recent.width - outline.width), "两颗不等宽").toBeLessThanOrEqual(1);
  expect(recent.width, "页签又缩回窄的了").toBeGreaterThanOrEqual(110);

  // 收起把手贴着栏的右边缘；153 之后页签右缘**正好停在把手左边界**（齐平，不再留缝），
  // 所以这条从"严格在右边"改成"不重叠"—— 页签压到把手上面就要红。
  expect(sidebar.x + sidebar.width - (edge.x + edge.width)).toBeLessThan(4);
  expect(edge.x).toBeGreaterThanOrEqual(outline.x + outline.width);
});

test("收起把手点下去仍能折叠与再展开（位置换了不影响行为）", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await page.getByTestId("collapse-sidebar").click();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await page.getByTestId("sidebar-rail").click();
  await expect(page.getByTestId("collapse-sidebar")).toBeVisible();
});


/* ---------------- 127：三档都要能点导航定位（原来只有阅读模式能跳） ---------------- */

/** 侧栏切到「导航」页签并等条目出来 */
async function openNav(page: Page) {
  await page.getByTestId("page-outline").click();
  await expect(page.getByTestId("outline-link").first()).toBeVisible();
}

const scrollTopOf = (page: Page, sel: string) =>
  page.evaluate((s) => document.querySelector<HTMLElement>(s)?.scrollTop ?? -1, sel);

test("编辑模式点导航能定位到那一节（原来提示「找不到小节」）", async ({ page }) => {
  await pickAndOpen(page, DEMO);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");
  await openNav(page);
  await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".edit-pane__scroll");
    if (sc) sc.scrollTop = 0;
  });
  await page.getByTestId("outline-link").nth(2).click();
  await expect
    .poll(() => scrollTopOf(page, ".edit-pane__scroll"), { timeout: 3000 })
    .toBeGreaterThan(0);
  // 「找不到小节」这条错误提示不该再出现
  await expect(page.getByTestId("status-error")).toHaveCount(0);
});

test("源码模式点导航能定位到那一行（同一处，按第 n 个标题行）", async ({ page }) => {
  // 自带一份够长的夹具：内置的 欢迎.md 只有几行，源码模式连滚动条都没有，
  // `scrollTop > 0` 这条判据在那种文档上是**永远不可能成立**的（第一次就在这儿假红）
  const path = "/demo/源码导航定位.md";
  await page.evaluate((p) => {
    const body =
      "# 一\n\n" +
      Array.from({ length: 40 }, (_, i) => `第 ${i} 段正文，撑高度用，让源码模式真的能滚。`).join("\n\n") +
      "\n\n# 二\n\n" +
      Array.from({ length: 40 }, (_, i) => `再来一段 ${i}，继续撑。`).join("\n\n") +
      "\n\n# 三\n\n结尾。\n";
    (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, body);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, path);
  await page.getByTestId("tab-open").click();
  await setMode(page, "source");
  await page.waitForSelector(".cm-content");
  await openNav(page);
  // 前提：这份文档在源码模式确实可滚（不可滚的话下面的判据是空的）
  expect(await scrollTopOf(page, ".cm-scroller")).toBeGreaterThanOrEqual(0);
  expect(
    await page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>(".cm-scroller");
      return !!sc && sc.scrollHeight > sc.clientHeight + 100;
    })
  ).toBe(true);
  await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".cm-scroller");
    if (sc) sc.scrollTop = 0;
  });
  await page.getByTestId("outline-link").nth(2).click();
  await expect
    .poll(() => scrollTopOf(page, ".cm-scroller"), { timeout: 3000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId("status-error")).toHaveCount(0);
});

test("三档点同一条导航，落到的是同一个标题（按序号不按文字，重复标题也不会跳错）", async ({ page }) => {
  const path = "/demo/导航定位.md";
  await page.evaluate((p) => {
    const body =
      "# 甲\n\n" +
      Array.from({ length: 30 }, (_, i) => `第 ${i} 段正文，撑高度用。`).join("\n\n") +
      "\n\n# 重复标题\n\n" +
      Array.from({ length: 30 }, (_, i) => `再来一段 ${i}。`).join("\n\n") +
      "\n\n# 重复标题\n\n结尾。\n";
    (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, body);
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, path);
  await page.getByTestId("tab-open").click();
  await openNav(page);
  const links = page.getByTestId("outline-link");
  // 两个「重复标题」，点第二个必须落到文档末尾那一处
  const 第二个重复 = links.nth(2);
  await expect(第二个重复).toHaveText("重复标题");
  await 第二个重复.click();
  await expect
    .poll(() => scrollTopOf(page, ".pane__scroller"), { timeout: 3000 })
    .toBeGreaterThan(0);
  const 顶部 = await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".pane__scroller")!;
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    const heads = [...sc.querySelectorAll("h1")];
    const 最靠近顶部 = heads.reduce((a, h) =>
      Math.abs(h.getBoundingClientRect().top - base) < Math.abs(a.top - base)
        ? { top: h.getBoundingClientRect().top - base, text: h.textContent ?? "" }
        : a
    , { top: 1e9, text: "" });
    return 最靠近顶部.text;
  });
  expect(顶部).toBe("重复标题");
});
