import { computed, reactive, ref } from "vue";
import type { WidthPreset } from "../kernel/render";
import { clampZoom } from "../kernel/render";
import type { Host } from "../host/types";
import { dropTab } from "./modeInstances";

// 组件要按同一套上下限做 +/- 步进，统一从这里出，避免两处各写一份
export { clampZoom };

/**
 * 标签与文档状态。
 *
 * 一文件一标签（D1）。每个标签自带内容、脏基准、模式、滚动与视图档，
 * 全局只有「主题」是共享的 —— 018/019 的每标签缩放与宽度档因此有地方存。
 */

export type Mode = "read" | "source" | "edit";

export interface Tab {
  id: string;
  /** 绝对路径（正斜杠）；未保存的新建文档为 null */
  path: string | null;
  name: string;
  /** 工作副本：当前编辑内容 */
  markdown: string;
  /** 脏判定基准：最后一次落盘的内容。绝不用「操作计数」判脏 */
  saved: string;
  mode: Mode;
  zoom: number;
  width: WidthPreset;
  /** 每模式各自记忆滚动与光标，切回来不丢位置 */
  scroll: Record<Mode, number>;
  cursor: number;
}

interface TabsState {
  list: Tab[];
  activeId: string | null;
}

export const tabs = reactive<TabsState>({ list: [], activeId: null });

export const activeTab = computed<Tab | null>(
  () => tabs.list.find((t) => t.id === tabs.activeId) ?? null
);

export const activePath = computed(() => activeTab.value?.path ?? null);
export const activeName = computed(() => activeTab.value?.name ?? null);
export const activeMarkdown = computed(() => activeTab.value?.markdown ?? "");

/** 脏 = 工作副本与落盘基准逐字节不等。改回原样即自动不脏 */
export function isDirty(tab: Tab): boolean {
  return tab.markdown !== tab.saved;
}
export const anyDirty = computed(() => tabs.list.some(isDirty));

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

let host: Host | null = null;
let seq = 0;

/** 由 App 在拿到宿主后注入；store 不自己 getHost，保持可测 */
export function bindHost(h: Host) {
  host = h;
}

export function hasHost(): boolean {
  return host !== null;
}

function newTab(path: string | null, markdown: string, name: string): Tab {
  return {
    id: "t" + ++seq,
    path,
    name,
    markdown,
    saved: markdown,
    mode: "read",
    zoom: 1,
    width: "normal",
    scroll: { read: 0, source: 0, edit: 0 },
    cursor: 0,
  };
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function samePath(a: string, b: string): boolean {
  // Windows 路径大小写不敏感
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

export function activate(id: string) {
  if (tabs.list.some((t) => t.id === id)) tabs.activeId = id;
}

export function activeIndex(): number {
  return tabs.list.findIndex((t) => t.id === tabs.activeId);
}

/**
 * 打开指定路径。同一文件已开则聚焦已有标签，不新建（010 验收）。
 * 返回是否成功打开。
 */
export async function openPath(path: string): Promise<boolean> {
  if (!host) return false;
  const existing = tabs.list.find((t) => t.path && samePath(t.path, path));
  if (existing) {
    activate(existing.id);
    return true;
  }
  try {
    const md = await host.readFile(path);
    const tab = newTab(normalize(path), md, baseName(path));
    tabs.list.push(tab);
    tabs.activeId = tab.id;
    globalError.value = "";
    void host.pushRecent(path).catch(() => undefined);
    return true;
  } catch (e) {
    // 打开失败时还没有标签可挂错误，所以记一条全局的（空态也会显示）
    globalError.value = tf("open.cannotOpenDetail", { name: baseName(path), error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * 没有对应标签时的错误（典型场景：打开失败，此时一个标签都没有）
 */
export const globalError = ref("");

/** 打开失败时记一条可读错误，按标签隔离 */
export const tabError = reactive(new Map<string, string>());

/**
 * 127：新增标签（未命名空文档）。
 *
 * 原始诉求：「标签栏的打开文件按钮调整为新增标签……内容为空，可输入」。
 * 三条口径在这里定死，后面的用例都按它们判：
 * - **没有路径**（`path === null`）：它不是「某个还没写过的文件」，就是一份内存里的稿子。
 *   所以不进最近列表、不能被自动保存、崩了没有快照（见工单的待决清单）；
 * - **直接进编辑档**：空文档在阅读档里就是一张白页，用户看不出自己新建成功了；
 * - **名字是「未命名」**，不带 `.md` 后缀 —— 后缀是另存为时才出现的事，
 *   `saveTabAs` 给的默认建议名才是「未命名.md」。
 */
export const UNTITLED_NAME = "未命名";

export function createUntitled(): Tab {
  /*
   * 已经有一份**没动过的**未命名标签就复用它，不再生第二张：
   * 连点三下 + 得到三个空标签，用户得挨个关，那是给自己找事。
   * 判据用 `markdown === ""`（不是「没脏」）—— 写过字的那张是用户的稿子，不能被他下一次点 + 清掉。
   */
  const idle = tabs.list.find((t) => !t.path && t.markdown === "");
  if (idle) {
    idle.mode = "edit";
    activate(idle.id);
    return idle;
  }
  const tab = newTab(null, "", UNTITLED_NAME);
  tab.mode = "edit";
  tabs.list.push(tab);
  tabs.activeId = tab.id;
  globalError.value = "";
  return tab;
}

/** 这份标签是不是「还没落过盘的未命名稿子」 */
export function isUntitled(tab: Tab): boolean {
  return tab.path === null;
}

/** 弹打开对话框并打开所选文件；取消返回 false */
export async function openWithDialog(): Promise<boolean> {
  if (!host) return false;
  const picked = await host.pickOpen();
  if (!picked) return false;
  return openPath(picked);
}

/**
 * 内容生命周期的挂载点。
 *
 * 自动保存与崩溃快照要响应「改了内容」「存好了」两件事，但它们又反过来要用
 * saveTab —— 直接互相 import 会成环。所以这里只留两个空钩子，
 * 由 `state/persistence.ts` 在启动时接线。
 */
export const hooks: {
  afterEdit: (tab: Tab) => void;
  afterSave: (tab: Tab) => void;
  afterClose: (tab: Tab) => void;
} = {
  afterEdit: () => undefined,
  afterSave: () => undefined,
  afterClose: () => undefined,
};

export function updateMarkdown(text: string) {
  setTabMarkdown(tabs.activeId, text);
}

/**
 * 按**标签 id** 写工作副本（127 加的口子）。
 *
 * 为什么不让组件继续 `emit` 给父级再写：`<script setup>` 里所有「看起来像模块级」的变量
 * 其实都在编译出来的 `setup()` 函数体内，**是每个实例一份**。
 * CodeMirror 的 `updateListener` 是建 state 那一刻绑的闭包，而 state 会被 stash 跨挂载复用（119 的撤销栈就靠它），
 * 于是「切走再切回源码档」之后触发的是**上一个已卸载实例**的闭包 —— 它手里的 `emit` 属于那个实例，
 * 调用等于打进空气：屏幕上字在、工作副本没跟上，于是脏点不亮、Ctrl+S 存旧内容、关标签不提示直接丢。
 * 走 store 就没这个绕法：监听只要拿到 `tabId` + 新文本就能把事办对，
 * 而且按 id 写天然不会把 A 标签的内容写进 B。
 */
export function setTabMarkdown(tabId: string | null, text: string): void {
  const t = tabId ? tabs.list.find((x) => x.id === tabId) : null;
  if (!t || t.markdown === text) return;
  t.markdown = text;
  hooks.afterEdit(t);
}

export function setMode(mode: Mode) {
  const t = activeTab.value;
  if (t) t.mode = mode;
}

/**
 * 底栏三按钮从左到右的顺序（124 定）。
 * 曾经是「标签栏一个按钮点击循环」的顺序（122），那个按钮 125 去掉了，
 * 顺序本身留着 —— 它同时是「阅读 → 编辑 → 源码」由浅入深的读法。
 */
export const MODE_CYCLE: Mode[] = ["read", "edit", "source"];

import type { MsgKey } from "../i18n";
import { t, tf } from "../i18n";

/**
 * 三档模式的显示名，**只这一份**（原来 StatusBar 与 TabBar 各写了一份，
 * 这次要改名「所见即所得 → 编辑」就得改两处，那种重复是事故源）。
 * 顺序也直接复用 `MODE_CYCLE`：底栏那三个按钮从左到右就是 阅读 / 编辑 / 源码。
 */
const MODE_MSG: Record<Mode, MsgKey> = { read: "mode.read", edit: "mode.edit", source: "mode.source" };

/** 三档模式的显示名：查 i18n，**仍然是只此一份**（124 的口径不变，只是从常量变成函数） */
export function modeLabel(m: Mode): string {
  return t(MODE_MSG[m]);
}

/**
 * 模式只有**一个入口**：底栏的三按钮组（`setMode`）。
 * 122 加的「标签栏循环按钮」已在 125 去掉（已定口径 Q10：直达就够了，
 * 循环按钮要用户先知道「现在在哪档、点一下去哪档」，是多余的一层）。
 * 所以这里不再有 `nextMode` / `cycleMode` —— 谁想加回来请先问，别擅自动。
 */

/** 每标签独立的缩放与宽度档（018 / 019） */
export function setZoom(z: number, id = tabs.activeId) {
  const t = tabs.list.find((x) => x.id === id);
  if (t) t.zoom = clampZoom(z);
}

export function setWidth(w: WidthPreset) {
  const t = activeTab.value;
  if (t) t.width = w;
}

export function setScroll(mode: Mode, value: number) {
  const t = activeTab.value;
  if (t) t.scroll[mode] = value;
}

/** 关闭标签。脏检查交给调用方（006 的确认对话框） */
export function closeTab(id: string) {
  const i = tabs.list.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [gone] = tabs.list.splice(i, 1);
  tabError.delete(id);
  // 119：关标签就把两份撤销历史一起丢掉 —— 会话恢复只恢复内容与滚动，不恢复撤销栈（009 口径）。
  // 顺带这也是这张表的唯一回收点：不清的话每开关一次就漏一份文档模型。
  dropTab(id);
  hooks.afterClose(gone);
  if (tabs.activeId === id) {
    const next = tabs.list[Math.min(i, tabs.list.length - 1)];
    tabs.activeId = next?.id ?? null;
  }
}

export function closeOtherTabs(id: string) {
  for (const t of [...tabs.list]) if (t.id !== id) closeTab(t.id);
}

export function closeTabsToRight(id: string) {
  const i = tabs.list.findIndex((t) => t.id === id);
  if (i === -1) return;
  for (const t of tabs.list.slice(i + 1)) closeTab(t.id);
}

/** 拖拽排序 */
export function moveTab(from: number, to: number) {
  if (from === to || from < 0 || to < 0) return;
  if (from >= tabs.list.length || to >= tabs.list.length) return;
  const [t] = tabs.list.splice(from, 1);
  tabs.list.splice(to, 0, t);
}

export function copyPath(): string | null {
  return activeTab.value?.path ?? null;
}

/**
 * 落盘一个标签。
 *
 * 成功后把 `saved` 基准推到当前内容 —— 脏判定是「工作副本 ≠ saved」，
 * 所以这一步同时负责熄掉脏点。失败时**不动 saved**，脏点保持，
 * 用户能立刻看出「这次没保存上」。
 */
export async function saveTab(tab: Tab): Promise<{ ok: boolean; error?: string }> {
  if (!host) return { ok: false, error: "宿主尚未就绪" };
  if (!tab.path) return { ok: false, error: "该文档还没有路径，请先另存为" };
  try {
    await host.writeFile(tab.path, tab.markdown);
    tab.saved = tab.markdown;
    hooks.afterSave(tab);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveActive(): Promise<{ ok: boolean; error?: string }> {
  const t = activeTab.value;
  return t ? saveTab(t) : { ok: false, error: "没有打开的文档" };
}

/**
 * 另存为给原生对话框的**建议名**（127 按已定口径 Q15 排重）。
 *
 * 两张未命名档接连另存为，建议名都是 `未命名.md` —— 第二张很容易把第一张覆盖掉。
 * 能排重的依据只有「**已经开着的这些标签的路径**」：原生对话框没打开之前，
 * 目标目录里有什么我们看不见（也不该偷偷去 stat 一个还没定的目录）。
 * 所以排重范围说清楚：同一次会话里已保存过的标签。命名规则 `未命名-2.md`、`未命名-3.md`…
 */
function suggestSaveName(tab: Tab): string {
  const base = tab.path ? baseName(tab.path) : UNTITLED_NAME + ".md";
  const taken = new Set(
    tabs.list.filter((t) => t.path).map((t) => baseName(normalize(t.path as string)).toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; i < 100; i++) {
    const cand = stem + "-" + i + ext;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return base; // 排到 99 还撞，交回原名让用户自己在对话框里定
}

/**
 * 另存为一个**指定标签**（127：未命名文档的保存路径就是一条另存为）。
 *
 * 三条细节：
 * - 建议名走 `suggestSaveName`（有路径给原文件名，没路径给「未命名.md」，且与已打开标签排重），
 *   不给一个空串让原生对话框显示成空白；
 * - 用户在原生对话框点了取消 → `error: "已取消"`，调用方**不要**当成失败弹窗（那是用户自己的选择）；
 * - 写失败时把路径**退回原值**：未命名文档本来就 `path === null`，
 *   不能留下一个「有路径但盘上没有」的假状态 —— 那样脏点会熄、下次保存会覆盖到别处。
 */
export async function saveTabAs(tab: Tab): Promise<{ ok: boolean; error?: string }> {
  if (!host) return { ok: false, error: "宿主尚未就绪" };
  const target = await host.pickSaveAs(suggestSaveName(tab));
  if (!target) return { ok: false, error: "已取消" };
  const before = tab.path;
  const beforeName = tab.name;
  tab.path = normalize(target);
  tab.name = baseName(tab.path);
  const r = await saveTab(tab);
  if (!r.ok) {
    tab.path = before;
    tab.name = beforeName;
  } else {
    void host.pushRecent(tab.path).catch(() => undefined);
  }
  return r;
}

/** 另存为当前标签 */
export async function saveActiveAs(): Promise<{ ok: boolean; error?: string }> {
  const t = activeTab.value;
  return t ? saveTabAs(t) : { ok: false, error: "没有打开的文档" };
}

export function getHost(): Host | null {
  return host;
}
