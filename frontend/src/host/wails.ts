import { Events, Window } from "@wailsio/runtime";
import { AppService, FileService, StateService } from "../../bindings/mdsb/internal/service";
import { toBase64 } from "./base64";
import type { FileStat, HostBase, MdEntry } from "./types";

/**
 * 桌面 wails 宿主：host 契约到 Go 服务的唯一映射处。
 *
 * 业务代码不允许出现 `@wailsio/runtime` 或直接调 bindings —— 只经这里。
 * bindings 由 `wails3 generate bindings -ts` 生成到 frontend/bindings/
 * （注意：不能带 -clean，该 flag 会透传给 `go list` 报错）。
 */

/** 「双击 .md / 第二实例转交」与「原生关闭请求」事件名，与 Go 侧 Emit 保持一致 */
const STARTUP_FILE_EVENT = "startup-file:ready";
const CLOSE_REQUEST_EVENT = "window:close-request";

/**
 * 窗口坐标是物理像素，鼠标事件是 CSS 像素。
 * 175% 缩放下不乘 devicePixelRatio 就会出现「拖一下窗口跑 1.75 倍」。
 */
function cssToPhysical(px: number): number {
  return Math.round(px * (window.devicePixelRatio || 1));
}

export function createWailsHost(): HostBase {
  const host: HostBase = {
    kind: "wails",

    capabilities: { revealInFolder: true, dragDropPaths: true },

    async info() {
      const platform = await StateService.Platform();
      const version = await StateService.AppVersion();
      return { kind: "wails", platform, version };
    },

    readFile: (path: string) => FileService.ReadFile(path),

    async writeFile(path: string, content: string) {
      await FileService.WriteFile(path, content);
    },

    // 116：桌面到 Go 走 JSON，`[]byte` 在 wails3 的 TS 绑定里被生成成 `string`（形状不确定），
    // 所以 Go 侧只暴露明确写「入参是 base64」的 WriteFileBase64，这里负责编码。
    async writeFileBytes(path: string, data: Uint8Array): Promise<boolean> {
      return FileService.WriteFileBase64(path, toBase64(data));
    },

    async stat(path: string): Promise<FileStat> {
      const info = await FileService.Stat(path);
      if (!info) throw new Error(`Stat 返回空: ${path}`);
      return {
        path: info.path,
        name: info.name,
        size: Number(info.size),
        // Go 侧给的是 Unix 秒，前端统一用毫秒
        mtime: Number(info.mtime) * 1000,
        isDir: info.isDir,
      };
    },

    async pickOpen() {
      const p = await FileService.PickOpenFile();
      return p ? p : null;
    },

    async pickSaveAs(defaultName: string) {
      const p = await FileService.PickSaveFile(defaultName);
      return p ? p : null;
    },

    async assetUrl(path: string) {
      return "/hp-file?path=" + encodeURIComponent(path);
    },

    getState: (key: string) => StateService.Get(key),

    async setState(key: string, value: string) {
      await StateService.Set(key, value);
    },

    // 安装器那一页选的语言。Go 侧读注册表，读不到给空串（= 没有安装期意见）。
    async installLanguage() {
      const v = await StateService.InstallLanguage();
      return v === "en" ? "en" : v === "zh" ? "zh" : "";
    },

    // 137：扫盘在 Go 侧做（前端拿不到文件系统），这里只转一次。
    // 返回的是 bindings 生成的类实例，字段与 MdEntry 一致，直接结构化兼容。
    listMarkdown: (dir: string, limit: number) => FileService.ListMarkdown(dir, limit) as Promise<MdEntry[]>,

    async windowMinimise() {
      Window.Minimise();
    },

    async windowToggleMaximise() {
      // beta.24 的 IsMaximised 返回 Promise，直接放进 if 恒真，必须 await
      if (await Window.IsMaximised()) Window.UnMaximise();
      else Window.Maximise();
    },

    async windowClose() {
      Window.Close();
    },

    async windowQuit() {
      // 先解除 Go 侧的关闭拦截，再退出，否则会被自己的确认逻辑挡回来
      await AppService.AllowQuit();
      await AppService.Quit();
    },

    async windowIsMaximised() {
      return Boolean(await Window.IsMaximised());
    },

    async windowDragMove(dx: number, dy: number) {
      const pos = await Window.Position();
      if (!pos) return;
      Window.SetPosition(pos.x + cssToPhysical(dx), pos.y + cssToPhysical(dy));
    },

    async writeClipboard(text: string) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // WebView2 在没有用户手势时可能拒绝 Clipboard API，退回一次性 textarea
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          ta.remove();
        }
      }
    },

    async revealInFolder(path: string) {
      await AppService.RevealInFolder(path);
    },

    async takeStartupFiles() {
      const list = await FileService.TakeStartupFiles();
      return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && !!p) : [];
    },

    onStartupSignal(handler) {
      const off = Events.On(STARTUP_FILE_EVENT, () => handler());
      return () => off?.();
    },

    onWindowCloseRequest(handler) {
      const off = Events.On(CLOSE_REQUEST_EVENT, () => handler());
      return () => off?.();
    },
  };

  return host;
}
