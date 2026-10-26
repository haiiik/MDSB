import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDerivedCapabilities } from "../../src/host/derived";
import type { HostBase } from "../../src/host/types";
import {
  activate,
  bindHost,
  closeTab,
  getHost,
  isDirty,
  openPath,
  tabs,
  updateMarkdown,
} from "../../src/state/documents";
import { flushAutoSaves, scheduleAutoSave } from "../../src/state/autosave";
import { settings } from "../../src/state/settings";
import { restoreSession, saveSession } from "../../src/state/session";
import { scanRecoverable } from "../../src/state/snapshot";
import { wirePersistence } from "../../src/state/persistence";

/** 内存版状态袋：派生能力（快照/最近/会话）全部建在它上面 */
function makeBase(): HostBase & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const base: HostBase & { store: Map<string, string> } = {
    kind: "mock",
    store,
    capabilities: { revealInFolder: false, dragDropPaths: false },
    info: async () => ({ kind: "mock", platform: "test", version: "0" }),
    readFile: async (p) => {
      const v = store.get("file:" + p);
      if (v === undefined) throw new Error("missing " + p);
      return v;
    },
    writeFile: async (p, c) => {
      store.set("file:" + p, c);
    },
    stat: async (p) => ({ path: p, name: p, size: 0, mtime: 0, isDir: false }),
    pickOpen: async () => null,
    pickSaveAs: async () => null,
    assetUrl: async (p) => p,
    getState: async (k) => store.get(k) ?? "",
    installLanguage: async () => "",
    setState: async (k, v) => {
      if (v === "") store.delete(k);
      else store.set(k, v);
    },
    windowMinimise: async () => undefined,
    windowToggleMaximise: async () => undefined,
    windowClose: async () => undefined,
    windowQuit: async () => undefined,
    windowIsMaximised: async () => false,
    windowDragMove: async () => undefined,
    onWindowCloseRequest: () => () => undefined,
    writeClipboard: async () => undefined,
    revealInFolder: async () => undefined,
    takeStartupFiles: async () => [],
    onStartupSignal: () => () => undefined,
  };
  return base;
}

describe("派生能力：最近列表", () => {
  it("去重、最新在前、裁剪到 50 条", async () => {
    const h = withDerivedCapabilities(makeBase());
    for (let i = 0; i < 55; i++) await h.pushRecent(`/d/f${i}.md`);
    await h.pushRecent("/d/f54.md");
    const list = await h.listRecent();
    expect(list).toHaveLength(50);
    expect(list[0].path).toBe("/d/f54.md");
    expect(list.filter((e) => e.path === "/d/f54.md")).toHaveLength(1);
  });

  it("移除单条不影响其它", async () => {
    const h = withDerivedCapabilities(makeBase());
    await h.pushRecent("/a.md");
    await h.pushRecent("/b.md");
    await h.removeRecent("/a.md");
    expect((await h.listRecent()).map((e) => e.path)).toEqual(["/b.md"]);
  });

  it("置顶项排在最前，且不占普通 50 条的名额", async () => {
    const h = withDerivedCapabilities(makeBase());
    for (let i = 0; i < 50; i++) await h.pushRecent(`/d/f${i}.md`);
    // f0 此时是最老的一条，先置顶它，再灌 5 条新的
    await h.setPinned("/d/f0.md", true);
    for (let i = 50; i < 55; i++) await h.pushRecent(`/d/f${i}.md`);

    const list = await h.listRecent();
    expect(list[0].path).toBe("/d/f0.md");
    expect(list[0].pinned).toBe(true);
    // 50 条普通 + 1 条置顶：置顶项不会因为上限被挤掉
    expect(list).toHaveLength(51);
    expect(list.some((e) => e.path === "/d/f54.md")).toBe(true);
    expect(list.some((e) => e.path === "/d/f4.md")).toBe(false);
  });

  it("清空最近列表", async () => {
    const h = withDerivedCapabilities(makeBase());
    await h.pushRecent("/a.md");
    await h.clearRecent();
    expect(await h.listRecent()).toEqual([]);
  });
});

describe("派生能力：崩溃快照", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("写入后可列出并读回", async () => {
    const h = withDerivedCapabilities(makeBase());
    await h.writeSnapshot("/d/a.md", "内容 A");
    expect(await h.listSnapshots()).toEqual(["/d/a.md"]);
    expect(await h.readSnapshot("/d/a.md")).toBe("内容 A");
  });

  it("超过 7 天的快照在列出时被清理", async () => {
    const h = withDerivedCapabilities(makeBase());
    await h.writeSnapshot("/d/old.md", "旧的");
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
    await h.writeSnapshot("/d/new.md", "新的");

    const left = await h.listSnapshots();
    expect(left).toEqual(["/d/new.md"]);
    expect(await h.readSnapshot("/d/old.md")).toBeNull();
  });

  it("清除快照后不再出现在列表", async () => {
    const h = withDerivedCapabilities(makeBase());
    await h.writeSnapshot("/d/a.md", "x");
    await h.clearSnapshot("/d/a.md");
    expect(await h.listSnapshots()).toEqual([]);
  });
});

describe("自动保存（007）", () => {
  let base: ReturnType<typeof makeBase>;

  beforeEach(async () => {
    vi.useFakeTimers();
    base = makeBase();
    const h = withDerivedCapabilities(base);
    bindHost(h);
    base.store.set("file:/d/a.md", "# A");
    tabs.list.splice(0, tabs.list.length);
    tabs.activeId = null;
    await openPath("/d/a.md");
    settings.autoSave = true;
    settings.autoSaveDelayMs = 1000;
  });
  afterEach(() => vi.useRealTimers());

  it("关闭态完全不排程，行为与手动保存一致", async () => {
    settings.autoSave = false;
    updateMarkdown("改了");
    await vi.advanceTimersByTimeAsync(5000);
    expect(base.store.get("file:/d/a.md")).toBe("# A");
  });

  it("连续快速输入只产生一次写盘", async () => {
    const writes: string[] = [];
    const real = base.writeFile.bind(base);
    base.writeFile = async (p, c) => {
      writes.push(c);
      return real(p, c);
    };
    const tab = tabs.list[0];
    for (const s of ["a", "ab", "abc", "abcd"]) {
      tab.markdown = s;
      scheduleAutoSave(tab);
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("abcd");
  });

  it("flush 立即落盘挂起的写入并熄掉脏点", async () => {
    updateMarkdown("待存内容");
    scheduleAutoSave(tabs.list[0]);
    expect(isDirty(tabs.list[0])).toBe(true);
    const ok = await flushAutoSaves();
    expect(ok).toBe(true);
    expect(base.store.get("file:/d/a.md")).toBe("待存内容");
    expect(isDirty(tabs.list[0])).toBe(false);
  });

  it("写盘失败时暂停自动保存并给出原因", async () => {
    base.writeFile = async () => {
      throw new Error("文件被占用");
    };
    const tab = tabs.list[0];
    tab.markdown = "x";
    scheduleAutoSave(tab);
    await vi.advanceTimersByTimeAsync(1500);
    expect(settings.autoSave).toBe(false);
  });
});

describe("127：关标签要把快照一起清掉（踩到的「丢弃后重开又提示恢复」）", () => {
  let base: ReturnType<typeof makeBase>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // 上一组用例把自动保存开着 —— 那样 3.1 秒里会先落一次盘，快照与磁盘相等，
    // 「有可恢复内容」这个前提就不成立了。这一组要的是「改了没存」，显式关掉。
    settings.autoSave = false;
    base = makeBase();
    wirePersistence(withDerivedCapabilities(base));
    tabs.list.splice(0, tabs.list.length);
    tabs.activeId = null;
    base.store.set("file:/d/a.md", "# A");
    await openPath("/d/a.md");
  });
  afterEach(() => vi.useRealTimers());

  it("编辑过 → 快照落盘 → 关标签（丢弃）→ 下次启动不再报「有未保存的内容」", async () => {
    const h = getHost();
    if (!h) throw new Error("wirePersistence 没绑上宿主");
    const id = tabs.list[0].id;

    updateMarkdown("# A\n\n改了一半又不要了");
    await vi.advanceTimersByTimeAsync(3100); // 快照防抖 3000ms
    // 前提：快照真的写进盘了 —— 没有这个前提，下面的断言是空转
    expect(await h.listSnapshots()).toEqual(["/d/a.md"]);
    expect((await scanRecoverable()).map((r) => r.path)).toEqual(["/d/a.md"]);

    // 点的就是「丢弃」：`closeTab` 是这条路径的唯一落点（保存成功后关也是它）
    closeTab(id);
    // 清快照是 `void h.clearSnapshot(...)`（产品里没人等它），断言前先把这条异步链跑完，
    // 否则读到的可能是「索引还没改写」的中间态 —— 那是用例的时机问题，不是产品问题
    await vi.advanceTimersByTimeAsync(50);
    expect(await h.listSnapshots()).toEqual([]);
    expect(await scanRecoverable()).toEqual([]);
  });

  it("只关掉别的标签，不动这一张的快照", async () => {
    const h = getHost();
    if (!h) throw new Error("wirePersistence 没绑上宿主");
    base.store.set("file:/d/b.md", "# B");
    await openPath("/d/b.md");
    const [a, b] = tabs.list;

    activate(a.id);
    updateMarkdown("# A 改过没存");
    await vi.advanceTimersByTimeAsync(3100);
    expect(await h.listSnapshots()).toEqual(["/d/a.md"]);

    activate(b.id);
    closeTab(b.id); // 关的是另一张干净的标签
    expect(await h.listSnapshots()).toEqual(["/d/a.md"]); // A 的快照还在，仍然可恢复
  });
});

describe("会话恢复（009）", () => {
  let base: ReturnType<typeof makeBase>;

  beforeEach(async () => {
    base = makeBase();
    bindHost(withDerivedCapabilities(base));
    // 上一组的标签会串进来，逐组清空
    tabs.list.splice(0, tabs.list.length);
    tabs.activeId = null;
    base.store.set("file:/d/a.md", "# A");
    base.store.set("file:/d/b.md", "# B");
  });

  it("存-取-比对：标签顺序、活动位、视图档都还原", async () => {
    await openPath("/d/a.md");
    await openPath("/d/b.md");
    const [a] = tabs.list;
    activate(a.id);
    a.mode = "source";
    a.zoom = 1.25;
    a.width = "wide";
    a.scroll.source = 320;
    await saveSession();

    // 模拟重启
    tabs.list.splice(0, tabs.list.length);
    tabs.activeId = null;
    bindHost(withDerivedCapabilities(base));

    const r = await restoreSession();
    expect(r.restored).toBe(2);
    expect(tabs.list.map((t) => t.name)).toEqual(["a.md", "b.md"]);
    expect(tabs.activeId).toBe(tabs.list[0].id);
    expect(tabs.list[0].mode).toBe("source");
    expect(tabs.list[0].zoom).toBe(1.25);
    expect(tabs.list[0].width).toBe("wide");
    expect(tabs.list[0].scroll.source).toBe(320);
  });

  it("文件已删除时跳过并报告，不阻断其它标签恢复", async () => {
    await openPath("/d/a.md");
    await openPath("/d/b.md");
    await saveSession();
    base.store.delete("file:/d/b.md");

    tabs.list.splice(0, tabs.list.length);
    tabs.activeId = null;
    const r = await restoreSession();
    expect(r.restored).toBe(1);
    expect(r.skipped).toEqual(["/d/b.md"]);
  });

  it("没有会话记录时是空操作", async () => {
    const r = await restoreSession();
    expect(r.restored).toBe(0);
    expect(tabs.list).toHaveLength(0);
  });
});
