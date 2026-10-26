import { setLang } from "../../src/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import type { Host } from "../../src/host/types";
import {
  activate,
  bindHost,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  createUntitled,
  globalError,
  hooks,
  isDirty,
  MODE_CYCLE,
  modeLabel,
  moveTab,
  openPath,
  saveActive,
  saveTab,
  saveTabAs,
  setTabMarkdown,
  setMode,
  tabError,
  tabs,
  UNTITLED_NAME,
  updateMarkdown,
} from "../../src/state/documents";

/** 假宿主：只实现标签逻辑要用的那几个方法 */
function fakeHost(files: Record<string, string>): Host & { writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const recent: string[] = [];
  const h = {
    kind: "mock",
    capabilities: { revealInFolder: false, dragDropPaths: false },
    writes,
    info: async () => ({ kind: "mock", platform: "test", version: "0" }),
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error("no such file " + p);
      return files[p];
    },
    writeFile: async (p: string, c: string) => {
      writes.push([p, c]);
      files[p] = c;
    },
    stat: async (p: string) => ({ path: p, name: p, size: 0, mtime: 0, isDir: false }),
    pickOpen: async () => null,
    pickSaveAs: async () => null,
    assetUrl: async (p: string) => p,
    getState: async () => "",
    installLanguage: async () => "",
    setState: async () => undefined,
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
    writeSnapshot: async () => undefined,
    listSnapshots: async () => [],
    readSnapshot: async () => null,
    clearSnapshot: async () => undefined,
    listRecent: async () => recent,
    pushRecent: async (p: string) => {
      recent.unshift(p);
    },
    removeRecent: async () => undefined,
    loadSession: async () => null,
    saveSession: async () => undefined,
  } as unknown as Host & { writes: Array<[string, string]> };
  return h;
}

const A = "/docs/a.md";
const B = "/docs/b.md";

let files: Record<string, string>;
let host: ReturnType<typeof fakeHost>;

beforeEach(() => {
  files = { [A]: "# A\n\n正文 A\n", [B]: "# B\n\n正文 B\n" };
  host = fakeHost(files);
  bindHost(host);
  tabs.list.splice(0, tabs.list.length);
  tabs.activeId = null;
  tabError.clear();
});

describe("打开与去重", () => {
  it("同一文件重复打开只聚焦已有标签", async () => {
    await openPath(A);
    await openPath(A);
    expect(tabs.list).toHaveLength(1);
  });

  it("反斜杠与大小写不同的同一路径也算同一个文件", async () => {
    files["C:/Docs/A.md"] = "# A";
    await openPath("C:/Docs/A.md");
    await openPath("C:\\docs\\a.md");
    expect(tabs.list).toHaveLength(1);
  });

  it("打开失败不产生标签，也不报错到界面外", async () => {
    const ok = await openPath("/docs/missing.md");
    expect(ok).toBe(false);
    expect(tabs.list).toHaveLength(0);
  });

  it("路径统一成正斜杠存储", async () => {
    const win = "C:\\Users\\demo\\文档\\a.md";
    // 假宿主按原样查表（真 Go 侧对反斜杠路径同样能读）
    files[win] = "# 中文路径";
    await openPath(win);
    expect(tabs.list[0].path).toBe("C:/Users/demo/文档/a.md");
  });
});

describe("标签操作", () => {
  beforeEach(async () => {
    await openPath(A);
    await openPath(B);
  });

  it("新标签排在末尾并成为活动标签", () => {
    expect(tabs.list.map((t) => t.name)).toEqual(["a.md", "b.md"]);
    expect(tabs.activeId).toBe(tabs.list[1].id);
  });

  it("关闭活动标签后，活动位落在相邻标签", () => {
    const [first, second] = tabs.list;
    closeTab(second.id);
    expect(tabs.activeId).toBe(first.id);
  });

  it("关闭最后一个标签后活动位为空", () => {
    for (const t of [...tabs.list]) closeTab(t.id);
    expect(tabs.list).toHaveLength(0);
    expect(tabs.activeId).toBeNull();
  });

  it("moveTab 保持活动跟随同一个标签", () => {
    const active = tabs.list[1];
    moveTab(1, 0);
    expect(tabs.list[0].id).toBe(active.id);
    expect(tabs.activeId).toBe(active.id);
  });

  it("关闭其他 / 关闭右侧", () => {
    const keep = tabs.list[0];
    closeOtherTabs(keep.id);
    expect(tabs.list).toHaveLength(1);
  });

  it("越界与同位移动是无操作", () => {
    moveTab(0, 0);
    moveTab(-1, 3);
    moveTab(9, 1);
    expect(tabs.list).toHaveLength(2);
  });
});

describe("脏状态", () => {
  it("刚打开不脏；改内容才脏；改回原样自动不脏", async () => {
    await openPath(A);
    const t = tabs.list[0];
    expect(isDirty(t)).toBe(false);
    updateMarkdown("# A\n\n改了\n");
    expect(isDirty(t)).toBe(true);
    updateMarkdown(t.saved);
    expect(isDirty(t)).toBe(false);
  });

  it("保存后脏点熄灭，且落盘内容与工作副本一致", async () => {
    await openPath(A);
    updateMarkdown("# A\n\n改了\n");
    const r = await saveActive();
    expect(r.ok).toBe(true);
    expect(isDirty(tabs.list[0])).toBe(false);
    expect(host.writes[0][1]).toBe("# A\n\n改了\n");
    expect(files[A]).toBe("# A\n\n改了\n");
  });

  it("保存失败时脏点保持", async () => {
    await openPath(A);
    updateMarkdown("x");
    host.writeFile = async () => {
      throw new Error("文件被占用");
    };
    const r = await saveActive();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("占用");
    expect(isDirty(tabs.list[0])).toBe(true);
  });

  it("每标签独立：改 A 不影响 B 的脏位", async () => {
    await openPath(A);
    await openPath(B);
    const a = tabs.list[0];
    activate(a.id);
    updateMarkdown("changed");
    expect(isDirty(a)).toBe(true);
    expect(isDirty(tabs.list[1])).toBe(false);
  });
});

describe("模式与滚动", () => {
  it("模式与滚动位置按标签各自保存", async () => {
    await openPath(A);
    await openPath(B);
    const [a, b] = tabs.list;
    activate(a.id);
    setMode("source");
    a.scroll.source = 120;
    activate(b.id);
    expect(b.mode).toBe("read");
    expect(b.scroll.source).toBe(0);
  });

  // 125：标签栏的循环按钮按已定口径 Q10 删了，`nextMode` / `cycleMode` 一起下线。
  // 这里钉的是「入口没了但状态机还在」：`MODE_CYCLE` 仍是底栏三按钮的左→右顺序，
  // 且**只有** `setMode` 能改档 —— 谁想加回循环，得先把这条口径改回来。
  it("底栏按钮组的顺序是 阅读 → 编辑 → 源码，且不存在循环入口", () => {
    expect(MODE_CYCLE).toEqual(["read", "edit", "source"]);
  });

  // 名字只有一个来源（124 把「所见即所得」改成「编辑」，两处各自定义时改一处就会不一致）
  it("三档的显示名只有一份，且旧称「所见即所得」已经换掉", () => {
    expect([modeLabel("read"), modeLabel("edit"), modeLabel("source")]).toEqual(["阅读", "编辑", "源码"]);
    // 语言可切：英文档换文案，切回来还是中文（钉的是「只有一份来源」这件事）
    setLang("en");
    expect(modeLabel("edit")).toBe("Editing");
    setLang("zh");
    expect(modeLabel("edit")).toBe("编辑");
  });

  it("setMode 只动当前标签，别的标签档不变", async () => {
    await openPath(A);
    await openPath(B);
    const [a, b] = tabs.list;
    activate(b.id);
    setMode("edit");
    expect(b.mode).toBe("edit");
    expect(a.mode).toBe("read");
  });
});

/**
 * 127：新增标签（未命名空文档）。
 *
 * 这组用例放在单测而不是 E2E，是因为要判的三条都发生在**状态层**：
 * 取消另存为、写盘失败、路径退回 —— 浏览器 mock 的原生对话框只会返回一个默认名，
 * 「取消」这一支在 E2E 里根本走不到，硬造钩子不如在这里直接喂一个假宿主。
 */
describe("127 未命名文档：新增、保存、失败回退", () => {
  beforeEach(() => {
    tabs.list.length = 0;
    tabs.activeId = null;
    globalError.value = "";
  });

  it("createUntitled 给一张空的编辑档，没有路径", () => {
    bindHost(fakeHost({}));
    const t = createUntitled();
    expect(t.path).toBeNull();
    expect(t.name).toBe(UNTITLED_NAME);
    expect(t.markdown).toBe("");
    expect(t.mode).toBe("edit");
    // 刚建出来不该是脏的：脏 = 与落盘基准不等，空文档的基准就是空
    expect(isDirty(t)).toBe(false);
  });

  it("没动过的空标签被复用；写过字的那张不会被下一次点「+」清掉", () => {
    bindHost(fakeHost({}));
    const first = createUntitled();
    expect(createUntitled().id).toBe(first.id);
    expect(tabs.list).toHaveLength(1);

    updateMarkdown("有字了");
    const second = createUntitled();
    expect(second.id).not.toBe(first.id);
    expect(tabs.list).toHaveLength(2);
    expect(first.markdown).toBe("有字了");
  });

  it("未命名文档不能原地保存，另存为才写盘，成功后接上新路径并进最近", async () => {
    const h = fakeHost({});
    const pushed: string[] = [];
    h.pickSaveAs = async () => "/docs/新稿.md";
    h.pushRecent = async (p: string) => {
      pushed.push(p);
    };
    bindHost(h);

    const t = createUntitled();
    updateMarkdown("正文");
    expect(isDirty(t)).toBe(true);

    const direct = await saveTab(t);
    expect(direct.ok).toBe(false);
    expect(h.writes).toEqual([]);

    const r = await saveTabAs(t);
    expect(r.ok).toBe(true);
    expect(t.path).toBe("/docs/新稿.md");
    expect(t.name).toBe("新稿.md");
    expect(isDirty(t)).toBe(false);
    expect(h.writes).toEqual([["/docs/新稿.md", "正文"]]);
    expect(pushed).toEqual(["/docs/新稿.md"]);
  });

  it("另存为被取消：回「已取消」，路径、名字、脏状态都不动", async () => {
    const h = fakeHost({});
    h.pickSaveAs = async () => null;
    bindHost(h);
    const t = createUntitled();
    updateMarkdown("还没起名的稿子");

    const r = await saveTabAs(t);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("已取消");
    expect(t.path).toBeNull();
    expect(t.name).toBe(UNTITLED_NAME);
    expect(isDirty(t)).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it("另存为写失败：路径退回 null、名字退回「未命名」，不留一个指向空文件的假路径", async () => {
    const h = fakeHost({});
    h.pickSaveAs = async () => "/docs/写不进.md";
    h.writeFile = async () => {
      throw new Error("只读");
    };
    bindHost(h);
    const t = createUntitled();
    updateMarkdown("不能丢的内容");

    const r = await saveTabAs(t);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("只读");
    expect(t.path).toBeNull();
    expect(t.name).toBe(UNTITLED_NAME);
    expect(isDirty(t)).toBe(true);
    expect(t.markdown).toBe("不能丢的内容");
  });

  it("两张未命名档接连另存为：建议名自动排重成 未命名-2.md（口径 Q15）", async () => {
    const h = fakeHost({});
    const 建议: string[] = [];
    h.pickSaveAs = async (name: string) => {
      建议.push(name);
      return "/demo/" + name;
    };
    bindHost(h);

    const a = createUntitled();
    updateMarkdown("第一张的内容");
    expect((await saveTabAs(a)).ok).toBe(true);

    const b = createUntitled();
    updateMarkdown("第二张的内容");
    expect((await saveTabAs(b)).ok).toBe(true);

    expect(建议).toEqual(["未命名.md", "未命名-2.md"]);
    expect(a.path).toBe("/demo/未命名.md");
    expect(b.path).toBe("/demo/未命名-2.md");
    // 排重只看「已经开着并已保存的标签」，不该把第一张的内容挪到第二张名下
    expect(h.writes).toEqual([
      ["/demo/未命名.md", "第一张的内容"],
      ["/demo/未命名-2.md", "第二张的内容"],
    ]);
  });

  it("setTabMarkdown 按 id 写：源码档那份跨挂载复用的监听靠它，绝不能写进别的标签", async () => {
    bindHost(fakeHost({ [A]: "甲", [B]: "乙" }));
    await openPath(A);
    await openPath(B);
    const [a, b] = tabs.list;
    activate(b.id); // 当前在 B，回写的却是 A —— 正是「切走再切回」后旧监听拿着旧 tabId 的形状

    setTabMarkdown(a.id, "甲改过");
    expect(a.markdown).toBe("甲改过");
    expect(b.markdown).toBe("乙");
    expect(isDirty(a)).toBe(true);
    expect(isDirty(b)).toBe(false);

    setTabMarkdown(null, "谁都不该改");
    expect(a.markdown).toBe("甲改过");
    // 同文本重复写不产生第二次 afterEdit（回声要被吃掉）
    let 次数 = 0;
    const 原 = hooks.afterEdit;
    hooks.afterEdit = () => {
      次数++;
    };
    setTabMarkdown(a.id, "甲改过");
    expect(次数).toBe(0);
    setTabMarkdown(a.id, "甲又改了");
    expect(次数).toBe(1);
    hooks.afterEdit = 原;
  });

  it("已有路径的文档另存为失败时退回原路径（这条是 127 之前的行为，不能退化）", async () => {
    const h = fakeHost({ [A]: "原内容" });
    h.pickSaveAs = async () => "/docs/新位置.md";
    h.writeFile = async () => {
      throw new Error("磁盘满");
    };
    bindHost(h);
    await openPath(A);
    const t = tabs.list[0];
    updateMarkdown("改过的");

    const r = await saveTabAs(t);
    expect(r.ok).toBe(false);
    expect(t.path).toBe(A);
    expect(t.name).toBe("a.md");
  });
});
