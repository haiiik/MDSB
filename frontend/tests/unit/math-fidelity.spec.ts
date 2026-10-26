import { describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../../src/kernel/md";

/**
 * 138：公式进出的字节账（整篇往返这一半）。
 *
 * 产品链路永远走「按块拼原文」（101/104），所以**没编辑过的块一个字节都不动**才是硬要求，
 * 那条记在 `fidelity-matrix.spec.ts` 的 138 恒等行里。
 * 这个文件只管另一件事：**整篇 `serializeMd(parseMd(x))` 到底会把什么规范化掉**。
 * 把它单独钉住是为了以后有人看到"`$$E=mc^2$$` 变成 `$E=mc^2$`"时能立刻查到
 * 这是 remark 的既定行为、且只存在于这个测试工具视角，而不是跑去找产品代码的错。
 */

describe("公式的整篇往返", () => {
  it("块级 `$$\\n…\\n$$` 逐字节回来（含反斜杠与前后空行）", () => {
    const SRC = ["前置段落。", "", "$$", "x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", "$$", "", "后置段落。", ""].join("\n");
    expect(serializeMd(parseMd(SRC))).toBe(SRC);
  });

  it("行内 `$…$` 逐字节回来，与粗体 / 代码混排也一样", () => {
    const SRC = "质能方程 $E=mc^2$ 与**粗体**里的 $\\alpha$，还有 `code` 一段。\n";
    expect(serializeMd(parseMd(SRC))).toBe(SRC);
  });

  it("公式源码里的下划线与反斜杠命令不被当成斜体或转义吃掉", () => {
    const SRC = "带下标的那句：$a_{i,j} \\ne b$ 收尾。\n";
    expect(serializeMd(parseMd(SRC))).toBe(SRC);
  });

  /**
   * **记录性断言**（不是"希望如此"）：单行双定界符 `$$E=mc^2$$` 会被 remark 解析成**行内**公式，
   * 整篇序列化时规范成 `$E=mc^2$`。
   * 产品按块拼原文，没碰过那一行就还是原样 —— 所以这条红了不代表盘上那份文件被改了。
   */
  it("已知规范化：单行 `$$…$$` 会被规范成 `$…$`", () => {
    const SRC = "质能方程：$$E=mc^2$$ 收尾。\n";
    expect(serializeMd(parseMd(SRC))).toBe("质能方程：$E=mc^2$ 收尾。\n");
  });

  it("没有定界符的普通文本一个字节都不动（打开公式解析不该波及全文）", () => {
    const SRC = "# 普通文档\n\n一段不含公式的文字：价格 5 元、间距 3 px。\n\n- 列表项甲\n- 列表项乙\n";
    expect(serializeMd(parseMd(SRC))).toBe(SRC);
  });
});
