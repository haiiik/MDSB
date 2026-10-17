import type { Host } from "./types";
import { withDerivedCapabilities } from "./derived";

/**
 * 宿主选择。
 *
 * 判据不能用 `window._wails`：那是 `@wailsio/runtime` 自己在 import 时创建的
 * 对象（dist/index.js 第 13 行 `window._wails = window._wails || {}`），
 * 而 wails.ts 是动态导入的，检测时机上它还不存在，浏览器里同样不存在，
 * 结果两边都判成 mock。真正的信号是「原生消息通道」是否存在：
 *   - Windows：WebView2 注入 `window.chrome.webview`（普通浏览器里没有）
 *   - macOS / Linux(WebKitGTK)：`window.webkit.messageHandlers.external`
 * 运行时已加载时（`_wails.invoke` 被平台层注入）也算桌面。
 *
 * 另留 `?host=mock|wails` 查询参数覆盖，便于在桌面窗口里验证 mock 分支。
 */
export function isWailsRuntime(): boolean {
  const w = window as unknown as {
    _wails?: { invoke?: unknown };
    chrome?: { webview?: unknown };
    webkit?: { messageHandlers?: Record<string, unknown> };
  };
  const forced = new URLSearchParams(window.location.search).get("host");
  if (forced === "mock") return false;
  if (forced === "wails") return true;
  if (w._wails?.invoke) return true;
  if (w.chrome?.webview) return true;
  if (w.webkit?.messageHandlers?.external) return true;
  return false;
}

let pending: Promise<Host> | null = null;

/** 取得当前宿主实例（幂等，多次调用共享同一实例）。 */
export function getHost(): Promise<Host> {
  if (pending) return pending;
  pending = (async () => {
    if (isWailsRuntime()) {
      const { createWailsHost } = await import("./wails");
      return withDerivedCapabilities(createWailsHost());
    }
    const { createBrowserMockHost } = await import("./browser-mock");
    return withDerivedCapabilities(createBrowserMockHost());
  })();
  return pending;
}

export type { Host, HostInfo, FileStat, SessionSnapshot } from "./types";
