import type { FileStat, HostBase, HostInfo, MdEntry } from "./types";

/**
 * 浏览器 mock 宿主。
 *
 * 用途：`pnpm dev` 起纯前端空壳、Playwright 端到端测试、以及 CI 里
 * 不起桌面窗口就跑编辑器内核用例。所有能力都在页面内模拟，
 * 持久化走 localStorage（与桌面侧「按 key 存字符串」的语义一致）。
 */

const LS_PREFIX = "mdsb.mock.";

/** 与 Go 侧 `openableExts` 同一份清单（137 的 mock 必须同口径，否则端到端可测是假的） */
const MOCK_MD_EXT = /\.(md|markdown|mdown|mkd|mkdn)$/i;

const DEMO_PATH = "/demo/欢迎.md";

/**
 * mock 里「真实存在的图片」。约定只有名单内的路径返回可显示的 data URL，
 * 其余给一个必然 404 的地址 —— 否则坏图永远不触发 error，
 * 021 的失效占位分支就没法测。
 */
const MOCK_IMAGES = new Set<string>([
  "/demo/diagrams/arch.png",
  "/demo/共享/时间 线.svg",
  "/共享/时间 线.svg",
  "/demo/pic/架构图.png",
]);

/** 渲染增强自检文档：相对/绝对/网络图片 + 正确与错误的 Mermaid 各一张 */
const RENDER_CHECK_PATH = "/demo/渲染自检.md";

/** 覆盖验收三点：中文文件名、含空格路径、非 ASCII 目录 */
export const MOCK_SAMPLES: string[] = [  DEMO_PATH,
  "/demo/项目 周报 v1.md",
  "/中文目录/审批时效 样本.md",
  RENDER_CHECK_PATH,
];

const RENDER_CHECK_MARKDOWN = `# 渲染自检

相对路径图片（应按文档目录解析后交给宿主）：

![架构图](./diagrams/arch.png)

含中文与空格的相对路径（CommonMark 里目标含空格必须用 \`<>\` 包住或写成 %20）：

![时间 线](<../共享/时间 线.svg>)

网络图片（应原样保留，不经过宿主）：

![网络图](https://example.com/img/chart.png)

语法正确的图：

\`\`\`mermaid
flowchart LR
    A[开始] --> B[结束]
\`\`\`

语法错误的图（应显示错误块 + 原始源码，不白屏）：

\`\`\`mermaid
flowchart TD
  A -->
  ] 坏掉的图
\`\`\`
`;

const DEMO_MARKDOWN = `# 欢迎使用 MDStar

这是 **浏览器 mock 宿主** 下的示例文档，用于验证前端空壳与后续编辑器内核。

## 代码块

\`\`\`ts
const greet = (name: string) => \`hello, \${name}\`;
\`\`\`

## 表格

| 模式 | 快捷键 | 说明 |
| --- | --- | --- |
| 阅读 | Ctrl+1 | 只读渲染 |
| 所见即所得 | Ctrl+2 | 直接改内容 |
| 源码 | Ctrl+3 | 看 Markdown 原文 |

## 待办

- [x] 工程骨架
- [ ] 三模式编辑
`;

/**
 * 滚动恢复测试要用的长文档。
 *
 * 必须在 makeMockFs 里生成而不是由测试 seed：mock 文件表随页面加载重建，
 * seed 进去的文件在 `page.reload()` 后就没了，测出来的「恢复失败」是测试设计问题。
 */
const LONG_DOC_PATH = "/demo/长文档.md";

function longDocMarkdown(): string {
  const sections = Array.from({ length: 60 }, (_, i) => `## 小节 ${i}\n\n第 ${i} 段正文，够长才能滚出屏幕。\n`);
  return "# 长文档\n\n" + sections.join("\n") + "\n![尾部图](./diagrams/arch.png)\n";
}

function makeMockFs(): Map<string, string> {  const fs = new Map<string, string>();
  fs.set(DEMO_PATH, DEMO_MARKDOWN);
  fs.set(
    "/demo/项目 周报 v1.md",
    `# 项目 周报 v1\n\n路径含空格的样本，用于验证「中文文件名 + 空格」这条链路。\n\n| 周次 | 进展 | 风险 |\n| --- | --- | --- |\n| W41 | 骨架完成 | 无 |\n| W42 | 阅读模式 | 序列化保真 |\n`,
  );
  fs.set(
    "/中文目录/审批时效 样本.md",
    `# 审批时效样本（非 ASCII 目录）\n\n这份文档放在中文目录名里，路径同时含非 ASCII 与空格。\n\n## 结论\n\n- 能读到这份文档，说明 Go 侧 argv -> ReadFile -> host -> 渲染 的编码链路没有断点\n`,
  );
  fs.set(RENDER_CHECK_PATH, RENDER_CHECK_MARKDOWN);
  fs.set(
    "/demo/无标题.md",
    "这份文档一个标题都没有，用来验证大纲的空态。\n\n第二段。\n",
  );
  fs.set(ENHANCE_PATH, ENHANCE_MARKDOWN);
  fs.set(FN_PATH, FN_MARKDOWN);
  fs.set(LONG_DOC_PATH, longDocMarkdown());
  return fs;
}

/** 020/021/022/023 的增强自检文档 */
const ENHANCE_PATH = "/demo/增强自检.md";

/**
 * 136-A 脚注自检文档。
 *
 * 中间塞了 40 段占位文字：**没有这段高度，"点引用跳过去"根本量不出来**
 * （scrollTop 一直是 0，断言会假绿）。
 */
const FN_PATH = "/demo/脚注自检.md";
const FN_FILLER = Array.from(
  { length: 40 },
  (_, i) => `占位段落 ${i + 1}：把正文撑高，让跳转有距离可量。`
).join("\n\n");
const FN_MARKDOWN = `# 脚注自检

第一句带引用[^one]，第二句带引用[^two]。

${FN_FILLER}

第三段又引用了一次 [^one]，用来验「一条定义被多处引用」时文末有几个回跳箭头。

[^one]: 第一个脚注的内容，含**粗体**。
[^two]: 第二个脚注，含 \`代码\` 与多行内容。
  第二行缩进两格，属于同一个定义。
`;

const LONG_CODE = Array.from({ length: 26 }, (_, i) => `console.log("line ${i + 1}");`).join("\n");

const ENHANCE_MARKDOWN = `# 增强自检

[TOC]

## 目录之上还有一句话

正文一句话，用来确认 TOC 替换后没吃掉别的段落。

## 代码块

\`\`\`ts
${LONG_CODE}
\`\`\`

## 图片

![正常图](./diagrams/arch.png)

![坏图](./diagrams/不存在.png)

## 统计口径

汉字若干个，English words 也算。

\`\`\`text
代码块里的字不该被计入字数统计
\`\`\`
`;

/** 模块级文件表，见 createBrowserMockHost 内的注释 */
const mockFs = makeMockFs();

/**
 * 116：mock 宿主的「二进制文件表」。
 *
 * 单独一张表而不是往 `files` 里塞字符串：图片的字节是判据的一部分
 * （哈希去重要按字节比），拼成字符串就没法断言「磁盘上到底只有一个文件、内容是谁」。
 */
const mockBinFs = new Map<string, Uint8Array>();

export function createBrowserMockHost(): HostBase {
  // 模块级单例：测试钩子（__hpMockSeedFile / __hpMockHas）与 store 绑定的那个
  // 宿主实例必须看到同一份文件表。放在工厂函数里会变成「每次新建一份」，
  // 于是种子写进 B 实例、readFile 读 A 实例，测试表现为「文件不存在」。
  const files = mockFs;
  const listeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const startupQueue: string[] = [];
  const now = Date.now();

  // 供测试读取的伪窗口/剪贴板状态
  let mockMaximised = false;
  let dragCalls = 0;
  let clipboard = "";
  (window as unknown as { __hpMockState?: () => object }).__hpMockState = () => ({
    maximised: mockMaximised,
    dragCalls,
    clipboard,
  });

  const requireFile = (path: string): string => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`mock 宿主中不存在该文件: ${path}`);
    return content;
  };

  const host: HostBase = {
    kind: "mock",

    // 浏览器里没有资源管理器、也没有原生窗口，菜单项据此置灰
    capabilities: { revealInFolder: false, dragDropPaths: false },

    async info(): Promise<HostInfo> {
      return { kind: "mock", platform: "browser", version: "0.1.0-mock" };
    },

    async readFile(path: string) {
      return requireFile(path);
    },

    async writeFile(path: string, content: string) {
      // 测试钩子：把写盘伪造成失败（文件被占用 / 只读），用来验「写失败后的提示与关闭」
      const fail = (window as unknown as { __hpMockFailWrites?: string }).__hpMockFailWrites;
      if (fail) throw new Error(fail);
      files.set(path, content);
    },

    async writeFileBytes(path: string, data: Uint8Array): Promise<boolean> {
      // 与 Go 侧同一口径：已存在就**不覆盖**，返回 false 让调用方换序号
      if (files.has(path) || mockBinFs.has(path)) return false;
      mockBinFs.set(path, data);
      return true;
    },

    async stat(path: string): Promise<FileStat> {
      // 116：二进制图片与文本文件都要能被 stat 到 —— 去重与序号都要问「这个路径存在吗」
      const binary = mockBinFs.get(path);
      if (binary) {
        return { path, name: path.split("/").pop() ?? path, size: binary.byteLength, mtime: now, isDir: false };
      }
      const content = requireFile(path);
      return {
        path,
        name: path.split("/").pop() ?? path,
        size: content.length,
        mtime: now,
        isDir: false,
      };
    },

    async pickOpen() {
      // 测试可注入候选路径；默认返回内置示例文档
      const injected = (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath;
      if (injected) {
        (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = undefined;
        return injected;
      }
      return DEMO_PATH;
    },

    async pickSaveAs(defaultName: string) {
      const injected = (window as unknown as { __hpMockSavePath?: string }).__hpMockSavePath;
      if (injected) {
        (window as unknown as { __hpMockSavePath?: string }).__hpMockSavePath = undefined;
        return injected;
      }
      return `/demo/${defaultName}`;
    },

    async assetUrl(path: string) {
      // mock 里没有文件系统。约定：只有名单内的「假图片」返回可显示的 data URL，
      // 其它一律给一个必然 404 的相对地址 —— 这样 021 的失效占位分支才测得到。
      // （直接给所有路径都返回 data URL 的话，坏图永远不触发 error，占位测试会假绿。）
      // 116：粘贴落盘的图片**真的在 mock 的二进制表里**，那些必须能显示 ——
      // 否则「粘进来的图」和「文档里本来就坏了的图」在测试里长得一模一样，分不开。
      // 这里仍然画那张带文件名的 SVG，而不是把字节原样吐回 data URL：
      // mock 不是图片解码器，用例里的字节是 `[137,80,78,71,...]` 这种假头，
      // 真当 PNG 解码必然失败 → 走 021 的失效占位 → 「渲染成功」这条就永远测不到。
      // 「字节到底对不对」另有 `__hpMockReadBinary` 直接断言，不靠渲染证明。
      if (mockBinFs.has(path)) {
        const pastedName = (path.split(/[\\/]/).pop() ?? path).slice(0, 28);
        return (
          "data:image/svg+xml;charset=utf-8," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">` +
              `<rect width="240" height="120" fill="#cfe6d8"/>` +
              `<text x="12" y="66" font-family="sans-serif" font-size="14" fill="#274a7a">${pastedName}</text></svg>`
          )
        );
      }
      if (!MOCK_IMAGES.has(path)) return "/__missing_asset__.png";
      const name = (path.split(/[\\/]/).pop() ?? path).slice(0, 28);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">` +
        `<rect width="240" height="120" fill="#f5e7c9"/>` +
        `<text x="12" y="66" font-family="sans-serif" font-size="14" fill="#274a7a">${name}</text></svg>`;
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    },

    async getState(key: string) {
      try {
        return localStorage.getItem(LS_PREFIX + key) ?? "";
      } catch {
        return "";
      }
    },

    async setState(key: string, value: string) {
      try {
        if (value === "") localStorage.removeItem(LS_PREFIX + key);
        else localStorage.setItem(LS_PREFIX + key, value);
      } catch {
        /* 隐私模式下 localStorage 不可写，忽略 */
      }
    },

    // 浏览器宿主没有注册表：默认空串（= 没有安装期意见）。
    // E2E 要验"装的时候选了英文"这条链路时，先把 mdsb.mock.installLang 播成 "en"。
    async installLanguage() {
      try {
        const v = localStorage.getItem(LS_PREFIX + "installLang") ?? "";
        return v === "en" || v === "zh" ? v : "";
      } catch {
        return "";
      }
    },

    /**
     * 137：mock 版递归列目录。
     *
     * 必须和 Go 侧 `ListMarkdown` 同口径（跳过隐藏 / `_` 开头 / node_modules、
     * 只认那五种扩展名、有硬上限），否则"端到端可测"是假的：
     * 浏览器里能搜到的文档，到桌面上搜不到。
     */
    async listMarkdown(dir: string, limit: number): Promise<MdEntry[]> {
      const root = (dir || "").replace(/\/+$/, "");
      const cap = limit > 0 ? Math.min(limit, 400) : 400;
      const out: MdEntry[] = [];
      if (!root) return out;
      for (const p of [...files.keys()].sort()) {
        if (!p.startsWith(root + "/")) continue;
        const rel = p.slice(root.length + 1);
        const segs = rel.split("/");
        if (segs.some((s) => s.startsWith(".") || s.startsWith("_") || s.toLowerCase() === "node_modules")) continue;
        // 与 Go 侧 mdScanMaxDepth 对齐（rel 的段数 = 目录层数 + 文件名）
        if (segs.length > 9) continue;
        if (!MOCK_MD_EXT.test(p)) continue;
        out.push({ path: p, name: segs[segs.length - 1], rel });
        if (out.length >= cap) break;
      }
      return out;
    },

    async windowMinimise() {
      console.info("[mock host] window.minimise");
    },

    async windowToggleMaximise() {
      mockMaximised = !mockMaximised;
    },

    async windowClose() {
      closeListeners.forEach((fn) => fn());
    },

    async windowQuit() {
      console.info("[mock host] window.quit");
    },

    async windowIsMaximised() {
      return mockMaximised;
    },

    async windowDragMove() {
      // 浏览器里没有可移动的窗口；计数留给 015 的接口连通性断言，
      // 真正的「跟手不漂移」只能在桌面端手工验收
      dragCalls++;
    },

    onWindowCloseRequest(handler) {
      closeListeners.add(handler);
      return () => closeListeners.delete(handler);
    },

    async writeClipboard(text: string) {
      clipboard = text;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 无手势/无权限时忽略，断言走 mockClipboard() */
      }
    },

    async revealInFolder() {
      console.info("[mock host] revealInFolder 不可用");
    },

    async takeStartupFiles() {
      const out = [...startupQueue];
      startupQueue.length = 0;
      return out;
    },

    onStartupSignal(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };

  /** 入队并广播信号，与桌面侧「先入队、前端来取」的时序一致 */
  function pushStartup(path: string) {
    if (!files.has(path)) return false;
    startupQueue.push(path);
    listeners.forEach((fn) => fn());
    return true;
  }

  // 测试/调试钩子：window.__hpMockEmitStartupFile('/demo/欢迎.md')
  (window as unknown as { __hpMockEmitStartupFile?: (p: string) => void }).__hpMockEmitStartupFile =
    pushStartup;

  /**
   * 性能测试用：在页面内现造一份大文档塞进 mock 文件系统。
   * 不把 46KB 样本打进产物里，也不依赖真实磁盘。
   */
  (window as unknown as { __hpMockSeedFile?: (p: string, c: string) => void }).__hpMockSeedFile = (
    p: string,
    c: string
  ) => {
    files.set(p, c);
  };

  /** 测试自检用：某个路径此刻是否真的在 mock 文件系统里 */
  (window as unknown as { __hpMockHas?: (p: string) => boolean }).__hpMockHas = (p: string) => files.has(p);

  /**
   * 测试用：读回 mock 文件系统里的**已落盘内容**。
   * 104/105 要断言「保存后磁盘上只有那一段变了」，
   * 只看界面上的工作副本证明不了写盘链路，必须读回文件本体。
   */
  (window as unknown as { __hpMockReadFile?: (p: string) => string | null }).__hpMockReadFile = (p: string) =>
    files.get(p) ?? null;

  /**
   * 116：断言「磁盘上到底有几个文件、字节是谁的」。
   * 文本表与二进制表合并列出 —— 「同一张图粘两次只留一个文件」这条
   * 必须数得出 assets/ 下只有一个名字，只看正文有两处引用是不充分的。
   */
  (window as unknown as { __hpMockListFiles?: (prefix?: string) => string[] }).__hpMockListFiles = (
    prefix = ""
  ) => [...new Set([...files.keys(), ...mockBinFs.keys()])].filter((p) => p.startsWith(prefix)).sort();

  (window as unknown as { __hpMockReadBinary?: (p: string) => number[] | null }).__hpMockReadBinary = (
    p: string
  ) => (mockBinFs.has(p) ? Array.from(mockBinFs.get(p)!) : null);

  /** 预置一张已存在的图片（测序号避让与「用户删了图之后重落一份」） */
  (window as unknown as { __hpMockSeedBinary?: (p: string, b: number[]) => void }).__hpMockSeedBinary = (
    p: string,
    b: number[]
  ) => {
    mockBinFs.set(p, new Uint8Array(b));
  };

  /**
   * 测试用注入契约（114 定，115/116 共用）：构造一个真的 `ClipboardEvent` 派发到当前编辑器。
   *
   * 为什么必须有它：Playwright 与浏览器 mock 都**读不到系统剪贴板**（更读不到图片字节），
   * 所以「按一次真实 Ctrl+V」不是自动化验收，是桌面手工项。
   * 生产代码只从 `event.clipboardData` 取数据（不碰 `navigator.clipboard`），
   * 于是注入路径与真实路径是**同一条**，这条钩子才有证明力。
   *
   * `files` 给 116（剪贴板图片落盘）用；114 只消费 html / text 两项。
   */
  (window as unknown as {
    __hpMockPaste?: (p: { html?: string; text?: string; files?: { name: string; bytes: number[]; mime?: string }[] }) => void;
  }).__hpMockPaste = (payload) => {
    const target = document.querySelector<HTMLElement>(".ProseMirror") ?? document.body;
    const dt = new DataTransfer();
    if (payload.text) dt.setData("text/plain", payload.text);
    if (payload.html) dt.setData("text/html", payload.html);
    for (const f of payload.files ?? []) {
      dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.mime ?? "image/png" }));
    }
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  };

  // 浏览器里拖文件进来只能拿到文件名（拿不到绝对路径），
  // 按名字映射到 mock 文件系统里的同名样本，保持与桌面同样的「拖入即打开」体验
  window.addEventListener("drop", (e: DragEvent) => {
    const dropped = e.dataTransfer?.files;
    if (!dropped?.length) return;
    for (const f of Array.from(dropped)) {
      if (!/\.md|\.markdown$/i.test(f.name)) continue;
      const hit = [...files.keys()].find((p) => p.endsWith("/" + f.name));
      if (hit) pushStartup(hit);
    }
  });

  // ?file=/demo/欢迎.md 模拟「双击文件启动」
  const param = new URLSearchParams(window.location.search).get("file");
  if (param && files.has(param)) startupQueue.push(param);

  return host;
}
