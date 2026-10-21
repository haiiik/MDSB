import { Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { closeHistory, history, undo } from "prosemirror-history";
import { HISTORY_GROUP_DELAY_MS, HP_STEP_META, isTypingTransaction } from "../../src/kernel/pm/history";
import { documentShapePlugin } from "../../src/kernel/pm/plugins";
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

/**
 * 142：形状插件那笔「末尾补一行」的事务不许把撤销拆成两步。
 *
 * 机制上它是 `appendTransaction` 追加的，与触发它的那笔事务在**同一次 apply 轮次**里，
 * `prosemirror-history` 的 appendTransaction 收到的是这一整批事务 → 记成同一个历史事件。
 * 这条判据钉的就是"同一个事件"：粘一张表（末尾被补了一行）之后按一次 Ctrl+Z，
 * 要直接回到原文，而不是"撤掉补行 → 又被加回来"空转。
 * review 提过这里可能污染撤销栈，实测不复现 —— 但**没有判据的"没问题"不算数**，所以钉上。
 */
describe("142：补行与撤销栈", () => {
  const 表 = () =>
    hpSchema.nodes.table.create(null, [
      hpSchema.nodes.table_row.create(null, [
        hpSchema.nodes.table_header.createAndFill()!,
        hpSchema.nodes.table_header.createAndFill()!,
      ]),
      hpSchema.nodes.table_row.create(null, [
        hpSchema.nodes.table_cell.create(null, Fragment.from(hpSchema.text("采油"))),
        hpSchema.nodes.table_cell.create(null, Fragment.from(hpSchema.text("12"))),
      ]),
    ]);
  const 形状 = (s: EditorState) => Array.from(s.doc.children).map((x) => x.type.name);

  it("整篇换成一张表（补行被触发）→ 一次 Ctrl+Z 回到原文", () => {
    let state = EditorState.create({
      schema: hpSchema,
      doc: mdastToDoc("原有的一段。\n"),
      plugins: [history(), documentShapePlugin()],
    });
    state = state.apply(closeHistory(state.tr.replaceWith(0, state.doc.content.size, 表())));
    state = state.apply(closeHistory(state.tr));
    expect(形状(state)).toEqual(["table", "paragraph"]); // 补行确实被触发了

    undo(state, (t) => (state = state.apply(t)));
    expect(state.doc.textContent).toBe("原有的一段。");
    expect(形状(state)).toEqual(["paragraph"]);
  });

  it("粘表 → 在补出来的那行打字 → 两次 Ctrl+Z 回到原文（不是空转）", () => {
    let state = EditorState.create({
      schema: hpSchema,
      doc: mdastToDoc("原有的一段。\n"),
      plugins: [history(), documentShapePlugin()],
    });
    state = state.apply(closeHistory(state.tr.replaceWith(0, state.doc.content.size, 表())));
    state = state.apply(closeHistory(state.tr));
    state = state.apply(state.tr.insertText("正文", state.doc.content.size - 1));
    expect(state.doc.textContent).toBe("采油12正文");

    undo(state, (t) => (state = state.apply(t)));
    expect(state.doc.textContent).toBe("采油12");
    undo(state, (t) => (state = state.apply(t)));
    expect(state.doc.textContent).toBe("原有的一段。");
  });
});
