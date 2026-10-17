import { getHost, tabs, type Tab } from "./documents";

/**
 * 崩溃快照（008）：低频把未保存内容抄一份到应用数据目录，
 * **绝不碰原文件**。正常保存后清掉，避免下次启动误报。
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const SNAPSHOT_DEBOUNCE_MS = 3000;

export function scheduleSnapshot(tab: Tab) {
  if (!tab.path) return;
  const h = getHost();
  if (!h) return;
  const existing = timers.get(tab.id);
  if (existing) clearTimeout(existing);
  timers.set(
    tab.id,
    setTimeout(() => {
      timers.delete(tab.id);
      const current = tabs.list.find((t) => t.id === tab.id);
      // 标签已关或已保存干净就不必再抄
      if (!current || current.markdown === current.saved) return;
      void h.writeSnapshot(current.path ?? "", current.markdown).catch(() => undefined);
    }, SNAPSHOT_DEBOUNCE_MS)
  );
}

export function stopSnapshot(id: string) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** 保存成功后清快照，否则下次启动会误报「有未保存内容」 */
export function clearSnapshotFor(tab: Tab) {
  const h = getHost();
  if (!h || !tab.path) return;
  stopSnapshot(tab.id);
  void h.clearSnapshot(tab.path).catch(() => undefined);
}

export interface Recoverable {
  path: string;
  name: string;
  /** 快照里的内容（未保存的那份） */
  content: string;
  /** 磁盘上现在的内容；文件已不存在时为空串 */
  onDisk: string;
  fileMissing: boolean;
}

/**
 * 启动时扫描：快照内容与磁盘不一致即视为「有未保存内容可恢复」。
 * 磁盘读不到（文件被删）也保留条目 —— 那份内容可能是世界上唯一的一份。
 */
export async function scanRecoverable(): Promise<Recoverable[]> {
  const h = getHost();
  if (!h) return [];
  const paths = await h.listSnapshots();
  const out: Recoverable[] = [];
  for (const path of paths) {
    const snap = await h.readSnapshot(path);
    if (snap === null) continue;
    let onDisk = "";
    let fileMissing = false;
    try {
      onDisk = await h.readFile(path);
    } catch {
      fileMissing = true;
    }
    if (fileMissing || onDisk !== snap) {
      out.push({ path, name: path.split(/[\\/]/).pop() ?? path, content: snap, onDisk, fileMissing });
    }
  }
  return out;
}
