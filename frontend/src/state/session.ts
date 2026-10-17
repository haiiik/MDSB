import type { SessionEntry } from "../host/types";
import {
  activate,
  getHost,
  openPath,
  setMode,
  tabs,
  type Mode,
} from "./documents";
import type { WidthPreset } from "../kernel/render";

/**
 * 会话恢复（009）：正常退出时记下标签组与每个标签的位置，下次启动还原。
 *
 * 与 008 的崩溃快照是两条独立通道：会话只记**路径与视图状态**（不存内容），
 * 快照存**未保存的内容**。有未保存内容时先走快照恢复提示，再走会话还原。
 */

export async function saveSession(): Promise<void> {
  const h = getHost();
  if (!h) return;
  const entries: SessionEntry[] = tabs.list
    .filter((t) => t.path)
    .map((t) => ({
      path: t.path as string,
      mode: t.mode,
      scroll: { ...t.scroll },
      cursor: t.cursor,
      zoom: t.zoom,
      width: t.width,
    }));
  const active = tabs.list.find((t) => t.id === tabs.activeId)?.path ?? null;
  await h.saveSession({ entries, active });
}

/** 还原会话；返回成功恢复的标签数。读不到文件或已删除的跳过 */
export async function restoreSession(): Promise<{ restored: number; skipped: string[] }> {
  const h = getHost();
  if (!h) return { restored: 0, skipped: [] };
  const snap = await h.loadSession();
  if (!snap || snap.entries.length === 0) return { restored: 0, skipped: [] };

  const skipped: string[] = [];
  for (const e of snap.entries) {
    if (tabs.list.some((t) => t.path === e.path)) continue;
    const ok = await openPath(e.path);
    if (!ok) {
      skipped.push(e.path);
      continue;
    }
    const tab = tabs.list.find((t) => t.path === e.path);
    if (!tab) continue;
    tab.mode = e.mode as Mode;
    tab.scroll = {
      read: e.scroll?.read ?? 0,
      source: e.scroll?.source ?? 0,
      edit: e.scroll?.edit ?? 0,
    };
    tab.cursor = e.cursor;
    tab.zoom = e.zoom || 1;
    tab.width = (e.width || "normal") as WidthPreset;
  }

  if (snap.active) {
    const target = tabs.list.find((t) => t.path === snap.active);
    if (target) activate(target.id);
  }

  // 会话里的视图状态要在打开后重新渲染一次才生效
  const cur = tabs.list.find((t) => t.id === tabs.activeId);
  if (cur) setMode(cur.mode);

  return { restored: tabs.list.length, skipped };
}

export async function clearSession(): Promise<void> {
  const h = getHost();
  if (h) await h.saveSession({ entries: [], active: null });
}
