import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp } from "./mockApp";

/**
 * 158：双击 .md 转交给已开着的实例之后，**标签没跳到那个文件**（10-25：「有些时候……
 * 两种都遇见过 —— 已经开着的和新开的都不跳」，以及关键的一句「要再双击一次才动」）。
 *
 * 「再双击一次才动」把范围钉死了：路径没有丢在操作系统那一段（丢了就永远不来），
 * 而是**留在宿主的队列里等一个再也没来的信号**。读代码对上两处顺序问题：
 *
 * ① `App.vue` 原来是「先 `await drainStartup()` → 再 `onStartupSignal()`」。
 *   drain 里每个文件都要 await 一次读盘（桌面上这是 IPC，大文档几百 ms），
 *   这段时间里到达的信号**没有监听者** —— Go 侧 `Emit` 只发一次，不重发；
 *   于是那一次双击等于没发生，直到下一次双击把两个路径一起带出来。
 * ② `drainStartup()` 跑在 `restoreSession()` 之前，而 restore 末尾会
 *   `activate(会话里那个 active)` —— 把刚由双击打开的标签的激活**抢走**。
 *   标签确实开了，只是没跳过去。
 *
 * 所以两条判据分别钉这两处，第三条钉「别把已经好的那条路弄坏」。
 *
 * 窗口造在页面里而不是测试那头（`__hpMockStartupTiming`，说明见 browser-mock 那段注释）：
 * 挂载到订阅之间只有几个微任务，从 CDP 外面插一刀全凭运气，红了绿了都说明不了问题。
 */

const A = "/demo/欢迎.md";
const B = "/demo/项目 周报 v1.md";
const 名A = "欢迎.md";
const 名B = "项目 周报 v1.md";

async function 挑开(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
  }, path);
  await page.getByTestId("tab-open").click();
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText(path.split("/").pop()!);
}

const 等钩子 = (page: Page) =>
  page.waitForFunction(
    () => typeof (window as unknown as { __hpMockSeedFile?: unknown }).__hpMockSeedFile === "function"
  );

test("158-A 冷启动双击：会话里存的标签不许把激活抢走", async ({ page }) => {
  // 这一条**不能** freshSession —— 要的就是"上一次退出存下的会话"
  await gotoApp(page);
  await 挑开(page, A);

  // 带着"双击 B"进来（?file= 就是宿主队列里那份随进程带进来的路径）
  await page.goto("/?file=" + encodeURIComponent(B));
  await 等钩子(page);

  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
  // 红在这里：标签开了两个，亮着的却是会话里那个 A
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText(名B);
});

test("158-B 开第一个文件的过程中又来一个转交：两个都要出现，不许等下次双击", async ({ page }) => {
  await freshSession(page);
  await page.addInitScript(() => {
    // 第一次读盘慢 900ms，第二个路径在第 300ms 入队并广播 —— 此刻旧顺序下还没订阅
    (window as unknown as { __hpMockStartupTiming?: object }).__hpMockStartupTiming = {
      首次读慢毫秒: 900,
      稍后转交: { 路径: "/demo/项目 周报 v1.md", 延迟毫秒: 300 },
    };
  });
  await page.goto("/?file=" + encodeURIComponent(A));
  await 等钩子(page);

  // 红在这里：B 一直躺在队列里，界面只有 A 一个标签 —— 表现成"双击没反应"
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText(名B);
});

test("158-C 已经开着的文件再双击：切回它，不新建第二个标签（回归网）", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await 挑开(page, A);
  await 挑开(page, B);
  await page.getByTestId("tabbar").locator(".tab").filter({ hasText: 名A }).click();
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText(名A);

  // 资源管理器里再双击一次 B：标签数不许变，亮着的必须是 B
  await page.evaluate((p) => {
    (window as unknown as { __hpMockEmitStartupFile?: (a: string) => void }).__hpMockEmitStartupFile!(p);
  }, B);
  await expect(page.locator(".tab.is-active .tab__name")).toHaveText(名B);
  await expect(page.getByTestId("tabbar").locator(".tab")).toHaveCount(2);
});
