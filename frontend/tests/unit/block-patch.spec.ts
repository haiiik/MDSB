import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../../src/kernel/md";
import { patch, serializeBlock, topBlocks } from "../../src/kernel/blockPatch";

/**
 * 101 保真拼接接缝。
 *
 * 靶心是**局部性**：被点名的块之外，一个字节都不许动。
 * 整篇序列化的规范化（表格补齐列宽、`***`→`---`、`&amp;`→`&`）在这里全部不构成风险，
 * 因为没被点名的块根本不进序列化器。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures");
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".md") && !f.endsWith(".roundtrip.md"))
  .sort();

describe("夹具目录", () => {
  it("至少 5 份夹具，防止目录被清空后静默全绿", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });
});

describe.each(fixtures)("blockPatch %s", (name) => {
  const source = readFileSync(join(fixtureDir, name), "utf8");
  const blocks = topBlocks(source);

  it("恒等：不点名任何块时逐字节返回原文", () => {
    expect(patch(source, [])).toBe(source);
  });

  it("topBlocks 的区间能 slice 出对应原文，且结构与整篇 AST 一致", () => {
    const ast = parseMd(source);
    expect(blocks.length).toBe(ast.children.length);
    blocks.forEach((b, i) => {
      const sliced = source.slice(b.from, b.to);
      expect(parseMd(sliced).children).toHaveLength(1);
      // 结构等价：比较去掉 position 后的树
      expect(strip(b.node)).toEqual(strip(ast.children[i]));
    });
  });

  it.each(blocks.map((_, i) => [i, blocks.length]) as [number, number][])(
    "替换第 %i 块后，该块之外逐字节不变（共 %i 块）",
    (i) => {
      const b = blocks[i];
      const next = patch(source, [{ from: b.from, to: b.to, md: serializeBlock(b.node) + " 追加" }]);
      expect(next.slice(0, b.from)).toBe(source.slice(0, b.from));
      expect(next.slice(next.length - (source.length - b.to))).toBe(source.slice(b.to));
    },
  );

  it("同时替换两块：只有这两块区间变化", () => {
    if (blocks.length < 2) return;
    const a = blocks[0];
    const z = blocks[blocks.length - 1];
    const next = patch(source, [
      { from: a.from, to: a.to, md: "第一块被改写" },
      { from: z.from, to: z.to, md: "最后一块被改写" },
    ]);
    expect(next.startsWith(source.slice(0, a.from))).toBe(true);
    expect(next.endsWith(source.slice(z.to))).toBe(true);
    expect(next).toContain("第一块被改写");
    expect(next).toContain("最后一块被改写");
  });
});

describe("空白与行尾（夹具覆盖不到的部分）", () => {
  const spaced = "# 标题\n\n\n\n段落一\n\n\n- 列表 a\n- 列表 b\n\n\n末段\n\n\n";

  it("块间空行不被规范化：三个空行还是三个空行", () => {
    const blocks = topBlocks(spaced);
    const para = blocks.find((b) => source_startsWith(spaced, b.from, "段落一"))!;
    const next = patch(spaced, [{ from: para.from, to: para.to, md: "段落一改过了" }]);
    expect(next).toBe("# 标题\n\n\n\n段落一改过了\n\n\n- 列表 a\n- 列表 b\n\n\n末段\n\n\n");
  });

  it("文件末尾换行数量不变", () => {
    const blocks = topBlocks(spaced);
    const last = blocks[blocks.length - 1];
    const next = patch(spaced, [{ from: last.from, to: last.to, md: "末段改过了" }]);
    expect(next.endsWith("改过了\n\n\n")).toBe(true);
  });

  it("CRLF 文件：块外保持 CRLF，新内容按文件行尾风格写出", () => {
    const crlf = "# 标题\r\n\r\n段落一\r\n\r\n段落二\r\n";
    const blocks = topBlocks(crlf);
    const target = blocks.find((b) => source_startsWith(crlf, b.from, "段落一"))!;
    const next = patch(crlf, [{ from: target.from, to: target.to, md: "多\r\n行\r\n新内容" }]);
    // 块外逐字节不变
    expect(next.slice(0, target.from)).toBe(crlf.slice(0, target.from));
    expect(next.slice(next.length - (crlf.length - target.to))).toBe(crlf.slice(target.to));
    // 不出现混入的裸 LF
    expect(next.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  it("LF 文件不引入 CR", () => {
    const lf = "段落一\n\n段落二\n";
    const blocks = topBlocks(lf);
    const next = patch(lf, [{ from: blocks[0].from, to: blocks[0].to, md: "改过\n两行" }]);
    expect(next).not.toContain("\r");
  });

  it("区间重叠或越界要报错，不能静默产出坏文本", () => {
    const src = "段落一\n\n段落二\n";
    const b = topBlocks(src);
    expect(() =>
      patch(src, [
        { from: b[0].from, to: b[1].to, md: "x" },
        { from: b[1].from, to: b[1].to, md: "y" },
      ]),
    ).toThrow();
    expect(() => patch(src, [{ from: 0, to: src.length + 10, md: "x" }])).toThrow();
    expect(() => patch(src, [{ from: 5, to: 3, md: "x" }])).toThrow();
  });
});

describe("负对照：证明上面的局部性断言真的会咬人", () => {
  // 这些夹具存在 `<同名>.roundtrip.md`，即「整篇往返必然漂移」的已知样本。
  // 如果谁把 patch 实现成整篇 serializeMd，下面这条就会红，从而暴露：
  // 未被点名的区间也被改了。
  const drifting = fixtures
    .map((name) => {
      const src = readFileSync(join(fixtureDir, name), "utf8");
      return { name, src, whole: serializeMd(parseMd(src)).replace(/\n+$/, "") + "\n" };
    })
    .filter((f) => f.whole !== f.src);

  it("至少一份夹具在整篇序列化后会漂移（否则本文件所有断言都是空的）", () => {
    expect(drifting.length).toBeGreaterThanOrEqual(1);
  });

  it("漂移确实发生在「没被点名的块」上：整篇做法违反局部性", () => {
    // 对每份漂移夹具，只点名第一块，看第一块之外的内容是否被整篇做法改掉。
    // 只要有夹具是「块外也被改」，就证明本文件的块外断言不是空转。
    const outsideDrift = drifting.filter((f) => {
      const first = topBlocks(f.src)[0];
      const tailOf = (s: string) => s.slice(s.length - (f.src.length - first.to));
      return tailOf(f.whole) !== f.src.slice(first.to);
    });
    expect(outsideDrift.length).toBeGreaterThanOrEqual(1);
    for (const f of outsideDrift) {
      const first = topBlocks(f.src)[0];
      const byBlock = patch(f.src, [{ from: first.from, to: first.to, md: serializeBlock(first.node) }]);
      expect(byBlock.slice(byBlock.length - (f.src.length - first.to))).toBe(f.src.slice(first.to));
    }
  });
});

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "position") continue;
      out[k] = strip(v);
    }
    return out;
  }
  return node;
}

function source_startsWith(source: string, from: number, text: string): boolean {
  return source.slice(from, from + text.length) === text;
}

// serializeMd 仍在断言范围内：确认 serializeBlock 与整篇序列化对同一棵树口径一致
void serializeMd;
