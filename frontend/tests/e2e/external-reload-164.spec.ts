import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 164（要求：「新增文件自动刷新功能，应对其他工具改了文件」）。
 *
 * 这里跑的是**真的 2 秒轮询**（不给测试开后门手动触发）：这颗功能的本体就是"过一会儿去看一眼"，
 * 拿手动触发测出来的绿证明不了定时器是对的。
 * 两条时间口径：
 * - 打开之后先等满一轮（≥2.6s）让基准记下来 —— 基准没记上就去改文件，第一轮只会"记一下"，测不到重载；
 * - 改完再等一轮多（≥2.8s）才读结论。
 *
 * 三条已定口径各钉一条：干净时静默重载 / 脏时问一声（两颗键）/ 自己保存不许自激。
 */

const 路径 = "/demo/外部改动.md";
const 原文 = "# 原始标题\n\n原来的一段。\n";
const 改后 = "# 别的工具改过的标题\n\n原来的一段。\n";

const seed = async (page: Page, 内容: string) =>
  page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
    },
    [路径, 内容]
  );

const 屏幕标题 = (page: Page) =>
  page.locator(".hp-doc h1, .ProseMirror h1").first().textContent().then((t) => (t ?? "").trim());

async function 开这篇(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [路径, 原文]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.locator(".tab.is-active")).toContainText("外部改动");
  await page.waitForTimeout(2600); // 等第一轮把基准记下来
}

const 提示条 = (page: Page) => page.getByTestId("ext-notice");

/**
 * 「不许冒头」这一类断言不能直接写 `toHaveCount(0)`。
 *
 * Playwright 的断言会**重试到超时为止** —— 一个出现过又自己消失的东西
 * （那句 2.6 秒的回声就是）会被重试成"通过"，判据绿得什么也没证明。
 * 本轮做破法自证时就是这么抓到的：把「内容其实一样」那道判断删掉，
 * 探针明明看到回声冒出来了，这两条断言照样绿。
 * 所以改成按 300ms 采样整个窗口、取最大值断言为 0。
 */
async function 全程没冒头(page: Page, 采样毫秒: number): Promise<number> {
  let 最多 = 0;
  for (let 已 = 0; 已 < 采样毫秒; 已 += 300) {
    最多 = Math.max(最多, await page.locator('[data-testid="ext-notice"], [data-testid="ext-echo"]').count());
    await page.waitForTimeout(300);
  }
  return 最多;
}

test("没有未保存编辑时：外部改了就直接重载，界面上只留一句回声", async ({ page }) => {
  await 开这篇(page);
  expect(await 屏幕标题(page)).toBe("原始标题");

  await seed(page, 改后);
  await page.waitForTimeout(2800);

  expect(await 屏幕标题(page), "阅读档应该已经换成盘上那份").toBe("别的工具改过的标题");
  await expect(page.getByTestId("ext-echo")).toBeVisible(); // 一句轻提示，不挡操作
  await expect(提示条(page), "没脏就不该拦住人问一声").toHaveCount(0);
  await expect(page.getByTestId("tab-dirty"), "重载之后不该亮着脏点").toHaveCount(0);
});

test("有未保存编辑时：只问一声，屏幕上的编辑一个字都不动", async ({ page }) => {
  await 开这篇(page);
  await setMode(page, "edit");
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.type("（我在这里加了字，还没保存）", { delay: 30 });
  await expect(page.getByTestId("tab-dirty")).toBeVisible();

  await seed(page, 改后);
  await page.waitForTimeout(2800);

  await expect(提示条(page)).toBeVisible();
  await expect(page.getByTestId("ext-reload")).toBeVisible();
  await expect(page.getByTestId("ext-keep")).toBeVisible();
  expect(await 屏幕标题(page), "问一声的阶段绝不能先把编辑盖掉").toBe("原始标题");
  const 正文 = await page.locator(".ProseMirror").innerText();
  expect(正文).toContain("（我在这里加了字，还没保存）");
});

test("提示条上点「保留我的编辑」：提示消失、编辑还在，而且不再每两秒重复问", async ({ page }) => {
  await 开这篇(page);
  await setMode(page, "edit");
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.type("（保留我这边的）", { delay: 30 });
  await seed(page, 改后);
  await page.waitForTimeout(2800);
  await expect(提示条(page)).toBeVisible();

  await page.getByTestId("ext-keep").click();
  await expect(提示条(page)).toHaveCount(0);
  expect(await page.locator(".ProseMirror").innerText()).toContain("（保留我这边的）");

  await page.waitForTimeout(3200); // 再过一轮多：基准已认到盘上那份，不该再问
  await expect(提示条(page), "重复提醒等于没提醒").toHaveCount(0);
});

test("提示条上点「重载磁盘版本」：换成盘上那份，脏点熄掉", async ({ page }) => {
  await 开这篇(page);
  await setMode(page, "edit");
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.type("（我这边的会被丢掉）", { delay: 30 });
  await seed(page, 改后);
  await page.waitForTimeout(2800);
  await expect(提示条(page)).toBeVisible();

  await page.getByTestId("ext-reload").click();
  await expect(提示条(page)).toHaveCount(0);
  expect(await 屏幕标题(page)).toBe("别的工具改过的标题");
  expect(await page.locator(".ProseMirror").innerText()).not.toContain("（我这边的会被丢掉）");
  await expect(page.getByTestId("tab-dirty"), "重载完盘上就是这份，不该还脏").toHaveCount(0);
});

test("自己 Ctrl+S 之后不许弹提示（保存必然动 mtime，这是最容易自激的一条）", async ({ page }) => {
  await 开这篇(page);
  await setMode(page, "edit");
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.type("（存一下）", { delay: 30 });
  await page.keyboard.press("Control+s");
  const 冒头1 = await 全程没冒头(page, 4200); // 让轮询至少经过两轮

  expect(冒头1, "自己写的盘不算外部改动，也不该说一句「已重载」把人吓一跳").toBe(0);
  expect(await page.locator(".ProseMirror").innerText()).toContain("（存一下）");
});

test("别的工具把一模一样的字节重写一遍（只动 mtime）：什么都不做", async ({ page }) => {
  await 开这篇(page);
  await seed(page, 原文); // 同样的内容，mtime 变了
  const 冒头2 = await 全程没冒头(page, 4200);
  expect(冒头2, "格式化器 / git checkout / 云盘同步常这么干，弹提示或说一句「已重载」都是噪音").toBe(0);
  expect(await 屏幕标题(page)).toBe("原始标题");
});

test("文件被外部删掉：只提示读不到，不给「重载」这种必然被拒的键", async ({ page }) => {
  await 开这篇(page);
  await page.evaluate((p) => {
    (window as unknown as { __hpMockDropFile?: (a: string) => void }).__hpMockDropFile!(p);
  }, 路径);
  await page.waitForTimeout(2800);

  await expect(提示条(page)).toBeVisible();
  await expect(page.getByTestId("ext-ok")).toBeVisible();
  await expect(page.getByTestId("ext-reload"), "读不到的东西不该摆一颗「重载」键").toHaveCount(0);
  await page.getByTestId("ext-ok").click();
  await expect(提示条(page)).toHaveCount(0);
});

test("未命名档（还没有路径）不去盯盘，也不报错", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("tab-new").click();
  expect(await 全程没冒头(page, 4200), "没有路径就没有可盯的文件，别报错也别弹东西").toBe(0);
});
