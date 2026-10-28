import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * 162（要求：「窗口过多收纳展开放在展开按钮那里，而不是放在左边」）。
 *
 * 140 把收纳浮窗钉在栏的左端（`left: 18px`，照"首标签左边界 = 收起后窄边右边界"那条线放的），
 * 而那颗「+N」长在标签串尾巴上 —— 按钮在右、列表在左，中间隔着整栏标签。
 * 这里钉的是**几何**：浮窗右缘与按钮右缘齐平、落在按钮下方，并且**按钮挪它就挪**
 * （栏宽一变 —— 窗口拖宽拖窄 —— 那一格的位置就跟着变；实测切活动标签不改变它，
 * 因为溢出时标签正好把栏填满，所以这里用栏宽变化当"按钮挪了"的真实路径）。
 * 锚点算法本身在 `tests/unit/tab-picker-anchor-162.spec.ts`，两层给的是同一个答案。
 */

const seed = async (page: Page, i: number) => {
  const p = "/demo/贴按钮标签-" + i + ".md";
  await page.evaluate(
    ([path, text]) => {
      (window as unknown as { __hpMockSeedFile: (a: string, b: string) => void }).__hpMockSeedFile(path, text);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = path;
    },
    [p, ["# 贴按钮标签 " + i, "", "正文。", ""].join(String.fromCharCode(10))]
  );
  await page.getByTestId("tab-open").click();
  await page.waitForTimeout(120);
};

/** 浮窗与那颗「+N」的几何关系（一次读全，免得两次读之间动画没停） */
const 量位置 = (page: Page) =>
  page.evaluate(() => {
    const 钮 = document.querySelector<HTMLElement>('[data-testid="tab-more"]');
    const 窗 = document.querySelector<HTMLElement>('[data-testid="tab-picker"]');
    const 条 = 窗?.querySelector<HTMLElement>(".tabpicker__item");
    const 栏 = document.querySelector<HTMLElement>('[data-testid="tabbar"]');
    const b = 钮?.getBoundingClientRect();
    const k = 窗?.getBoundingClientRect();
    return {
      有按钮: !!b,
      有浮窗: !!k,
      按钮右缘: b ? Math.round(b.right) : -1,
      按钮下缘: b ? Math.round(b.bottom) : -1,
      浮窗右缘: k ? Math.round(k.right) : -1,
      浮窗顶边: k ? Math.round(k.top) : -1,
      浮窗左缘: k ? Math.round(k.left) : -1,
      浮窗底边: k ? Math.round(k.bottom) : -1,
      浮窗宽: k ? Math.round(k.width) : -1,
      第一条顶边: 条 ? Math.round(条.getBoundingClientRect().top) : -1,
      栏底边: 栏 ? Math.round(栏.getBoundingClientRect().bottom) : -1,
      视口宽: window.innerWidth,
      视口高: window.innerHeight,
    };
  });

async function 开满标签(page: Page, 篇数 = 12): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  for (let i = 1; i <= 篇数; i++) await seed(page, i);
  await page.waitForTimeout(300);
}

test("浮窗右缘齐平那颗「+N」、顶边在按钮下方（不再钉在栏的左端）", async ({ page }) => {
  await 开满标签(page);
  const 收纳 = page.getByTestId("tab-more");
  await expect(收纳).toBeVisible();
  await 收纳.click();
  await expect(page.getByTestId("tab-picker")).toBeVisible();
  const 态 = await 量位置(page);
  expect(态.有按钮 && 态.有浮窗).toBe(true);
  expect(Math.abs(态.浮窗右缘 - 态.按钮右缘), JSON.stringify(态)).toBeLessThanOrEqual(2);
  expect(态.浮窗顶边, JSON.stringify(态)).toBeGreaterThanOrEqual(态.按钮下缘);
  // 「放在展开按钮那里」的反面：不许又回到栏的左端（18px 那条对齐线）
  expect(态.浮窗左缘).toBeGreaterThan(态.视口宽 / 2);
  // 浮窗整片在窗口里（162 之后这是新出现的风险：原来钉左边不会捅出去）
  expect(态.浮窗左缘).toBeGreaterThanOrEqual(8);
  expect(态.浮窗底边).toBeLessThanOrEqual(态.视口高);
  // 内容区（浮窗的第一条）不许被栏本身压住
  expect(态.第一条顶边).toBeGreaterThanOrEqual(态.栏底边);
});

test("浮窗跟着按钮走，而不是跟着写死的数字走：换一种栏宽再展开，两者一起挪且保持齐平", async ({ page }) => {
  await 开满标签(page);
  await page.getByTestId("tab-more").click();
  const 宽栏 = await 量位置(page);
  await page.getByTestId("tab-picker-mask").click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId("tab-picker")).toHaveCount(0);

  /*
   * 这里用**窗口变窄**当"按钮挪了位置"的真实路径。
   * 第一版想用「收起侧栏」—— 量出来 0px：那一栏是横跨整窗的一行，侧栏在它下面，
   * 收起侧栏根本不改变标签栏宽度（`.tabbar` 左内边距 18px 只是与收起后的窄边对齐一条线）。
   * 判据自己得先站得住，不然红的就是人。
   */
  await page.setViewportSize({ width: 940, height: 720 });
  await page.waitForTimeout(500);
  await page.getByTestId("tab-more").click();
  const 窄栏 = await 量位置(page);
  expect(Math.abs(窄栏.浮窗右缘 - 窄栏.按钮右缘), JSON.stringify({ 宽栏, 窄栏 })).toBeLessThanOrEqual(2);
  // 那一格确实挪了（栏宽变了，装的标签数也变了），浮窗跟着挪同样的距离
  const 挪 = Math.abs(宽栏.按钮右缘 - 窄栏.按钮右缘);
  expect(挪, JSON.stringify({ 宽栏, 窄栏 })).toBeGreaterThan(4);
  expect(Math.abs(Math.abs(宽栏.浮窗右缘 - 窄栏.浮窗右缘) - 挪)).toBeLessThanOrEqual(2);
});

test("浮窗开着时把窗口拖窄：跟着按钮重新算，不留在原地", async ({ page }) => {
  await 开满标签(page);
  await page.getByTestId("tab-more").click();
  const 原 = await 量位置(page);
  await page.setViewportSize({ width: 900, height: 720 });
  await page.waitForTimeout(500);
  const 后 = await 量位置(page);
  expect(后.有浮窗, JSON.stringify({ 原, 后 })).toBe(true);
  expect(Math.abs(后.浮窗右缘 - 后.按钮右缘), JSON.stringify({ 原, 后 })).toBeLessThanOrEqual(2);
  // 浮窗没留在原地，也没自己跑回左边
  expect(Math.abs(原.浮窗右缘 - 后.浮窗右缘), JSON.stringify({ 原, 后 })).toBeGreaterThan(4);
  expect(后.浮窗左缘).toBeGreaterThanOrEqual(8);
  expect(后.浮窗右缘).toBeLessThanOrEqual(后.视口宽 - 8 + 1);
});

test("最小窗宽下仍不出界：右缘留边距，整片在窗口里", async ({ page }) => {
  await 开满标签(page);
  await page.setViewportSize({ width: 720, height: 480 });
  await page.waitForTimeout(400);
  await page.getByTestId("tab-more").click();
  const 态 = await 量位置(page);
  expect(态.有浮窗).toBe(true);
  expect(态.视口宽).toBe(720);
  expect(态.浮窗右缘).toBeLessThanOrEqual(态.视口宽 - 8 + 1);
  expect(态.浮窗左缘).toBeGreaterThanOrEqual(8);
  expect(态.浮窗底边).toBeLessThanOrEqual(480);
});

/**
 * 这一条钉的是**两次一致**（不抖、不跳回左上），不钉"贴着按钮"——
 * 破法自证时验过：把 `定位浮窗()` 改成一次都不算，这条照绿（它比的是同一份坏代码的两回）。
 * "贴着"由上面那两条几何判据钉。名字按它实际钉的东西写，不夸大。
 */
test("收起浮窗再展开，两次位置一致（不抖、不在第二回跳回写死的那格）", async ({ page }) => {
  await 开满标签(page);
  const 收纳 = page.getByTestId("tab-more");
  await 收纳.click();
  const 第一次 = await 量位置(page);
  await page.getByTestId("tab-picker-mask").click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId("tab-picker")).toHaveCount(0);
  await 收纳.click();
  const 第二次 = await 量位置(page);
  expect(第二次).toEqual(第一次);
});

test("从贴着按钮的浮窗里点选仍然点得到：激活 + 浮窗收起", async ({ page }) => {
  await 开满标签(page);
  await page.getByTestId("tab-more").click();
  await expect(page.getByTestId("tab-picker").locator(".tabpicker__item")).toHaveCount(12);
  const 目标 = page
    .locator(".tabpicker__item")
    .filter({ has: page.locator(".tabpicker__name", { hasText: /^贴按钮标签-1\.md$/ }) });
  await 目标.click();
  await expect(page.getByTestId("tab-picker")).toHaveCount(0);
  await expect(page.locator(".tab.is-active")).toContainText("贴按钮标签-1.md");
});
