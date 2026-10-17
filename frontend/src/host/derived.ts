import type { Host, HostBase, RecentEntry, SessionSnapshot } from "./types";

/**
 * 派生能力：在 getState/setState 两个原语之上实现快照 / 最近 / 会话。
 *
 * 之所以放在前端而不是 Go 侧：这三者的结构会随需求频繁变动，
 * 每改一次就重新生成 bindings 不值得；Go 侧只保留一个通用状态袋。
 */

const RECENT_KEY = "recent.v2";
const SESSION_KEY = "session.v1";
const SNAPSHOT_INDEX_KEY = "snapshot.index.v1";
const SNAPSHOT_PREFIX = "snapshot.v1.";

const RECENT_LIMIT = 50;

/** 文件路径 -> 状态袋键名。键里不能出现路径分隔符，统一转义。 */
function snapshotKey(path: string): string {
  return SNAPSHOT_PREFIX + encodeURIComponent(path);
}

/** 快照条目：内容 + 写入时刻（毫秒）。7 天后自动清理，避免状态袋无限增长。 */
interface SnapshotRecord {
  t: number;
  c: string;
}

const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalize(path: string): string {
  // 统一正斜杠 + 去重斜杠，Windows 反斜杠也归一，便于去重比较
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function samePath(a: string, b: string): boolean {
  // Windows 路径大小写不敏感；其它平台敏感
  return a.toLowerCase() === b.toLowerCase();
}

async function readJson<T>(base: HostBase, key: string, fallback: T): Promise<T> {
  const raw = await base.getState(key);
  if (!raw) return fallback;
  return (safeParse(raw) as T) ?? fallback;
}

/** 状态袋里的 JSON 可能被手工改坏，坏数据一律当「没有」而不是让应用崩 */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 置顶优先，其次按最后打开时间倒序 */
function sortRecent(list: RecentEntry[]): RecentEntry[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.at - a.at;
  });
}

/** 把只实现原语的宿主补全为完整 Host。 */
export function withDerivedCapabilities(base: HostBase): Host {
  const host = base as Host;

  host.writeSnapshot = async (path, content) => {
    const index = await readJson<string[]>(base, SNAPSHOT_INDEX_KEY, []);
    const key = snapshotKey(path);
    if (!index.includes(key)) {
      index.push(key);
      await base.setState(SNAPSHOT_INDEX_KEY, JSON.stringify(index));
    }
    const rec: SnapshotRecord = { t: Date.now(), c: content };
    await base.setState(key, JSON.stringify(rec));
  };

  host.listSnapshots = async () => {
    const index = await readJson<string[]>(base, SNAPSHOT_INDEX_KEY, []);
    const now = Date.now();
    const alive: string[] = [];
    const dropped: string[] = [];
    for (const k of index) {
      const raw = await base.getState(k);
      const rec = raw ? (safeParse(raw) as SnapshotRecord | null) : null;
      // 过期或坏数据一并清掉，状态袋不会无限增长（008 验收）
      if (rec && now - rec.t <= SNAPSHOT_TTL_MS) alive.push(k);
      else dropped.push(k);
    }
    if (dropped.length) {
      await base.setState(SNAPSHOT_INDEX_KEY, JSON.stringify(alive));
      for (const k of dropped) await base.setState(k, "");
    }
    return alive.map((k) => decodeURIComponent(k.slice(SNAPSHOT_PREFIX.length)));
  };

  host.readSnapshot = async (path) => {
    const raw = await base.getState(snapshotKey(path));
    if (!raw) return null;
    const rec = safeParse(raw) as SnapshotRecord | null;
    if (rec && typeof rec.c === "string") return rec.c;
    // 兼容早期直接存原文的格式
    return raw;
  };

  host.clearSnapshot = async (path) => {
    const key = snapshotKey(path);
    const index = await readJson<string[]>(base, SNAPSHOT_INDEX_KEY, []);
    const next = index.filter((k) => k !== key);
    if (next.length !== index.length) {
      await base.setState(SNAPSHOT_INDEX_KEY, JSON.stringify(next));
    }
    await base.setState(key, "");
  };

  /**
   * 最近列表的读-改-写串行执行。
   *
   * 连续打开两个文件时两次 pushRecent 会并发：都先 `await getState` 读到同一份旧列表，
   * 后写的那次把前一次覆盖掉，结果 50 条里只剩 1 条。宿主的状态袋没有事务，
   * 只能在这一层自己排队。
   */
  let recentChain: Promise<void> = Promise.resolve();
  const mutateRecent = (fn: (list: RecentEntry[]) => RecentEntry[]): Promise<void> => {
    recentChain = recentChain.then(async () => {
      const list = await readJson<RecentEntry[]>(base, RECENT_KEY, []);
      const normalized = list
        .map((e) =>
          typeof e === "string" ? { path: e, at: 0, pinned: false } : { ...e, path: normalize(e.path) }
        )
        .filter((e) => !!e.path);
      await base.setState(RECENT_KEY, JSON.stringify(fn(normalized)));
    });
    return recentChain;
  };

  host.listRecent = async () => {
    // 等排队中的写入落地再读，否则界面会看到「刚打开的文件没进列表」
    await recentChain;
    const list = await readJson<RecentEntry[]>(base, RECENT_KEY, []);
    const normalized = list
      .map((e) =>
        typeof e === "string" ? { path: e, at: 0, pinned: false } : { ...e, path: normalize(e.path) }
      )
      .filter((e) => !!e.path);
    return sortRecent(normalized);
  };

  host.pushRecent = async (path) => {
    const target = normalize(path);
    await mutateRecent((list) => {
      const rest = list.filter((e) => !samePath(normalize(e.path), target));
      rest.unshift({ path: target, at: Date.now(), pinned: false });
      const pinned = rest.filter((e) => e.pinned);
      const plain = rest.filter((e) => !e.pinned).slice(0, RECENT_LIMIT);
      return [...pinned, ...plain];
    });
  };

  host.removeRecent = async (path) => {
    const target = normalize(path);
    await mutateRecent((list) => list.filter((e) => !samePath(normalize(e.path), target)));
  };

  host.setPinned = async (path, pinned) => {
    const target = normalize(path);
    await mutateRecent((list) => {
      for (const e of list) if (samePath(normalize(e.path), target)) e.pinned = pinned;
      return list;
    });
  };

  host.clearRecent = async () => {
    await mutateRecent(() => []);
  };

  host.loadSession = async () => {
    const raw = await base.getState(SESSION_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SessionSnapshot;
      if (!Array.isArray(parsed.entries)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  host.saveSession = async (session) => {
    await base.setState(SESSION_KEY, JSON.stringify(session));
  };

  return host;
}
