import { expect, test } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * 127 外壳改造：主题开关从设置里挪到标签栏齿轮右侧。
 *
 * 她这句话里有两个可判定的点，各自钉住：
 * ① 「放到设置右侧」→ 开关必须在齿轮**右手边**（比 x 坐标）；
 * ② 「右侧与上方的关闭按钮对齐，注意是视觉效果对齐」→ 用 boundingBox 量右缘，
 *    差值按 1px 收。不看截图猜「差不多对齐」。
 */

test("标签栏那一组三个键尺寸一致（她：图标要和旁边的大小一致）", async ({ page }) => {
  await gotoApp(page);

  const 盒 = {} as Record<string, { width: number; height: number; x: number }>;
  for (const id of ["tab-new", "tab-open", "open-settings"]) {
    盒[id] = (await page.getByTestId(id).boundingBox())!;
  }
  const 基准 = 盒["tab-new"];
  for (const id of ["tab-open", "open-settings"]) {
    expect(Math.abs(盒[id].width - 基准.width), id + " 宽度").toBeLessThanOrEqual(1);
    expect(Math.abs(盒[id].height - 基准.height), id + " 高度").toBeLessThanOrEqual(1);
  }
  // 图形本身也要一样大（两颗 SVG 都是 15px）；「+」是字符，只要求它所在盒子一致
  const 图形宽 = await page.evaluate(() =>
    [...document.querySelectorAll(".tabbar__open svg, .tabbar__settings svg")].map((s) =>
      Math.round(s.getBoundingClientRect().width)
    )
  );
  expect(图形宽.length).toBe(2);
  expect(new Set(图形宽).size).toBe(1);
});

test("主题开关在齿轮右侧，右缘与顶栏关闭按钮对齐", async ({ page }) => {
  await gotoApp(page);

  const gear = (await page.getByTestId("open-settings").boundingBox())!;
  const pill = (await page.getByTestId("theme-switch").boundingBox())!;
  const close = (await page.getByTestId("win-close").boundingBox())!;

  expect(pill.x).toBeGreaterThan(gear.x + gear.width - 1);
  // 视觉对齐：两者右缘都落在「视口宽 - 10px」这条线上
  expect(Math.abs(pill.x + pill.width - (close.x + close.width))).toBeLessThanOrEqual(1);
  // 高度上别顶出这一栏，也不要矮成一坨（与齿轮同高 22px）
  expect(Math.abs(pill.height - gear.height)).toBeLessThanOrEqual(2);
});

test("点月亮切深色、点太阳切回浅色，滑块跟着走到那一格", async ({ page }) => {
  await gotoApp(page);

  const thumb = page.locator('.themepill__thumb');
  const bgOf = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--hp-bg").trim());

  expect(await bgOf()).toBe("#f6f3ed");
  await expect(page.getByTestId("theme-light")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bgOf()).toBe("#1e2126");
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
  await expect(thumb).toHaveAttribute("data-dark", "1");
  // 滑块确实位移了一个格（24px），不是只换个颜色。
  // 有 160ms 过渡，读到的是动画途中的矩阵 —— 先等它停。
  await page.waitForTimeout(300);
  const moved = await thumb.evaluate((el) => getComputedStyle(el).transform);
  expect(moved).toMatch(/matrix\(1, 0, 0, 1, 24/);

  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bgOf()).toBe("#f6f3ed");
  await page.waitForTimeout(300);
  expect(await thumb.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
});

test("设置对话框里不再有主题这一项（一个设置只留一个入口）", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("open-settings").click();

  await expect(page.getByTestId("setting-theme")).toHaveCount(0);
  await expect(page.locator(".rows .row__label", { hasText: "主题" })).toHaveCount(0);
  // 其它项还在，别把整张表删坏了
  await expect(page.getByTestId("setting-autosave")).toBeVisible();
  // 130：「基础字号」已从设置里删掉（挪进编辑工具栏且只作用编辑档），守门的"其它项"换成行号这一项
  await expect(page.getByTestId("setting-linenumbers")).toBeVisible();
  await expect(page.getByTestId("setting-fontsize")).toHaveCount(0);
});

/**
 * 127 第二条：「最近 / 导航」页签增大 + 标签栏左边界与收起后的窄边右缘对齐。
 *
 * 对齐的基准是**收起后那条 18px 窄边的右缘**（`.rail` 是 border-box，18px 已含右框线）。
 * 拿它当基准而不是「展开时侧栏的右缘」：侧栏宽度能拖，收起后的窄边不会 —— 那条线是定的。
 */
test("「最近 / 导航」页签：图标 + 文字 + 下划线，尺寸与这一栏相称", async ({ page }) => {
  await gotoApp(page);

  for (const testid of ["page-recent", "page-outline"]) {
    const b = (await page.getByTestId(testid).boundingBox())!;
    // 127 第二批：页签改成下划线式，整颗顶满这一行，不再是行里的一颗小药丸；
    // **129 把这一行收到 32px**（她也要求顶栏收窄），所以这里补一条上限 —— 退回 40 要红。
    expect(b.height).toBeGreaterThanOrEqual(30);
    expect(b.height).toBeLessThanOrEqual(34);
    expect(b.width).toBeGreaterThanOrEqual(80);
    // 图标是画的 SVG，不是 emoji 字符：必须真有一个 ~14px 的 svg 在文字左边
    const svg = page.getByTestId(testid).locator("svg");
    await expect(svg).toHaveCount(1);
    const 图 = (await svg.boundingBox())!;
    expect(图.width).toBeGreaterThanOrEqual(12);
    expect(图.height).toBeGreaterThanOrEqual(12);
  }
  // 选中态是**底部一条 2px 的 accent 下划线**（不是整块蓝底）
  const 下划线 = await page.getByTestId("page-recent").evaluate((el) => {
    const a = getComputedStyle(el, "::after");
    return { h: a.height, bg: a.backgroundColor, content: a.content };
  });
  expect(下划线.content).not.toBe("none");
  expect(Number(下划线.h.replace("px", ""))).toBeCloseTo(2, 1);
  // 没选中的那颗没有这条线
  const 未选 = await page.getByTestId("page-outline").evaluate((el) => getComputedStyle(el, "::after").content);
  expect(未选).toBe("none");
});

/**
 * 127 第二批：最近列表一行只剩文件名。
 * 四件事各自钉住：不显示目录、按钮与名字居中对齐、超长截断不压到按钮、悬停 1 秒滚出全名。
 */
test("最近列表：只显示文件名，按钮居中、超长截断、悬停 1 秒滚出全名", async ({ page }) => {
  await gotoApp(page);
  const 长名 = "/demo/" + "审批时效口径统一与看板指标定义说明书".repeat(2) + ".md";
  await page.evaluate((p) => {
    (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(p, "# 长名\n");
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, 长名);
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await page.getByTestId("page-recent").click();

  const 行 = page.locator(".recent__item");
  await expect(行).toHaveCount(1);
  // ① 只剩文件名：目录那行没了（整行文本里不该出现 "/demo"）
  await expect(行.first()).not.toContainText("/demo");
  await expect(行.first()).toContainText("审批时效口径统一");
  // 完整路径改由 title 给（悬停可读，也是跑马灯的兜底）
  await expect(行.first().locator(".recent__main")).toHaveAttribute("title", 长名);

  // ② 名字与两颗按钮在同一水平中线上
  const 对齐 = await 行.first().evaluate((el) => {
    const name = el.querySelector(".recent__name")!.getBoundingClientRect();
    const ops = [...el.querySelectorAll(".recent__ops button")].map((b) => b.getBoundingClientRect());
    const 中心 = (r: DOMRect) => r.top + r.height / 2;
    return { 名字: 中心(name), 按钮: ops.map(中心), 高: name.height };
  });
  for (const 中心 of 对齐.按钮) expect(Math.abs(中心 - 对齐.名字)).toBeLessThanOrEqual(1.5);

  // ③ 截断：名字这一列溢出，且按钮没被挤出可见区域
  const 截断 = await 行.first().evaluate((el) => {
    const n = el.querySelector(".recent__name")!;
    const ops = el.querySelector(".recent__ops")!.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    return {
      溢出: n.scrollWidth > n.clientWidth + 1,
      按钮在行内: ops.right <= row.right + 1,
      省略号会画: getComputedStyle(n).textOverflow.includes("ellipsis") &&
        // 子盒子平时必须是 inline：常驻 inline-block 时 ellipsis 不作用，字会被直接裁掉（截图上就是「没有 …」）
        getComputedStyle(n.querySelector(".recent__text")!).display === "inline",
    };
  });
  expect(截断.溢出).toBe(true);
  expect(截断.按钮在行内).toBe(true);
  expect(截断.省略号会画).toBe(true);

  // ④ 悬停 1 秒后才滚（早于 1 秒不许动 —— 扫过列表时不该整列乱晃）
  await 行.first().hover();
  await page.waitForTimeout(500);
  await expect(行.first().locator(".recent__name")).not.toHaveClass(/is-scrolling/);
  await page.waitForTimeout(900);
  await expect(行.first().locator(".recent__name")).toHaveClass(/is-scrolling/);
  const 滚动 = await 行.first().locator(".recent__name").evaluate((el) => ({
    位移: (el as HTMLElement).style.getPropertyValue("--hp-shift"),
    时长: (el as HTMLElement).style.getPropertyValue("--hp-dur"),
    // 滚的那一刻必须换成 inline-block —— transform 不作用于非替换 inline，忘了换就是「延时到了字却不动」
    能平移: getComputedStyle(el.querySelector(".recent__text")!).display === "inline-block",
  }));
  expect(滚动.能平移).toBe(true);
  expect(滚动.位移).toMatch(/^-\d+(\.\d+)?px$/);
  expect(Number(滚动.时长.replace("s", ""))).toBeGreaterThan(2);
  // 移出即复位，不停在中间
  await page.mouse.move(4, 4);
  await expect(行.first().locator(".recent__name")).not.toHaveClass(/is-scrolling/);
});

/**
 * 127 第三批：「扫过列表不该整列乱动」这条承诺的判据。
 * 两行都是长名字：鼠标在第一行只停 300ms 就挪到第二行 —— 第一行的 1 秒延时必须被取消，
 * 而且同一时刻只允许一行在滚（延时器是组件级单例，不是每行一个）。
 * 另一半判据是给「迟到的定时器」兜的那道闸：延时到点时再认一次 `:hover`，
 * 指针已经不在这行上就不许开滚（列表重新渲染时 mouseleave 可能送不到，这条只能靠自证）。
 */
test("最近列表跑马灯：扫过去不停留就不滚，同时只有一行在滚", async ({ page }) => {
  await gotoApp(page);
  const 甲 = "/demo/" + "审批时效口径统一与看板指标定义说明书".repeat(2) + "-甲.md";
  const 乙 = "/demo/" + "工技融合服务平台需求规格与接口约定".repeat(2) + "-乙.md";
  for (const p of [甲, 乙]) {
    await page.evaluate((path) => {
      (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(path, "# 长名\n");
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = path;
    }, p);
    await page.getByTestId("tab-open").click();
    await expect(page.getByTestId("document-root")).toBeVisible();
  }
  await page.getByTestId("page-recent").click();
  const 行 = page.locator(".recent__item");
  await expect(行).toHaveCount(2);
  const 名字 = (i: number) => 行.nth(i).locator(".recent__name");
  for (const i of [0, 1]) {
    expect(await 名字(i).evaluate((el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1)).toBe(true);
  }

  await 行.nth(0).hover();
  await page.waitForTimeout(300);
  await 行.nth(1).hover(); // 从第一行直接挪到第二行
  await page.waitForTimeout(1300);
  await expect(名字(0)).not.toHaveClass(/is-scrolling/); // 扫过去的不停
  await expect(名字(1)).toHaveClass(/is-scrolling/); // 停下的才滚
  expect(await 行.evaluateAll((els) => els.filter((e) => e.querySelector(".recent__name.is-scrolling")).length)).toBe(1);

  // 迟到的定时器那道闸：手动把延时尾巴在「指针已离开」之后放出来，也不许开滚
  await page.mouse.move(4, 4);
  await expect(名字(1)).not.toHaveClass(/is-scrolling/);
  await 名字(1).evaluate((el) => {
    const row = el.closest(".recent__item") as HTMLElement;
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); // 只补 enter 不补 leave，模拟事件不成对
  });
  await page.waitForTimeout(1300);
  await expect(名字(1)).not.toHaveClass(/is-scrolling/);
});

test("最近列表右键出菜单：复制路径、在资源管理器中显示（mock 下置灰）", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await page.getByTestId("page-recent").click();

  const 行 = page.locator(".recent__item").first();
  await expect(行).toHaveCount(1);
  await 行.click({ button: "right" });
  const menu = page.locator(".menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("recent-menu-copy")).toBeVisible();
  // mock 宿主 capabilities.revealInFolder = false → 该置灰就置灰，别给一个点了没反应的菜单项
  await expect(page.getByTestId("recent-menu-reveal")).toHaveClass(/is-disabled/);

  await page.getByTestId("recent-menu-copy").click();
  await expect(menu).toHaveCount(0);
  // mock 的 writeClipboard 会把内容存进它自己的伪剪贴板（`__hpMockState().clipboard`），
  // 不依赖浏览器剪贴板权限 —— 权限没给时 navigator.clipboard 是静默失败的
  const 剪贴板 = await page.evaluate(
    () =>
      (window as unknown as { __hpMockState?: () => { clipboard: string } }).__hpMockState?.().clipboard ?? ""
  );
  expect(剪贴板).toContain(".md");
});

test("有标签时：首个标签左边界 = 收起后窄边的右缘", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("open-button").click();
  await expect(page.locator(".tab").first()).toBeVisible();

  await page.getByTestId("collapse-sidebar").click();
  const rail = (await page.getByTestId("sidebar-rail").boundingBox())!;
  const first = (await page.locator(".tab").first().boundingBox())!;
  expect(Math.abs(first.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
});

test("没打开文件时：新增按钮左边界 = 收起后窄边的右缘", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await expect(page.locator(".tab")).toHaveCount(0);

  await page.getByTestId("collapse-sidebar").click();
  const rail = (await page.getByTestId("sidebar-rail").boundingBox())!;
  // 这一栏的第一个元素现在是「+」（新增标签）
  const plus = (await page.getByTestId("tab-new").boundingBox())!;
  expect(Math.abs(plus.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
});
