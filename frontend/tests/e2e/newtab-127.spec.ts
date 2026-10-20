import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 127：标签栏「+」= 新增标签（未命名空文档，可直接输入）。
 *
 * 她这句话里可判定的部分逐条钉住：
 * - 「调整为新增标签」→ 点 + 得到一个标签，名字是「未命名」，且**没有路径**；
 * - 「内容为空，可输入」→ 直接落在编辑档，键入即成文；
 * - 「在这个新增一个创建按钮」→ 空态页上「新建」与 + 走同一个动作；
 * - 「关闭该标签和关闭软件时，都要提示保存」→ 脏了才问（改回原样就不该问），
 *   且未命名文档的「保存」= 另存为（没有原地保存这条路）。
 *
 * 顺带钉三条**这条改动最容易连带弄坏**的：
 * - 未命名文档不进最近列表（它没有路径，进了就是一条打不开的记录）；
 * - 自动保存开着时它不去排写盘（否则每停手一次就在底栏冒一条「写入失败」并把开关关掉）；
 * - 连点 + 不产生一排空标签（复用没动过的那张）。
 */

const readMock = (page: Page, p: string) =>
  page.evaluate(
    (x) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(x),
    p
  );

const tabNames = (page: Page) => page.locator(".tab__name").allTextContents();

test.beforeEach(async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
});

test("点「+」得到一份未命名的空文档，直接可以打字", async ({ page }) => {
  await page.getByTestId("tab-new").click();

  await expect(tabNames(page)).resolves.toEqual(["未命名"]);
  // 「可输入」的硬判据：编辑档的 PM 实例已经挂载并聚焦，不是只切了个档
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("# 草稿");

  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText("未命名");

  // 没有路径 → 不进最近列表（进了就是一条点不开的记录）
  await page.getByTestId("page-recent").click();
  await expect(page.getByTestId("recent-list")).toContainText("还没有打开过文件");
});

test("空态页的「新建」与标签栏「+」是同一个动作", async ({ page }) => {
  await page.getByTestId("new-button").click();
  await expect(tabNames(page)).resolves.toEqual(["未命名"]);
  await expect(page.locator(".ProseMirror")).toBeVisible();
});

test("连点两次「+」只有一张空标签；写过字后再点才新建第二张", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.getByTestId("tab-new").click();
  await page.getByTestId("tab-new").click();
  await expect(tabNames(page)).resolves.toEqual(["未命名"]);

  await page.locator(".ProseMirror").click();
  await page.keyboard.type("第一张上有字");
  await page.getByTestId("tab-new").click();
  await expect(tabNames(page)).resolves.toEqual(["未命名", "未命名"]);

  // 第二张是**空的**：复用只认「一个字都没写过」的那张，绝不清掉用户的稿子
  await expect(page.locator(".ProseMirror")).toHaveText("");
});

test("Ctrl+T 与点「+」等价", async ({ page }) => {
  await page.keyboard.press("Control+t");
  await expect(tabNames(page)).resolves.toEqual(["未命名"]);
});

test("未命名文档开了自动保存也不会报「写入失败」", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("setting-autosave").check();
  await page.getByTestId("settings-close").click();

  await page.locator(".ProseMirror").click();
  await page.keyboard.type("随手打几个字");
  await page.waitForTimeout(1800); // 防抖 1000ms，留足余量

  await expect(page.getByTestId("status-error")).toHaveCount(0);
  // 脏点还在：没落盘就是没落盘，不许偷偷当成已保存
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
});

test("关闭脏的未命名标签要先问；选「保存」走另存为并真的落盘", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("这段不能丢");

  await page.locator(".tab__close").click();
  const dlg = page.getByTestId("confirm-dialog");
  await expect(dlg).toContainText("未命名");
  await expect(dlg).toContainText("未保存的改动");
  // 127（她的口径 ③）：未命名档的按钮要写成「保存并命名」，并说清要选位置 ——
  // 按下去和已落盘的文档不一样，界面上不许含糊。
  await expect(dlg).toContainText("选存放位置");
  await expect(dlg.getByTestId("confirm-保存并命名")).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __hpMockSavePath?: string }).__hpMockSavePath = "/demo/草稿落盘.md";
  });
  await dlg.getByTestId("confirm-保存并命名").click();

  expect(await readMock(page, "/demo/草稿落盘.md")).toContain("这段不能丢");
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("另存为写不进去：标签留在原地，名字仍是「未命名」，内容不丢", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("别动我的稿子");

  await page.locator(".tab__close").click();
  await page.evaluate(() => {
    const w = window as unknown as { __hpMockSavePath?: string; __hpMockFailWrites?: string };
    w.__hpMockSavePath = "/demo/写不进.md";
    w.__hpMockFailWrites = "只读";
  });
  await page.getByTestId("confirm-dialog").getByTestId("confirm-保存并命名").click();

  // 报的是写失败（不是「该文档还没有路径」那种答非所问），并且标签没被关掉
  await expect(page.getByTestId("confirm-dialog")).toContainText("保存失败");
  await expect(page.getByTestId("confirm-dialog")).toContainText("只读");
  await page.getByTestId("confirm-dialog").getByTestId("confirm-知道了").click();

  await expect(tabNames(page)).resolves.toEqual(["未命名"]);
  await expect(page.locator(".ProseMirror")).toContainText("别动我的稿子");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);
});

test("改回原样就不算脏：未命名文档写完又删干净，关闭不再问", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("写了又删");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(1);

  // 全选删干净：内容回到与基准（空串）逐字节相等
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  await page.locator(".tab__close").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.locator(".tab")).toHaveCount(0);
});

test("关软件时脏的未命名文档也要问，并且说清「保存会先让你选位置」", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("退出前没存");

  await page.getByTestId("win-close").click();
  const dlg = page.getByTestId("confirm-dialog");
  await expect(dlg).toContainText("未命名");
  await expect(dlg).toContainText("这份还没保存过");

  await page.evaluate(() => {
    (window as unknown as { __hpMockSavePath?: string }).__hpMockSavePath = "/demo/退出时保存.md";
  });
  await dlg.getByTestId("confirm-保存并退出").click();
  expect(await readMock(page, "/demo/退出时保存.md")).toContain("退出前没存");
});

test("未命名文档粘图片：给一句可读的拒绝，不是默默吞掉", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await setMode(page, "edit");
  await page.locator(".ProseMirror").click();
  await page.evaluate(() => {
    (window as unknown as { __hpMockPaste?: (p: unknown) => void }).__hpMockPaste!({
      files: [{ name: "a.png", mime: "image/png", bytes: [1, 2, 3, 4] }],
    });
  });
  await expect(page.getByTestId("open-error")).toContainText("要先保存文档");
  // 正文不该被插进一条坏的图片引用
  await expect(page.locator(".ProseMirror")).toHaveText("");
});

/* ------------------------------------------------------------------ 141 */

/**
 * 141（她的实测：「新增 markdown 文件时，你默认选中了正文，但此时光标没在页面上，
 * 我在页面上点击也没用」）。两半都要钉住：
 * ① 点完「+」光标**已经在文档里**，不用先点一下页面；
 * ② 正文区下方那一大片空白**属于可编辑区**，点进去能落光标、能打字。
 *
 * ②是根因：空文档时 `.ProseMirror` 只有一行高（实测 26px），下面半屏不是
 * contenteditable —— 点那里 activeElement 直接掉回 BODY，键盘输入无处可去。
 * 127 原来那条用例是「先 click 再 type」，正好绕过了这个洞，所以它一直是绿的。
 */
test("141：新建未命名档不用先点一下，光标已经在文档里", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ""), { timeout: 4000 })
    .toContain("ProseMirror");
  await page.keyboard.type("第一段");
  await expect(page.locator(".ProseMirror")).toContainText("第一段");
});

test("141：可编辑区铺满整页，点正文下方空白也能落光标打字", async ({ page }) => {
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").waitFor();
  await page.waitForTimeout(400);
  const 几何 = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".edit-pane__scroll")!.getBoundingClientRect();
    const pm = document.querySelector<HTMLElement>(".ProseMirror")!.getBoundingClientRect();
    const 点x = Math.round(box.x + box.width / 2);
    const 点y = Math.round(box.y + box.height * 0.7);
    return {
      点x,
      点y,
      可编辑区: { 上: Math.round(pm.top), 下: Math.round(pm.bottom), 左: Math.round(pm.left), 右: Math.round(pm.right) },
      容器底: Math.round(box.bottom),
      空白在可编辑区内: 点y > pm.top && 点y < pm.bottom && 点x > pm.left && 点x < pm.right,
    };
  });
  /*
   * 根因判据：**要点的那片空白落在可编辑区的矩形里**。
   * 第一版这里写的是「可编辑区要铺到容器底部」，那是我的想象：`.hp-doc` 本来就有 96px 下内边距，
   * 铺到底永远不成立 —— 判据本身错了会让一条好修复一直红。真正的因由是「空白属不属于可编辑区」。
   */
  expect(几何.空白在可编辑区内, JSON.stringify(几何)).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.mouse.click(几何.点x, 几何.点y);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ""), { timeout: 3000 })
    .toContain("ProseMirror");
  await page.keyboard.type("点在空白上");
  await expect(page.locator(".ProseMirror")).toContainText("点在空白上");
});
