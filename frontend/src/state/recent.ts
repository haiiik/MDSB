import { reactive } from "vue";
import type { RecentEntry } from "../host/types";
import { getHost, openPath, baseName } from "./documents";

/**
 * 最近文件列表（011）。
 *
 * 排序、去重、裁剪、置顶这些规则住在宿主的状态袋里（`host/derived.ts`），
 * 这里只管展示与可用性探测。
 */

export const recent = reactive<{ items: RecentEntry[]; unavailable: Set<string>; loaded: boolean }>({
  items: [],
  unavailable: new Set(),
  loaded: false,
});

export async function refreshRecent(): Promise<void> {
  const h = getHost();
  if (!h) return;
  recent.items = await h.listRecent();
  recent.loaded = true;
  // 逐个探活：文件被删/移走时条目仍要留在列表里，只是标成不可用
  for (const e of recent.items) {
    void h.stat(e.path)
      .then(() => recent.unavailable.delete(e.path))
      .catch(() => recent.unavailable.add(e.path));
  }
}

export function isUnavailable(path: string): boolean {
  return recent.unavailable.has(path);
}

export async function removeRecent(path: string) {
  const h = getHost();
  if (!h) return;
  await h.removeRecent(path);
  await refreshRecent();
}

export async function togglePin(path: string) {
  const h = getHost();
  if (!h) return;
  const item = recent.items.find((e) => e.path === path);
  await h.setPinned(path, !(item?.pinned ?? false));
  await refreshRecent();
}

export async function clearAllRecent() {
  const h = getHost();
  if (!h) return;
  await h.clearRecent();
  await refreshRecent();
}

/** 点击一条最近记录；文件已不可用时返回 false 让界面给提示 */
export async function openRecent(path: string): Promise<boolean> {
  const h = getHost();
  if (!h) return false;
  try {
    await h.stat(path);
  } catch {
    recent.unavailable.add(path);
    return false;
  }
  const ok = await openPath(path);
  if (ok) await refreshRecent();
  return ok;
}

export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

export { baseName };

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 具体日期 */
export function relativeTime(at: number, now = Date.now()): string {
  if (!at) return "";
  const diff = Math.max(0, now - at);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
