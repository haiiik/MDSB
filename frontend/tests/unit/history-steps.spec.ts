import { Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { HISTORY_GROUP_DELAY_MS, HP_STEP_META, isTypingTransaction } from "../../src/kernel/pm/history";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { hpSchema } from "../../src/kernel/pm/schema";
import { blockCommand, toggleBold } from "../../src/kernel/pm/toolbar";

/**
 * 117：撤销粒度的判据层。
 *
 * 「按一次 Ctrl+Z 回到哪」是 E2E 的判据（要真键盘、真停顿），
 * 但**哪些事务算打字、哪些算结构操作**是纯形状判断，这里钉死：
 * 判错一类，要么连续打字被拆成五步（打字体验碎），要么粘贴和打字被并成一步（撤销过头）。
 */

const DOC = "段落文字。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";

const base = () => EditorState.create({ doc: mdastToDoc(DOC), schema: hpSchema });

/** 光标在第一个段落开头 */
const atStart = (): EditorState => {
  const s = base();
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1)));
};

/** 跑一条命令，把它派发出来的事务拿回来（没派发就返回 null） */
function runCommand(cmd: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean): Transaction | null {
  const s = atStart();
  let out: Transaction | null = null;
  cmd(s, (tr) => {
    out = tr;
  });
  return out;
}

describe("打字：可与上一笔合并成一步", () => {
  it("插入一个字符 = 打字", () => {
    expect(isTypingTransaction(atStart().tr.insertText("甲"))).toBe(true);
  });

  it("一次事务里连打一串字仍是打字", () => {
    expect(isTypingTransaction(atStart().tr.insertText("十个字的内容"))).toBe(true);
  });

  it("删除（退格那种）= 打字", () => {
    expect(isTypingTransaction(atStart().tr.delete(1, 3))).toBe(true);
  });

  it("带 mark 的文字也算打字：在粗体里连打不该一字一步", () => {
    const bold = hpSchema.marks.strong.create();
    const slice = new Slice(Fragment.from(hpSchema.text("粗体字", [bold])), 0, 0);
    expect(isTypingTransaction(atStart().tr.replaceSelection(slice))).toBe(true);
  });
});

describe("结构操作：自成一步", () => {
  it("粘贴表格（块级内容）不是打字", () => {
    const table = mdastToDoc("| X | Y |\n| --- | --- |\n| 1 | 2 |\n").child(0);
    expect(isTypingTransaction(atStart().tr.replaceSelectionWith(table, false))).toBe(false);
  });

  it("粘贴纯文本（事务带 paste 的 uiEvent）也算结构 —— 验收明写「粘贴 → 独立一步」", () => {
    const tr = atStart().tr.insertText("粘进来的纯文本").setMeta("uiEvent", "paste");
    expect(isTypingTransaction(tr)).toBe(false);
  });

  it("块类型转换（段落 → H1）不是打字", () => {
    const tr = runCommand(blockCommand("h1"));
    expect(tr).not.toBeNull();
    expect(isTypingTransaction(tr!)).toBe(false);
  });

  it("加粗（标记步）不是打字", () => {
    const s0 = base();
    const s = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, 1, 4)));
    let out: Transaction | null = null;
    toggleBold()(s, (tr) => {
      out = tr;
    });
    expect(out).not.toBeNull();
    expect(isTypingTransaction(out!)).toBe(false);
  });

  it("显式打了 hpStep 标记的事务一律自成一步", () => {
    const tr = atStart().tr.insertText("甲").setMeta(HP_STEP_META, true);
    expect(isTypingTransaction(tr)).toBe(false);
  });

  it("没改文档的事务（纯滚动/移动光标）不算打字，也不需要成组", () => {
    expect(isTypingTransaction(atStart().tr.scrollIntoView())).toBe(false);
  });
});

describe("合并窗口只有一个来源", () => {
  it("500ms —— 工单建议的起点，要改必须同时回写 117 完成记录", () => {
    expect(HISTORY_GROUP_DELAY_MS).toBe(500);
  });
});
