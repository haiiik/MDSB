/**
 * host 适配层契约。
 *
 * 业务代码只 `import { host } from '@/host'`，永不直接引用 `@wailsio/runtime`
 * 或生成的 bindings —— 这是 M1 全部自动化测试能跑在纯浏览器里的前提。
 */

export type HostKind = "wails" | "mock";

export interface HostInfo {
  /** 宿主实现：桌面 wails 还是浏览器 mock */
  kind: HostKind;
  /** 操作系统标识：windows / darwin / linux / browser */
  platform: string;
  /** 版本号，用于关于框与诊断 */
  version: string;
}

export interface FileStat {
  path: string;
  name: string;
  /** 字节数 */
  size: number;
  /** 修改时间，Unix 毫秒 */
  mtime: number;
  isDir: boolean;
}

/** 最近文件条目（011）。置顶项排在最前，其余按最后打开时间倒序 */
export interface RecentEntry {
  path: string;
  /** 最后打开时刻，Unix 毫秒 */
  at: number;
  pinned: boolean;
}

/** 会话里每个标签要还原的东西 */
export interface SessionEntry {
  path: string;
  mode: "read" | "source" | "edit";
  /** 每模式各自的滚动位置 */
  scroll: Record<"read" | "source" | "edit", number>;
  cursor: number;
  zoom: number;
  width: "narrow" | "normal" | "wide" | "full";
}

/** 会话快照：重启后恢复打开的标签与位置 */
export interface SessionSnapshot {
  /** 按界面顺序 */
  entries: SessionEntry[];
  /** 活动标签的路径 */
  active: string | null;
  /** 窗口几何，用于恢复到上次大小位置 */
  window?: { x: number; y: number; width: number; height: number; maximised: boolean };
}

/**
 * 宿主原语。两种宿主实现（wails / browser-mock）只需提供这一层，
 * 快照、最近列表、会话等派生能力由 `host/derived.ts` 统一实现。
 */
export interface HostBase {
  kind: HostKind;

  /**
   * 能力开关。UI 用它决定菜单项是否置灰，而不是 try/catch 里猜。
   * 浏览器 mock 没有「在资源管理器中显示」这类概念，置灰即可。
   */
  capabilities: {
    revealInFolder: boolean;
    /** 原生窗口拖入文件（mock 下由 <input type=file> 代替） */
    dragDropPaths: boolean;
  };

  info(): Promise<HostInfo>;

  // ---- 文件 ----
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * 原子写二进制（116：剪贴板图片落盘）。
   *
   * 返回 `false` = 目标已存在，**没有覆盖**，也没报错。
   * 这条是验收里「不留半截文件、不顶掉用户原有文件」的底座：
   * 去重命中、以及同一秒序号撞名，都必须走「不写」这一支。
   */
  writeFileBytes(path: string, data: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  /** 原生打开对话框；用户取消返回 null */
  pickOpen(): Promise<string | null>;
  /** 原生另存为对话框；用户取消返回 null */
  pickSaveAs(defaultName: string): Promise<string | null>;

  /**
   * 把本地绝对路径转成 `<img src>` 能用的 URL。
   * 桌面走 Go 侧 `/hp-file` 路由（页面 origin 不是文件系统，相对路径解析不到磁盘）；
   * mock 返回一张写着你文件名的 data URL，保证测试可断言且不需要真图片。
   */
  assetUrl(path: string): Promise<string>;

  // ---- 键值状态袋（持久化底座） ----
  getState(key: string): Promise<string>;
  setState(key: string, value: string): Promise<void>;

  /**
   * 安装器那一页选下的界面语言（"zh" / "en"），没装过 / 读不到 / 非桌面 = 空串。
   * 只在「settings.v1 里还没存过 lang」时用作首启初值，用户改过一次就以存值为准。
   */
  installLanguage(): Promise<string>;

  // ---- 窗口 ----
  windowMinimise(): Promise<void>;
  windowToggleMaximise(): Promise<void>;
  windowClose(): Promise<void>;
  /** 跳过「未保存确认」直接退出（确认对话框选「放弃并退出」后调用） */
  windowQuit(): Promise<void>;
  /** 当前是否最大化（015 的按钮图标要用） */
  windowIsMaximised(): Promise<boolean>;
  /** 拖动窗口：增量以 CSS 像素给出，宿主侧换算物理像素 */
  windowDragMove(deltaX: number, deltaY: number): Promise<void>;
  /** 订阅「用户请求关闭窗口」（原生 X / Alt+F4）；返回退订函数 */
  onWindowCloseRequest(handler: () => void): () => void;

  // ---- 系统集成 ----
  writeClipboard(text: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;

  /**
   * 取走并清空「外部送进来的文件路径」队列。
   * 三条来源共用：命令行参数（双击 / 打开方式）、拖放进窗口的文件、第二实例转交。
   */
  takeStartupFiles(): Promise<string[]>;

  /**
   * 订阅「队列里有新东西」的信号。
   * 信号不带路径 —— 事件可能早于前端监听注册就发出，
   * 路径必须留在宿主队列里等前端首帧之后主动取。
   * 返回退订函数。
   */
  onStartupSignal(handler: () => void): () => void;
}

/** 完整宿主：原语 + 派生能力 */
export interface Host extends HostBase {
  // ---- 崩溃快照 ----
  writeSnapshot(path: string, content: string): Promise<void>;
  listSnapshots(): Promise<string[]>;
  readSnapshot(path: string): Promise<string | null>;
  clearSnapshot(path: string): Promise<void>;

  // ---- 最近文件 ----
  listRecent(): Promise<RecentEntry[]>;
  pushRecent(path: string): Promise<void>;
  removeRecent(path: string): Promise<void>;
  setPinned(path: string, pinned: boolean): Promise<void>;
  clearRecent(): Promise<void>;

  // ---- 会话 ----
  loadSession(): Promise<SessionSnapshot | null>;
  saveSession(session: SessionSnapshot): Promise<void>;
}
