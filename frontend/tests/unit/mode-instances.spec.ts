import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canReuseEdit,
  canReuseSource,
  clearModeHint,
  dropEdit,
  dropTab,
  MODE_HINT_TTL_MS,
  peekEdit,
  peekSource,
  pushModeHint,
  stashEdit,
  stashSource,
  type EditInstance,
} from "../../src/state/modeInstances";
import { modeHint } from "../../src/state/modeInstances";

/**
 * 119：三模式来回切，**撤销栈按标签持有**。
 *
 * 这颗的产品行为全在「切走时留下什么、切回时能不能接着用」这一张表上，
 * 而起一个真的 PM/CM 实例来测它太贵，所以表本身做成纯逻辑：
 * 实例对象用**结构等价的最小假对象**代替（`state`/`doc` 只被原样存取，
 * 唯一被读的字段是「这份工作文本是什么」）。
 */

function fakeEdit(emitted: string): EditInstance {
  return {
    // PM 的 EditorState / mdast 派生的 doc 在这里只被存取，不参与判断，所以用假对象
    state: { fake: "pm" } as never,
    sourceText: emitted,
    sourceDoc: { fake: "doc" } as never,
    emitted,
  };
}

const fakeSource = (doc: string) => ({ doc: { toString: () => doc } }) as never;

beforeEach(() => {
  dropTab("t1");
  dropTab("t2");
  clearModeHint();
});

describe("编辑模式的实例表", () => {
  it("没切走过就没有实例：第一次进编辑模式不该报「撤销栈清空」", () => {
    expect(peekEdit("t1")).toBeNull();
    expect(canReuseEdit(peekEdit("t1"), "正文")).toBe(false);
  });

  it("切走再切回、内容没动 → 可复用（撤销栈延续）", () => {
    stashEdit("t1", fakeEdit("甲\n\n乙\n"));
    expect(canReuseEdit(peekEdit("t1"), "甲\n\n乙\n")).toBe(true);
  });

  it("另一头改过内容 → 不可复用，且旧实例要被丢掉", () => {
    const inst = fakeEdit("甲\n\n乙\n");
    stashEdit("t1", inst);
    expect(canReuseEdit(peekEdit("t1"), "甲\n\n乙丙\n")).toBe(false);
    dropEdit("t1");
    expect(peekEdit("t1")).toBeNull();
  });

  it("判据是逐字节相等：只差一个空格也算改过（不许用「差不多」复用）", () => {
    stashEdit("t1", fakeEdit("甲 \n"));
    expect(canReuseEdit(peekEdit("t1"), "甲\n")).toBe(false);
  });

  it("按标签隔离：t1 的栈不会给 t2 用", () => {
    stashEdit("t1", fakeEdit("一\n"));
    expect(peekEdit("t2")).toBeNull();
    expect(canReuseEdit(peekEdit("t2"), "一\n")).toBe(false);
  });
});

describe("源码模式的实例表", () => {
  it("内容没动 → 可复用；CodeMirror 的历史就在 state 里", () => {
    const st = fakeSource("甲\n");
    stashSource("t1", st);
    expect(canReuseSource(peekSource("t1"), "甲\n")).toBe(true);
    expect(peekSource("t1")).toBe(st);
  });

  it("编辑模式改过 → 不复用", () => {
    stashSource("t1", fakeSource("甲\n"));
    expect(canReuseSource(peekSource("t1"), "甲乙\n")).toBe(false);
  });
});

describe("关标签", () => {
  it("两种模式的历史一起清掉：重开同一份文件撤销栈是空的（009 口径）", () => {
    stashEdit("t1", fakeEdit("甲\n"));
    stashSource("t1", fakeSource("甲\n"));
    dropTab("t1");
    expect(peekEdit("t1")).toBeNull();
    expect(peekSource("t1")).toBeNull();
  });
});

describe("轻提示（口径 Q4 的 A 案）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("切回时撤销栈被丢弃才提示", () => {
    pushModeHint("源码模式改过内容，编辑模式的撤销栈已重新开始。");
    expect(modeHint.value).toContain("撤销栈");
  });

  it(`到 ${MODE_HINT_TTL_MS}ms 自己消失`, () => {
    pushModeHint("提示");
    vi.advanceTimersByTime(MODE_HINT_TTL_MS - 1);
    expect(modeHint.value).toBe("提示");
    vi.advanceTimersByTime(1);
    expect(modeHint.value).toBe("");
  });

  it("后一条不被前一条的计时器提前抹掉", () => {
    pushModeHint("第一条");
    vi.advanceTimersByTime(3000);
    pushModeHint("第二条");
    vi.advanceTimersByTime(1500); // 距第一条已经 4.5s，若计时器没重置，第二条会被抹掉
    expect(modeHint.value).toBe("第二条");
    vi.advanceTimersByTime(MODE_HINT_TTL_MS - 1500);
    expect(modeHint.value).toBe("");
  });

  it("clear 立刻消失（切标签/关标签时不该还挂着上一份文档的提示）", () => {
    pushModeHint("提示");
    clearModeHint();
    expect(modeHint.value).toBe("");
  });
});
