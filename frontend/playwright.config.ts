import { defineConfig, devices } from "@playwright/test";

/**
 * E2E 跑在浏览器 mock 宿主上：不起桌面窗口，因此 CI 与本机都能一条命令跑通。
 *
 * 浏览器用系统已装的 Edge（channel: "msedge"），避免 Playwright 再下载一份
 * Chromium —— 本机走镜像下载浏览器很慢，且 Edge 与 WebView2 同内核，
 * 渲染结果更贴近桌面壳。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // 8 worker 全开会互相抢 CPU，把带时间阈值的用例（性能基线、防抖落盘）挤成假失败
  workers: 4,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "msedge",
      use: { ...devices["Desktop Chrome"], channel: "msedge" },
    },
  ],
  webServer: {
    // 先构建再 preview：E2E 跑的永远是当前源码的产物，不会对着上一次的 dist 全绿
    command:
      "pnpm exec vite build --mode production && pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    // 必须 false：复用到别人占着的 4173 时会连 build 一起跳过，
    // 于是测的是上一版产物，表现为「改了代码仍失败」的假 flaky
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
