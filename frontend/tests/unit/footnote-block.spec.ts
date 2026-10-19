import { describe, expect, it } from "vitest";
import { footnoteRefLabel, joinFootnoteDef, splitFootnoteDef } from "../../src/kernel/pm/footnoteBlock";

/**
 * 136-B 的地基：脚注定义块「拆得开、拼得回一字不差」。
 *
 * 编辑模式的回写是**按块拼原文**，所以只要这条往返性质成立，
 * "只改她动过的那一块"（Q27 她定的口径）就是构造性保证的，不靠事后 diff 兜。
 * 反过来这条一断，整个脚注编辑就会在她看不见的地方改她的文件 —— 所以形态要铺满。
 */
describe("footnoteBlock：定义块拆开 / 拼回", () => {
  const RAW = [
    "[^a]: 一行内容",
    "[^b]: 含**粗体**与 `代码`",
    "[^c]: 第一行\n  两格缩进的续行",
    "[^d]: 第一行\n    四格缩进的续行",
    "[^e]: 第一行\n\t制表符缩进的续行",
    "[^f]: 第一行\n  第二行\n\n  中间夹一个空行再续",
    "[^Note_1]: 标识符大小写与下划线都要原样保留",
    "[^g]:",
    "[^h]: ",
    "[^i]: 末尾有空格 \n  续行",
    "[^j]: 多段\n\n  第二段整体缩进两格\n  还在第二段里",
    "[^k]:   冒号后三个空格",
  ];

  it("每一种形态都能拆，拆完能一字不差拼回", () => {
    for (const raw of RAW) {
      const parts = splitFootnoteDef(raw);
      expect(parts, `拆不开：${JSON.stringify(raw)}`).not.toBeNull();
      expect(joinFootnoteDef(parts!), `拼回不一致：${JSON.stringify(raw)}`).toBe(raw);
    }
  });

  it("正文里不含标记、冒号后空白与续行缩进（她看到的就是能改的那部分）", () => {
    const p = splitFootnoteDef("[^c]: 第一行\n  两格缩进的续行")!;
    expect(p.label).toBe("c");
    expect(p.gap).toBe(" ");
    expect(p.indent).toBe("  ");
    expect(p.body).toBe("第一行\n两格缩进的续行");
  });

  it("空正文与只有空格的正文都不丢字符", () => {
    expect(joinFootnoteDef(splitFootnoteDef("[^g]:")!)).toBe("[^g]:");
    expect(joinFootnoteDef(splitFootnoteDef("[^h]: ")!)).toBe("[^h]: ");
    expect(joinFootnoteDef(splitFootnoteDef("[^k]:   冒号后三个空格")!)).toBe("[^k]:   冒号后三个空格");
  });

  it("不是脚注定义的输入返回 null（调用方要能回落成不透明块）", () => {
    for (const bad of ["普通段落", "- 列表项", "```ts\nx\n```", "[^] 空标识符", "[a]: 不是脚注"]) {
      expect(splitFootnoteDef(bad), bad).toBeNull();
    }
  });

  it("改正文之后按原文缩进拼回（她没碰缩进，我们就不动缩进）", () => {
    const p = splitFootnoteDef("[^c]: 第一行\n  两格缩进的续行")!;
    p.body = "改过的第一行\n改过的续行";
    expect(joinFootnoteDef(p)).toBe("[^c]: 改过的第一行\n  改过的续行");
  });

  it("**把冒号后的空格删掉也不会把语法弄坏**（拼回时兜一个空格）", () => {
    const p = splitFootnoteDef("[^a]: 一行内容")!;
    p.gap = "";
    expect(joinFootnoteDef(p)).toBe("[^a]: 一行内容");
    // 空正文例外：`[^a]:` 本来就合法，不该被塞进多余空格
    const q = splitFootnoteDef("[^g]:")!;
    q.gap = "";
    expect(joinFootnoteDef(q)).toBe("[^g]:");
  });
});

describe("footnoteBlock：行内引用", () => {
  it("取 label，带空白的也算", () => {
    expect(footnoteRefLabel("[^a]")).toBe("a");
    expect(footnoteRefLabel(" [^Note_1] ")).toBe("Note_1");
  });
  it("不是引用时返回 null", () => {
    expect(footnoteRefLabel("[^a] 后面还有字")).toBeNull();
    expect(footnoteRefLabel("[^]")).toBeNull();
    expect(footnoteRefLabel("[^a]: 定义")).toBeNull();
  });
});
