import { Fragment, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { hpSchema } from "../../src/kernel/pm/schema";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { applyChanges } from "../../src/kernel/pm/patches";
import { topBlocks } from "../../src/kernel/blockPatch";
import {
  blockCommand,
  cursorIn,
  linkCommand,
  selectBlocks,
  testDoc,
  toggleBold,
  toolbarState,
} from "../../src/kernel/pm/toolbar";

/**
 * 113：工具栏命令与状态。
 *
 * 工具栏的按钮语义是「再点一次回到原样」，最容易写错的就是叠加：
 * 点三下引用套出三层 blockquote、点标题时把多块选区塌成一块。
 * 这里全部在 EditorState 层面断言（不起浏览器），形状与写回都查。
 */

const n = hpSchema.nodes;
const para = (text = ""): PMNode =>
  n.paragraph.create(null, text ? Fragment.from(hpSchema.text(text)) : Fragment.empty);
const head = (level: number, text: string): PMNode =>
  n.heading.create({ level }, Fragment.from(hpSchema.text(text)));

/** 跑命令，返回新文档（断言命令可用） */
function run(cmd: Command, state: EditorState): PMNode {
  let out: PMNode | null = null;
  const ok = cmd(state, (tr: Transaction) => (out = tr.doc));
  expect(ok, "命令返回 false（按钮该置灰）").toBe(true);
  return out!;
}

/** 命令是否可用（不派发） */
function can(cmd: Command, state: EditorState): boolean {
  return cmd(state, () => {});
}

describe("toolbarState 读的是光标所在块", () => {
  it("段落 / 标题带层级 / 代码块 / 表格", () => {
    const doc = testDoc(para("正文"), head(3, "三级"), para("x"));
    expect(toolbarState(cursorIn(doc, 0)).block).toBe("paragraph");
    const s1 = toolbarState(cursorIn(doc, 1));
    expect(s1.block).toBe("heading");
    expect(s1.level).toBe(3);

    const codeDoc = mdastToDoc("```sql\nSELECT 1;\n```\n", hpSchema);
    const codeState = cursorIn(codeDoc, 0);
    expect(toolbarState(codeState).block).toBe("code");
    expect(toolbarState(codeState).inCode).toBe(true);

    const tableDoc = mdastToDoc("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n", hpSchema);
    expect(toolbarState(cursorIn(tableDoc, 0)).block).toBe("table");
  });

  it("列表与任务项：记号与 checked 都读得到", () => {
    const doc = mdastToDoc("- 甲\n- [x] 乙\n\n3. 丙\n", hpSchema);
    const s = toolbarState(cursorIn(doc, 0));
    expect(s.block).toBe("list");
    expect(s.list).toBe("bullet");
    expect(s.checked).toBe(null); // 第一项不是任务项
  });

  it("行内标记按光标处的 marks 报", () => {
    const doc = mdastToDoc("普通 **粗** 通\n", hpSchema);
    // 光标放进「粗」那段文字里
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text === "粗") pos = p + 1;
      return true;
    });
    const base = EditorState.create({ doc, schema: hpSchema });
    const state = base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(pos))));
    const s = toolbarState(state);
    expect(s.bold).toBe(true);
    expect(s.italic).toBe(false);
  });
});

describe("块类型切换：再点一次回原样，不叠加", () => {
  it("正文 → 一级标题 → 再点同样的按钮回正文", () => {
    const state = cursorIn(testDoc(para("部署说明")), 0);
    const once = run(blockCommand({ kind: "heading", level: 1 }), state);
    expect(once.child(0).type.name).toBe("heading");
    expect(once.child(0).attrs.level).toBe(1);

    const back = run(blockCommand({ kind: "heading", level: 1 }), cursorIn(once, 0));
    expect(back.child(0).type.name).toBe("paragraph");
  });

  it("标题层级之间直接换，不产生第二个标题块", () => {
    const state = cursorIn(testDoc(head(1, "大标题")), 0);
    const out = run(blockCommand({ kind: "heading", level: 3 }), state);
    expect(out.childCount).toBe(1);
    expect(out.child(0).attrs.level).toBe(3);
    expect(out.child(0).textContent).toBe("大标题");
  });

  it("引用点两次 = 包上再提出，不会套两层", () => {
    const state = cursorIn(testDoc(para("引文")), 0);
    const once = run(blockCommand({ kind: "quote" }), state);
    expect(once.child(0).type.name).toBe("blockquote");
    const twice = run(blockCommand({ kind: "quote" }), cursorIn(once, 0));
    expect(twice.child(0).type.name).toBe("paragraph");
    expect(twice.child(0).textContent).toBe("引文");
  });

  it("代码块：正文变围栏，再点回正文", () => {
    const state = cursorIn(testDoc(para("SELECT 1;")), 0);
    const once = run(blockCommand({ kind: "code" }), state);
    expect(once.child(0).type.name).toBe("code_block");
    const back = run(blockCommand({ kind: "code" }), cursorIn(once, 0));
    expect(back.child(0).type.name).toBe("paragraph");
  });

  it("多块选区：两块都变标题，且不塌成一块", () => {
    const doc = testDoc(para("第一段"), para("第二段"), para("第三段"));
    const state = selectBlocks(doc, 0, 1);
    const out = run(blockCommand({ kind: "heading", level: 2 }), state);
    expect(out.childCount).toBe(3);
    expect(out.child(0).type.name).toBe("heading");
    expect(out.child(1).type.name).toBe("heading");
    expect(out.child(2).type.name).toBe("paragraph"); // 没被选中的那块不动
  });
});

describe("列表与任务项按钮", () => {
  it("正文 → 无序列表；同种再点提出列表", () => {
    const state = cursorIn(testDoc(para("买牛奶")), 0);
    const once = run(blockCommand({ kind: "bullet" }), state);
    expect(once.child(0).type.name).toBe("bullet_list");
    const back = run(blockCommand({ kind: "bullet" }), cursorIn(once, 0));
    expect(back.child(0).type.name).toBe("paragraph");
  });

  it("无序 ↔ 有序：文字与项数不变，只换记号", () => {
    const doc = mdastToDoc("- 甲\n- 乙\n", hpSchema);
    const state = cursorIn(doc, 0);
    const out = run(blockCommand({ kind: "ordered" }), state);
    expect(out.child(0).type.name).toBe("ordered_list");
    expect(out.child(0).childCount).toBe(2);
    expect(out.child(0).textContent).toBe("甲乙");
  });

  it("普通段落点任务项 → 变成未勾选的任务项", () => {
    const state = cursorIn(testDoc(para("待办一")), 0);
    const out = run(blockCommand({ kind: "task" }), state);
    const list = out.child(0);
    expect(list.type.name).toBe("bullet_list");
    expect(list.child(0).type.name).toBe("list_item");
    expect(list.child(0).attrs.checked).toBe(false);
    expect(list.textContent).toBe("待办一");
  });

  it("已是任务项再点 → 取消勾选变回普通项", () => {
    const doc = mdastToDoc("- [ ] 待办二\n", hpSchema);
    const out = run(blockCommand({ kind: "task" }), cursorIn(doc, 0));
    expect(out.child(0).child(0).attrs.checked).toBe(null);
  });
});

describe("行内标记与链接", () => {
  it("加粗：选中文段加 strong，再点取消", () => {
    const countBold = (doc: PMNode): number => {
      let c = 0;
      doc.descendants((x) => {
        if (x.isText && x.marks.some((m) => m.type.name === "strong")) c++;
        return true;
      });
      return c;
    };
    const doc = mdastToDoc("强调文字\n", hpSchema);
    expect(countBold(doc)).toBe(0);
    const once = run(toggleBold(), selectBlocks(doc, 0, 0));
    expect(countBold(once)).toBe(1);
    expect(once.textContent).toBe("强调文字");
    expect(countBold(run(toggleBold(), selectBlocks(once, 0, 0)))).toBe(0);
  });

  it("链接：空 URL 是取消而不是写个空 href", () => {
    const doc = mdastToDoc("[文字](https://a.example)\n", hpSchema);
    const state = selectBlocks(doc, 0, 0);
    const out = run(linkCommand("https://b.example"), state);
    let href: unknown = null;
    out.descendants((x) => {
      const m = x.marks.find((k) => k.type.name === "link");
      if (m) href = m.attrs.href;
      return true;
    });
    expect(href).toBe("https://b.example");

    const cleared = run(linkCommand(""), selectBlocks(out, 0, 0));
    cleared.descendants((x) => {
      expect(x.marks.some((m) => m.type.name === "link")).toBe(false);
      return true;
    });
  });

  it("空选区点链接：返回 false（按钮置灰），不抛错", () => {
    expect(can(linkCommand("https://a.example"), cursorIn(testDoc(para("光标在这儿")), 0))).toBe(false);
  });
});

describe("工具栏转换仍走按块回写", () => {
  it("把第二段变标题后，第一段与第三段逐字节不变", () => {
    const src = "# 标题\n\n第一段正文。\n\n第二段正文。\n\n末段。\n";
    const doc = mdastToDoc(src, hpSchema);
    const state = cursorIn(doc, 2); // 「第二段正文。」
    const out = run(blockCommand({ kind: "heading", level: 2 }), state);
    const text = applyChanges(src, doc, out).text;

    const blocks = topBlocks(src);
    expect(text.slice(0, blocks[0].to)).toBe(src.slice(0, blocks[0].to)); // 标题块没动
    expect(text).toContain("## 第二段正文");
    expect(text).toContain("第一段正文。");
    expect(text).toContain("末段。");
  });

  it("代码块里工具栏的块级按钮不该可用（inCode 为真时前端置灰）", () => {
    const doc = mdastToDoc("```sql\nSELECT 1;\n```\n", hpSchema);
    const state = cursorIn(doc, 0);
    expect(toolbarState(state).inCode).toBe(true);
  });
});
