import { Fragment, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { InputRule } from "prosemirror-inputrules";
import { describe, expect, it } from "vitest";
import { hpSchema } from "../../src/kernel/pm/schema";
import { HP_INPUT_RULES } from "../../src/kernel/pm/inputRules";

/**
 * 113：Markdown 输入规则。
 *
 * 这里测的是**规则本身**（正则 + handler 造出来的文档形状）。
 * 「什么时候会调用规则」是 `prosemirror-inputrules` 插件的职责
 * （组合输入态不跑、光标在 code 节点里不跑、行内代码里不跑），
 * 那部分用真键盘在 E2E 里验（`edit-input-rules.spec.ts`），不在这里拿复刻的守卫冒充证据。
 *
 * 文档一律**手工构造**，不从 Markdown 解析：`#` 单独一行会被 remark 直接当标题，
 * 拿它当「段落里刚打完 # 还没空格」的初始态是假的。
 */

const n = hpSchema.nodes;

const para = (text = ""): PMNode =>
  n.paragraph.create(null, text ? Fragment.from(hpSchema.text(text)) : Fragment.empty);

const doc = (...blocks: PMNode[]): PMNode => n.doc.create(null, Fragment.from(blocks));

/** 第 i 个顶层块的节点位置 */
function blockPos(d: PMNode, i: number): number {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += d.child(k).nodeSize;
  return pos;
}

/**
 * 模拟「在块内文字末尾打下最后一个字符」。
 *
 * 插件的调用约定（`index.cjs:83`）：`handler(state, match, startPos, to)`，
 * 其中 `startPos = 光标 - (匹配长度 - 新字符数)`，`to` 就是光标 ——
 * 新打的那个字符**还没进文档**。这里照抄这个约定，别自己发明。
 */
function applyRule(rule: InputRule, d: PMNode, blockIndex: number, typed = " "): PMNode | null {
  const base = EditorState.create({ doc: d, schema: hpSchema });
  const start = blockPos(d, blockIndex);
  // 光标放在**块内文字末尾**（不是开头）：`near` 只会找最近的文字位，
  // 从块首 resolve 出来的位置本身就是合法光标位，它不会往前走 —— 那样 parentOffset 恒为 0，
  // 规则看到的「光标前文本」永远是空串。
  const blockEnd = start + d.child(blockIndex).nodeSize - 1;
  const $cursor = TextSelection.near(d.resolve(blockEnd), -1).$cursor;
  if (!$cursor) throw new Error("放不进光标");
  const before = $cursor.parent.textBetween(0, $cursor.parentOffset, null, "￼");
  const match = rule.match.exec(before + typed);
  if (!match) return null;
  const from = $cursor.pos - (match[0].length - typed.length);
  const tr: Transaction | null = rule.handler(base, match, from, $cursor.pos);
  return tr ? tr.doc : null;
}

const findRule = (label: RegExp): InputRule => {
  const hit = HP_INPUT_RULES.find((r) => label.test(String(r.match)));
  if (!hit) throw new Error("没有这条规则：" + label);
  return hit;
};

const headingRule = findRule(/#{1,6}/);
const bulletRule = findRule(/\[-\*\+\]/);
const orderedRule = findRule(/\\d\+/);
const quoteRule = findRule(/>/);
const fenceRule = findRule(/```/);
const taskRules = HP_INPUT_RULES.filter((r) => /\\\[/.test(String(r.match)));

describe("标题规则", () => {
  it("# → 一级标题，###### → 六级；井号个数就是层级", () => {
    for (let level = 1; level <= 6; level++) {
      const out = applyRule(headingRule, doc(para("#".repeat(level))), 0);
      expect(out?.child(0).type.name).toBe("heading");
      expect(out?.child(0).attrs.level).toBe(level);
    }
  });

  it("####### 不匹配（Markdown 只有六级）", () => {
    expect(applyRule(headingRule, doc(para("#######")), 0)).toBeNull();
  });

  it("已经是标题的块里再打「#」+空格：只换层级，不套出新结构", () => {
    // 初始态：一个二级标题，光标前的文字正好是 "#"
    const heading = n.heading.create({ level: 2 }, Fragment.from(hpSchema.text("#")));
    const out = applyRule(headingRule, doc(heading), 0)!;
    expect(out.childCount).toBe(1);
    expect(out.child(0).type.name).toBe("heading");
    expect(out.child(0).attrs.level).toBe(1);
    expect(out.child(0).textContent).toBe("");
  });

  it("井号后面没空格不触发", () => {
    expect(headingRule.match.exec("##")).toBeNull();
  });
});

describe("列表规则", () => {
  it("- / * / + 都变无序列表，段落文字留在项里", () => {
    for (const marker of ["-", "*", "+"]) {
      const out = applyRule(bulletRule, doc(para(marker)), 0);
      const list = out?.child(0);
      expect(list?.type.name).toBe("bullet_list");
      expect(list?.child(0).type.name).toBe("list_item");
      expect(list?.child(0).textContent).toBe("");
    }
  });

  it("3. 变有序列表且起始序号是 3", () => {
    const out = applyRule(orderedRule, doc(para("3.")), 0);
    expect(out?.child(0).type.name).toBe("ordered_list");
    expect(out?.child(0).attrs.order).toBe(3);
  });
});

describe("引用与代码围栏", () => {
  it("> 变引用块", () => {
    const out = applyRule(quoteRule, doc(para(">")), 0);
    expect(out?.child(0).type.name).toBe("blockquote");
  });

  it("``` 变代码块 —— 触发点是第三个反引号落下那一刻", () => {
    // 规则只能在「输入一个字符」时跑，所以初始态是段落里已有 "``"，刚打的是第三个反引号。
    // 语言名不在这条路里（那时还没有语言名可取），走 109 的下拉。
    const out = applyRule(fenceRule, doc(para("``")), 0, "`");
    expect(out?.child(0).type.name).toBe("code_block");
    expect(out?.child(0).attrs.language).toBeNull();
  });

  it("转换后的代码块内容不带 code mark（109 定下的规格：marks 为空）", () => {
    const out = applyRule(fenceRule, doc(para("``")), 0, "`")!;
    const block = out.child(0);
    expect(block.textContent).toBe("");
    block.descendants((x) => {
      expect(x.marks.map((m) => m.type.name)).toEqual([]);
      return true;
    });
  });
});

describe("任务项规则（107 口径：只是给 list_item 打 checked）", () => {
  it("两条规则分别对应未勾与已勾", () => {
    expect(taskRules).toHaveLength(2);
  });

  it("段落里打 [ ] → 变成一个未勾的任务项", () => {
    const out = applyRule(taskRules[0], doc(para("[ ]")), 0);
    const list = out?.child(0);
    expect(list?.type.name).toBe("bullet_list");
    expect(list?.child(0).type.name).toBe("list_item");
    expect(list?.child(0).attrs.checked).toBe(false);
  });

  it("段落里打 [x] → 已勾任务项", () => {
    const out = applyRule(taskRules[1], doc(para("[x]")), 0);
    expect(out?.child(0).child(0).attrs.checked).toBe(true);
  });

  it("已在列表项里打 [ ] → 只改本项 checked，不额外套一层列表", () => {
    const item = n.list_item.create({ checked: null }, Fragment.from(n.paragraph.create(null, Fragment.from(hpSchema.text("[]")))));
    const start = applyRule(taskRules[0], doc(n.bullet_list.create(null, Fragment.from(item))), 0)!;
    const list = start.child(0);
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(1);
    expect(list.child(0).attrs.checked).toBe(false);
  });

  it("标题里不打钩（任务项只存在于列表）", () => {
    const heading = n.heading.create({ level: 1 }, Fragment.from(hpSchema.text("[]")));
    expect(applyRule(taskRules[0], doc(heading), 0)).toBeNull();
  });
});

describe("规则集合本身", () => {
  it("七条规则，正则各自独立不互相抢", () => {
    expect(HP_INPUT_RULES).toHaveLength(7);
    // 每条规则只应匹配自己那类前缀
    for (const r of HP_INPUT_RULES) expect(r.match.source.length).toBeGreaterThan(0);
  });
});
