import { describe, expect, it } from "vitest";
import {
  joinInlineMath,
  joinMathBlock,
  splitInlineMath,
  splitMathBlock,
} from "../../src/kernel/pm/mathBlock";
import { topBlocks } from "../../src/kernel/blockPatch";
import { parseMd } from "../../src/kernel/md";

/**
 * 138-B 的地基：公式「拆得开、拼得回一字不差」。
 *
 * 与 136-B 脚注同一套路 —— 编辑模式的回写是**按块拼原文**，
 * 只要这条往返性质成立，「只改动过的那一块」就是构造性保证的，不靠事后 diff 兜。
 * 反过来这条一断，公式编辑就会在肉眼看不见的地方改盘上那份文件（`$$` 变 `$`、缩进丢、
 * 反斜杠少一根都算），所以形态要铺满。
 *
 * 拆出来的形状是 `{ before, value, after }`：`before` = 定界符 + 它后面那段空白，
 * `after` = 定界符前面那段空白 + 定界符 + 行尾空白。
 * **两侧空白归骨架**，可改的只有 `value` —— 这样拼回去永远是原串，
 * 也解释了为什么"空正文"那种形态必须由同一条规则处理（空白全进 before，after 只剩定界符）。
 */

const BLOCK_RAW = [
  "$$\nx\n$$",
  "$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$",
  "$$  \nx\n  $$", // 定界符后面有尾随空格
  "$$\n\n$$", // 空正文
  "$$$\nx\n$$$", // 三个定界符
  "$$\r\nx\r\n$$", // CRLF
  "$$\na $ b\n$$", // 正文里带单个 $
  "$$\n  缩进两格的正文\n$$",
  "$$x$$", // 单行写法（remark 会把它当**行内**，这里仍然要能拼回去）
  "$$  x  $$",
];

const INLINE_RAW = ["$x$", "$E=mc^2$", "$ a $", "$$$x$$$", "$a\\$b$", "$\\text{单价 \\$5}$"];

describe("splitMathBlock / joinMathBlock", () => {
  it("每一种形态都能拆，拆完一字不差拼回", () => {
    for (const raw of BLOCK_RAW) {
      const parts = splitMathBlock(raw);
      expect(parts, `拆不开：${JSON.stringify(raw)}`).not.toBeNull();
      if (!parts) continue;
      expect(joinMathBlock(parts), `拼回去变了：${JSON.stringify(raw)}`).toBe(raw);
    }
  });

  it("正文就是 LaTeX 本体；定界符两侧的空白留在骨架里", () => {
    const p = splitMathBlock("$$  \nx = 1\n  $$");
    expect(p?.value).toBe("x = 1");
    expect(p?.before).toBe("$$  \n");
    expect(p?.after).toBe("\n  $$");
  });

  it("空正文按同一条规则拆：空白全进 before，after 只剩定界符", () => {
    const p = splitMathBlock("$$\n\n$$");
    expect(p?.value).toBe("");
    expect(joinMathBlock(p!)).toBe("$$\n\n$$");
  });

  it("定界符长度不配对、根本不是公式的都不认（宁可回落成不可编辑，也不能猜）", () => {
    expect(splitMathBlock("$$x$$$")).toBeNull();
    expect(splitMathBlock("x = 1")).toBeNull();
    expect(splitMathBlock("$x$")).toBeNull(); // 单定界符是行内，不是块
    expect(splitMathBlock("$$")).toBeNull(); // 手滑的两个美元符：开与闭是同一段，不成块
  });

  it("正文里的单个 `$` 不许被当成结束定界符", () => {
    const p = splitMathBlock("$$\na $ b\n$$");
    expect(p?.value).toBe("a $ b");
    expect(joinMathBlock(p!)).toBe("$$\na $ b\n$$");
  });
});

describe("splitInlineMath / joinInlineMath", () => {
  it("每一种形态都能拆，拆完一字不差拼回", () => {
    for (const raw of INLINE_RAW) {
      const parts = splitInlineMath(raw);
      expect(parts, `拆不开：${JSON.stringify(raw)}`).not.toBeNull();
      if (!parts) continue;
      expect(joinInlineMath(parts), `拼回去变了：${JSON.stringify(raw)}`).toBe(raw);
    }
  });

  it("长度不配对 / 没有成对定界符都不认", () => {
    expect(splitInlineMath("$x$$")).toBeNull();
    expect(splitInlineMath("x")).toBeNull();
    expect(splitInlineMath("$$")).toBeNull();
  });

  it("块级与行内的判据互斥：`$$x$$` 只有块级那条会认成两格定界", () => {
    expect(splitMathBlock("$$x$$")?.value).toBe("x");
    // 行内也认（remark 就是这么解析的），但拆出来的定界符是两格，拼回去还是两格
    expect(splitInlineMath("$$x$$")?.value).toBe("x");
    expect(joinInlineMath(splitInlineMath("$$x$$")!)).toBe("$$x$$");
  });
});

/**
 * 上面那些 raw 是我手写的。**还必须是真解析出来的形状**，
 * 否则测的是我对 remark 的想象。这条就从源区间里把每个公式节点的原文切出来，
 * 逐个跑一遍拆/拼 —— 这才是"盘上那份文件里真的会长这样"的那一份。
 */
describe("真实解析出的公式原文", () => {
  const DOC = [
    "行内一句 $E=mc^2$ 与 $a_{i,j} \\ne b$ 混排，还有 **粗** 里的 $x$。",
    "",
    "$$",
    "x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}",
    "$$",
    "",
    "单行块：$$y = 2x + 1$$",
    "",
    "$$$",
    "三定界 \\alpha",
    "$$$",
    "",
    "末尾一句 $z$。",
    "",
  ].join("\n");

  it("从源区间切出来的每一份原文都能拆拼回去（块级与行内都算）", () => {
    const ast = parseMd(DOC);
    const 形状: Array<{ type: string; raw: string }> = [];
    const walk = (n: unknown) => {
      const node = n as {
        type?: string;
        position?: { start?: { offset?: number }; end?: { offset?: number } };
        children?: unknown[];
      };
      if (node.type === "math" || node.type === "inlineMath") {
        const a = node.position?.start?.offset;
        const b = node.position?.end?.offset;
        if (typeof a === "number" && typeof b === "number") 形状.push({ type: node.type, raw: DOC.slice(a, b) });
      }
      (node.children ?? []).forEach(walk);
    };
    walk(ast);
    // 夹具里 7 处（行内 4 + 块级 2 + 单行 `$$…$$` 被 remark 判成行内 1）。
    // 数不对说明 remark 的解析形状变了，先看这条红再改代码。
    expect(形状.map((s) => s.type)).toEqual([
      "inlineMath",
      "inlineMath",
      "inlineMath",
      "math",
      "inlineMath",
      "math",
      "inlineMath",
    ]);
    for (const { type, raw } of 形状) {
      const split = type === "math" ? splitMathBlock(raw) : splitInlineMath(raw);
      expect(split, `「${type}」拆不开：${JSON.stringify(raw)}`).not.toBeNull();
      const joined = type === "math" ? joinMathBlock(split!) : joinInlineMath(split!);
      expect(joined, `「${type}」拼回去变了：${JSON.stringify(raw)}`).toBe(raw);
    }
  });

  it("顶层块区间覆盖块级公式（103 的源区间前提）", () => {
    const blocks = topBlocks(DOC);
    expect(
      blocks.some((b) => DOC.slice(b.from, b.to) === "$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$")
    ).toBe(true);
  });
});
