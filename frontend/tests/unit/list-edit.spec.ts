import { Fragment, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { patch, topBlocks } from "../../src/kernel/blockPatch";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { applyChanges, changedBlocks } from "../../src/kernel/pm/patches";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 107：列表与任务清单的按块替换行为。
 *
 * 这里把「整块重排会改到什么」**写成断言而不是注释** ——
 * `listItemIndent: "one"` 与 `bullet: "-"` 会重写被编辑列表块的缩进与符号，
 * 这是既定代价，钉住它才能防止以后悄悄变严重。
 */

const kidsOf = (doc: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  doc.forEach((n) => out.push(n));
  return out;
};

/** 模拟点复选框：翻第 i 个顶层块里第 j 个 list_item 的 checked */
function toggleCheckbox(doc: PMNode, blockIndex: number, itemIndex: number): PMNode {
  const blocks = kidsOf(doc);
  const list = blocks[blockIndex];
  const item = list.child(itemIndex);
  const nextItem = list.child(itemIndex).type.create(
    { ...item.attrs, checked: item.attrs.checked !== true },
    item.content,
    item.marks
  );
  const children = kidsOf(list);
  children[itemIndex] = nextItem;
  const nextList = list.copy(Fragment.from(children));
  blocks[blockIndex] = nextList;
  return doc.copy(Fragment.from(blocks));
}

describe("扁平任务清单：勾选只改三个字符", () => {
  const src = "# 待办\n\n- [ ] 指标口径已对齐\n- [ ] 慢单需要单独看板\n- [x] 超时提醒已上线\n\n末段不动。\n";

  it("未编辑时恒等", () => {
    const doc = mdastToDoc(src);
    expect(applyChanges(src, doc, doc).text).toBe(src);
  });

  it("勾第二项 → 落盘与原文只差那一行的 [ ]→[x]", () => {
    const doc = mdastToDoc(src);
    const next = toggleCheckbox(doc, 1, 1);
    const out = applyChanges(src, doc, next).text;
    const expected = src.replace("- [ ] 慢单需要单独看板", "- [x] 慢单需要单独看板");
    expect(out).toBe(expected);
  });

  it("取消勾选同样只动那一行", () => {
    const doc = mdastToDoc(src);
    const next = toggleCheckbox(doc, 1, 2); // 第三项本来是 [x]
    const out = applyChanges(src, doc, next).text;
    expect(out).toBe(src.replace("- [x] 超时提醒已上线", "- [ ] 超时提醒已上线"));
  });

  it("列表块外的标题与末段一个字节不变", () => {
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, toggleCheckbox(doc, 1, 0)).text;
    expect(out.split("\n")[0]).toBe("# 待办");
    expect(out).toContain("末段不动。");
  });
});

describe("整块重排的既定代价（钉住，不许悄悄变严重）", () => {
  it("嵌套列表被编辑：4 空格缩进被 listItemIndent:\"one\" 重排成 2 空格递进", () => {
    const src = "- 一级\n    - 二级\n        - 三级\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, toggleCheckbox(doc, 0, 0)).text;
    // 内容一个不丢
    for (const t of ["一级", "二级", "三级"]) expect(out).toContain(t);
    // 但缩进被规范化（`[x]` 是勾选本身带来的，不算代价）—— 这就是 107 要写进完成记录的代价
    expect(out).toBe("- [x] 一级\n  - 二级\n    - 三级\n");
    expect(out).not.toBe(src);
  });

  it("原文用 2 空格递进的嵌套列表：勾选后缩进一格没动（代价只影响非标准缩进）", () => {
    const src = "- 一级\n  - 二级\n    - 三级\n";
    const doc = mdastToDoc(src);
    const out = applyChanges(src, doc, toggleCheckbox(doc, 0, 0)).text;
    expect(out).toBe(src.replace("- 一级", "- [x] 一级"));
  });

  it("`*` 与 `+` 列表符号被编辑后统一成 `-`（bullet:\"-\"）", () => {
    for (const src of ["* 甲\n* 乙\n", "+ 甲\n+ 乙\n"]) {
      const doc = mdastToDoc(src);
      const blocks = kidsOf(doc);
      const edited = blocks[0].copy(
        Fragment.from([
          hpSchema.nodes.list_item.create(
            null,
            hpSchema.nodes.paragraph.create(null, hpSchema.text("甲改过"))
          ),
          ...kidsOf(blocks[0]).slice(1),
        ])
      );
      const out = applyChanges(src, doc, doc.copy(Fragment.from([edited]))).text;
      expect(out.startsWith("- 甲改过\n- 乙")).toBe(true);
      expect(out).not.toMatch(/^[*+]/);
    }
  });

  it("Q1 口径：`1. 1. 1.` 未编辑时原样，被编辑后统一递增", () => {
    const src = "1. 甲\n1. 乙\n1. 丙\n";
    const doc = mdastToDoc(src);
    // 未编辑 → 逐字节原样
    expect(applyChanges(src, doc, doc).text).toBe(src);
    // 编辑任一项 → 整块统一成 1. 2. 3.
    const blocks = kidsOf(doc);
    const edited = blocks[0].copy(
      Fragment.from([
        hpSchema.nodes.list_item.create(null, hpSchema.nodes.paragraph.create(null, hpSchema.text("甲改过"))),
        ...kidsOf(blocks[0]).slice(1),
      ])
    );
    const out = applyChanges(src, doc, doc.copy(Fragment.from([edited]))).text;
    expect(out).toBe("1. 甲改过\n2. 乙\n3. 丙\n");
  });
});

describe("changedBlocks 对列表的粒度", () => {
  it("改列表里一项 → 只点名那一个列表块", () => {
    const src = "段落\n\n- 甲\n- 乙\n\n另一段\n";
    const doc = mdastToDoc(src);
    const patches = changedBlocks(doc, toggleCheckbox(doc, 1, 0), src);
    expect(patches).toHaveLength(1);
    const listBlock = topBlocks(src)[1];
    expect(patches[0].from).toBe(listBlock.from);
    expect(patches[0].to).toBe(listBlock.to);
  });

  it("两个列表块只改其中一个 → 另一个不进 patch", () => {
    const src = "- 甲组\n- 乙组\n\n段落\n\n- 丙组\n- 丁组\n";
    const doc = mdastToDoc(src);
    const patches = changedBlocks(doc, toggleCheckbox(doc, 0, 0), src);
    expect(patches).toHaveLength(1);
    const out = patch(src, patches);
    const second = topBlocks(src)[2];
    expect(out.slice(out.length - (src.length - second.to))).toBe(src.slice(second.to));
  });
});
