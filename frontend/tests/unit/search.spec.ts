import { describe, expect, it } from "vitest";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { docTextOf } from "../../src/kernel/pm/searchHighlight";
import {
  advance,
  advanceNear,
  findMatches,
  formatCount,
  InvalidPatternError,
  isWholeWord,
  type SearchOptions,
} from "../../src/kernel/search";

/**
 * 118：查找判据。三模式共用这一份语义，所以这里的每条断言都是**三种模式共同的验收线**。
 */

const off: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };
const on = (o: Partial<SearchOptions>): SearchOptions => ({ ...off, ...o });
const spans = (text: string, query: string, o: SearchOptions = off) =>
  findMatches(text, query, o).map((m) => text.slice(m.from, m.to));

describe("基本匹配", () => {
  it("中文关键词按字面命中，出现几次算几次", () => {
    const text = "指标口径已对齐，指标需要单独看板。\n再看指标。";
    expect(spans(text, "指标")).toHaveLength(3);
    expect(findMatches(text, "指标", off)[0]).toEqual({ from: 0, to: 2 });
  });

  it("空查询 = 零命中（不是「全匹配」）", () => {
    expect(findMatches("随便什么", "", off)).toEqual([]);
  });

  it("不重叠、从左到右", () => {
    expect(spans("aaaa", "aa")).toEqual(["aa", "aa"]);
    expect(findMatches("aaaa", "aa", off).map((m) => m.from)).toEqual([0, 2]);
  });

  it("含 Markdown 标记的关键词按字面匹配，不当正则", () => {
    const text = "这里是**加粗**与*斜体*。";
    expect(spans(text, "**加粗**")).toEqual(["**加粗**"]);
    // 括号/星号是字面量而不是量词：这一条若走正则就会 0 命中
    expect(spans(text, "(a*)")).toEqual([]);
  });
});

describe("大小写", () => {
  it("默认不敏感；开了之后只认同一种写法", () => {
    const text = "Ctrl+C Ctrl+c CTRL+C";
    expect(spans(text, "ctrl+c")).toHaveLength(3); // 三种写法都算命中（大小写不敏感）
    expect(spans(text, "ctrl+c", on({ caseSensitive: true }))).toEqual([]);
    expect(spans(text, "Ctrl+C", on({ caseSensitive: true }))).toHaveLength(1);
  });
});

describe("全词", () => {
  it("英文：avg 在 avgx 里是词内出现，全词时不算", () => {
    expect(spans("avg in avgx", "avg")).toHaveLength(2);
    expect(spans("avg in avgx", "avg", on({ wholeWord: true }))).toEqual(["avg"]);
  });

  it("中文：词字符含汉字，所以「指标」在「指标口径」里不算全词", () => {
    expect(spans("指标口径", "指标", on({ wholeWord: true }))).toEqual([]);
    // 独立成段才算（前后是标点/边界）
    expect(spans("看：指标。", "指标", on({ wholeWord: true }))).toEqual(["指标"]);
  });

  it("isWholeWord 只看两侧是不是词字符", () => {
    expect(isWholeWord("a_b", 0, 1)).toBe(false); // 后面是 _（词字符）
    expect(isWholeWord("a-b", 0, 1)).toBe(true);
    expect(isWholeWord("中", 0, 1)).toBe(true); // 两端是边界
  });
});

describe("正则", () => {
  it("正则模式下表达式生效", () => {
    const text = "a1 b22 c333";
    expect(spans(text, "[a-z]\\d+", on({ regex: true }))).toEqual(["a1", "b22", "c333"]);
  });

  it("非法表达式抛 InvalidPatternError（调用方要提示且不清空输入）", () => {
    expect(() => findMatches("x", "(未闭合", on({ regex: true }))).toThrow(InvalidPatternError);
  });

  it("零宽匹配不会死循环，也不计入命中", () => {
    expect(spans("abc", "x*", on({ regex: true }))).toEqual([]);
    expect(spans("abc", "b?", on({ regex: true }))).toEqual(["b"]);
  });

  it("正则 + 全词 一起开时按同一套词字符判定", () => {
    expect(spans("avg average", "av\\w+", on({ regex: true, wholeWord: true }))).toEqual(["avg", "average"]);
    expect(spans("avgx average", "av\\w", on({ regex: true, wholeWord: true }))).toEqual([]);
  });
});

describe("跳转与计数", () => {
  it("末项再点下一个回到首项，首项点上一个到末项", () => {
    expect(advance(3, 2, 1)).toBe(0);
    expect(advance(3, 0, -1)).toBe(2);
    expect(advance(3, 1, 1)).toBe(2);
  });

  it("没有命中时索引是 -1，不越界", () => {
    expect(advance(0, -1, 1)).toBe(-1);
    expect(advance(0, 0, -1)).toBe(-1);
  });

  it("还没定位过时：点下一个从第一项开始，点上一个绕到最后一项", () => {
    expect(advance(3, -1, 1)).toBe(0);
    expect(advance(3, -1, -1)).toBe(2);
  });

  it("计数文案是「第几 / 共几」，1 起算", () => {
    expect(formatCount(12, 2)).toBe("3 / 12");
    expect(formatCount(0, -1)).toBe("0 / 0");
  });

  /**
   * 146：「查找使用中，编辑导致丢掉了当前目标，点上下箭头时自动定位上下位置，不要回到首个」。
   * 索引在丢目标之后不代表任何位置，起点必须是**光标在文本里的偏移**。
   */
  describe("146：按光标位置推进（advanceNear）", () => {
    const 三处 = [
      { from: 5, to: 8 },
      { from: 40, to: 43 },
      { from: 90, to: 93 },
    ];

    it("站在第二处里按 ↓ → 第三处（不是回到第一处）", () => {
      expect(advanceNear(三处, 41, 1)).toBe(2);
    });

    it("站在第二处里按 ↑ → 第一处", () => {
      expect(advanceNear(三处, 41, -1)).toBe(0);
    });

    it("光标正落在某一处的起点上：按 ↑ 回上一处而不是原地不动（原地不动像按钮坏了）", () => {
      expect(advanceNear(三处, 40, -1)).toBe(0);
      expect(advanceNear(三处, 40, 1)).toBe(2);
    });

    it("后面没有就循环回第一处，前面没有就绕到最后一处", () => {
      expect(advanceNear(三处, 95, 1)).toBe(0);
      expect(advanceNear(三处, 3, -1)).toBe(2);
    });

    it("没有光标可言的档（阅读模式给 null）退回索引推进的老语义", () => {
      expect(advanceNear(三处, null, 1)).toBe(0);
      expect(advanceNear(三处, null, -1)).toBe(2);
    });

    it("没有命中时是 -1，不越界", () => {
      expect(advanceNear([], 10, 1)).toBe(-1);
      expect(advanceNear([], null, -1)).toBe(-1);
    });
  });
});

describe("编辑模式的「字符偏移 ↔ PM 位置」映射（docTextOf）", () => {
  /**
   * 这块是实测踩出来的：不补块分隔符时，「上一块末尾」与「下一块开头」在拼接串里是连着的，
   * 偏移正好落在边界上就分不清属于哪一边 —— 替换最后一段的开头几个字，
   * 位置被判给了前一个块（表格单元格），整段被并进表格里，文件当场写坏。
   */
  const doc = mdastToDoc("甲段\n\n| 指标 | 值 |\n| :--- | --- |\n| 平均 | 12 |\n\n末段不动。\n");
  const { text, posAt } = docTextOf(doc);

  it("块与块之间有分隔符，所以单行查询不可能跨块命中", () => {
    expect(text).toBe("甲段\n指标值平均12\n末段不动。\n");
    expect(text.indexOf("末段不动")).toBeGreaterThan(text.indexOf("12"));
    // 「12末段」这种跨块串在拼接文本里根本不存在
    expect(findMatches(text, "12末段", off)).toEqual([]);
  });

  it("偏移落在块边界上时，归后一块（不是前一块的末尾）", () => {
    const boundary = text.indexOf("末段不动");
    expect(posAt(boundary)).toBeGreaterThan(posAt(boundary - 1));
    // 前一块末尾的 PM 位置与后一块起点的 PM 位置必须不同，否则替换会串块
    expect(posAt(boundary)).not.toBe(posAt(boundary - 1));
  });

  it("映射是单调不减的（替换从后往前做，位置不能倒序）", () => {
    const offsets = [...text].map((_, i) => i).filter((i) => text[i] !== "\n");
    const positions = offsets.map(posAt);
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
  });

});
