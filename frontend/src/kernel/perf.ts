/**
 * 性能埋点（024）。
 *
 * 只测能被自动化稳定复现的部分：导航到首帧可交互、打开大文档到渲染完成、
 * 源码模式连续输入的单次提交耗时、标签切换耗时。
 * 冷启动里「进程创建 → WebView2 就绪」那一段在浏览器里量不到，
 * 由 `devtools\hp-perf.ps1` 在桌面端单独量并记进 README。
 */

const marks: Record<string, number> = {};

export function mark(name: string): void {
  marks[name] = performance.now();
}

export function measure(from: string, to: string): number {
  const a = marks[from];
  const b = marks[to];
  if (a === undefined || b === undefined) return -1;
  return b - a;
}

/** 首帧可交互：App 挂载完成 + 空态渲染出来 */
export function installReadyProbe(): void {
  mark("module-eval");
  addEventListener("DOMContentLoaded", () => mark("domcontentloaded"), { once: true });
}

export function signalReady(): void {
  mark("app-mounted");
  (window as unknown as { __hpReady?: number }).__hpReady = performance.now();
}

export interface PerfSummary {
  /** 导航开始 → App 挂载完成 */
  bootMs: number;
  /** 打开文档 → 阅读渲染完成 */
  renderMs: number;
  /** 源码模式连续输入的单次提交平均耗时 */
  inputMs: number;
  /** 标签切换平均耗时 */
  tabSwitchMs: number;
  /** 104 回写口径的开销：一次 PM 事务里「块等价比较 + patch」平均耗时（直接决定输入手感） */
  editCommitMs: number;
  /** 121：mdast → PM 文档的转换耗时（最近一次进编辑模式） */
  editParseMs: number;
  /** 121：EditorView 挂载耗时（最近一次进编辑模式，含 NodeView 建视图与首帧排版） */
  editMountMs: number;
  /** 121：转换 + 挂载 = 「点进编辑模式到能打字」的总账 */
  editReadyMs: number;
}

/**
 * 采样上限。编辑模式的回写开销跑在**每次按键后的事务**上，
 * 无上限累积会让长会话把样本数组越撑越大（独立验证 2026-10-14 指出），
 * 只保留最近 N 条足以算出稳态均值。
 */
const MAX_SAMPLES = 200;

export function noteEditCommit(ms: number): void {
  const xs = perf.editCommitSamples;
  xs.push(ms);
  if (xs.length > MAX_SAMPLES) xs.splice(0, xs.length - MAX_SAMPLES);
}

/**
 * 121：进编辑模式的**两段**开销要分开记。
 *
 * 只给一个「挂载耗时」没法回答这颗要回答的问题 ——
 * 「大文档要不要分块懒挂载」取决于钱花在解析（mdast→PM，纯计算，懒挂载救不了打字时的重解析）
 * 还是花在建视图/DOM（可以切片）。所以这里存两个数，结论按占比下。
 */
export function noteEditMount(parseMs: number, mountMs: number): void {
  perf.editParseMs = parseMs;
  perf.editMountMs = mountMs;
}

export const perf = {
  renderStart: 0,
  renderMs: 0,
  inputSamples: [] as number[],
  tabSwitchSamples: [] as number[],
  /** 104：回写开销。它跑在每次按键后的事务上，直接决定编辑手感，121 要读这个数 */
  editCommitSamples: [] as number[],
  editParseMs: 0,
  editMountMs: 0,
  summary(): PerfSummary {
    return {
      bootMs: measure("navigationStart", "app-mounted"),
      renderMs: this.renderMs,
      inputMs: avg(this.inputSamples),
      tabSwitchMs: avg(this.tabSwitchSamples),
      editCommitMs: avg(this.editCommitSamples),
      editParseMs: this.editParseMs,
      editMountMs: this.editMountMs,
      editReadyMs: this.editParseMs + this.editMountMs,
    };
  },
};

// navigationStart 用 PerformanceNavigationTiming 的起点，比 0 更接近用户体感
mark("navigationStart");

function avg(xs: number[]): number {
  if (!xs.length) return -1;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
