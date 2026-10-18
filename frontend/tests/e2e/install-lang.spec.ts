import { expect, test } from "@playwright/test";
import { gotoApp } from "./mockApp";

/**
 * 135：安装期那一页选的语言，要真的变成应用的首启语言。
 *
 * 链路：NSIS 写 `HKCU\Software\MDStar\Language` → Go `StateService.InstallLanguage()`
 * → host.installLanguage() → settings 读档时「存过的值 > 安装期的值 > 中文」。
 * 桌面注册表这一段没法在浏览器里跑，所以这里用 mock 宿主的
 * `mdsb.mock.installLang` 当注册表的替身（宿主契约里就是这一个口子）。
 */

/**
 * 播种用的 init script。
 *
 * **必须走 addInitScript 的第二个参数把数据传进去**：Playwright 是把函数源码搬到页面里执行的，
 * 闭包带不进去 —— 写成 `() => { if (opts.x) ... }` 这种捕获外层变量的形式，
 * 页面里 `opts` 是 undefined，整段 init script 抛 ReferenceError，
 * 表现成"我明明播了 en，界面还是中文"的假缺陷（这一条踩过一次）。
 */
function seed(o: { installLang?: string; settings?: Record<string, unknown> }) {
  window.localStorage.clear();
  if (o.installLang) window.localStorage.setItem("mdsb.mock.installLang", o.installLang);
  // 键名字面量写死在这里：init script 里引用不到模块作用域的 LS_SETTINGS（同上，闭包带不进去）
  if (o.settings) window.localStorage.setItem("mdsb.mock.settings.v1", JSON.stringify(o.settings));
}

test("装的时候选了 English → 首启界面就是英文", async ({ page }) => {
  await page.context().addInitScript(seed, { installLang: "en" });
  await gotoApp(page);
  await expect(page.getByTestId("status-not-opened")).toHaveText("No document open");
});

test("装的时候选了中文（或读不到）→ 首启是中文", async ({ page }) => {
  await page.context().addInitScript(seed, { installLang: "zh" });
  await gotoApp(page);
  await expect(page.getByTestId("status-not-opened")).toHaveText("未打开文档");
});

test("安装期说英文，但用户在设置里改成过中文 → 以存过的为准", async ({ page }) => {
  await page.context().addInitScript(seed, {
    installLang: "en",
    settings: { lang: "zh", autoSave: false },
  });
  await gotoApp(page);
  await expect(page.getByTestId("status-not-opened")).toHaveText("未打开文档");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("setting-lang")).toHaveValue("zh");
});

test("存过的值是坏字符串 → 当成没存过，落回安装期的选择", async ({ page }) => {
  await page.context().addInitScript(seed, {
    installLang: "en",
    settings: { lang: "klingon", autoSave: false },
  });
  await gotoApp(page);
  await expect(page.getByTestId("status-not-opened")).toHaveText("No document open");
});
