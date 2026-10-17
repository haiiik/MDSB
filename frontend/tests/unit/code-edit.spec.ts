import { Fragment, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { serializeBlock, topBlocks } from "../../src/kernel/blockPatch";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { applyChanges } from "../../src/kernel/pm/patches";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 109：围栏代码块的保真关键路径。
 *
 * 这些数字/形态不是推测出来的：先用一份临时探针脚本跑出真实结果，
 * 再把结论固化成断言（探针已删除，不留仓库）。
 */

const kids = (n: PMNode): PMNode[] => {
  const o: PMNode[] = [];
  n.forEach((c) => o.push(c));
  return o;
};

describe("围栏升级与内容保真", () => {
  it("代码内容含三反引号 → 外层围栏升级为四个反引号", () => {
    const src = "````markdown\n```text\n这行在代码块内部\n```\n````\n";
    const blocks = topBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(serializeBlock(blocks[0].node)).toBe("````markdown\n```text\n这行在代码块内部\n```\n````");
  });

  it("编辑含三反引号的代码块后重开，不被截断且语言标注还在", () => {
    const src = "````markdown\n```text\n原始\n```\n````\n";
    const doc = mdastToDoc(src);
    const cb = kids(doc)[0];
    const edited = cb.type.create(
      cb.attrs,
      hpSchema.text("```\n改过的代码\n```", cb.child(0)?.marks ?? [])
    );
    const out = applyChanges(src, doc, doc.copy(Fragment.from([edited]))).text;
    const re = topBlocks(out);
    expect(re).toHaveLength(1);
    expect((re[0].node as { lang?: string }).lang).toBe("markdown");
    expect((re[0].node as { value?: string }).value).toBe("```\n改过的代码\n```");
  });

  it("未知语言标注原样保留（不吞、不改写成 text）", () => {
    const src = "```klingon\npH\n```\n";
    const blocks = topBlocks(src);
    expect(serializeBlock(blocks[0].node)).toBe("```klingon\npH\n```");
  });

  it("空代码块 / 只有一个反引号 / 两个反引号都不产生破损围栏", () => {
    for (const [src, expectValue] of [
      ["```\n```\n", ""],
      ["```\n`\n```\n", "`"],
      ["```\n``\n```\n", "``"],
    ] as [string, string][]) {
      const blocks = topBlocks(src);
      expect(blocks).toHaveLength(1);
      const doc = mdastToDoc(src);
      expect(applyChanges(src, doc, doc).text).toBe(src);
      expect((blocks[0].node as { value?: string }).value).toBe(expectValue);
    }
  });
});

describe("代码内容不被当 Markdown 解析", () => {
  it("代码里的 # / - / * / 反引号 原样活着，且改一行只重排该块", () => {
    const src = "# 标题\n\n```py\n# 这是注释\n- 不是列表\n* 也不是\n```\n\n正文段落。\n";
    const doc = mdastToDoc(src);
    const blocks = topBlocks(src);
    const cb = kids(doc)[1];
    const edited = cb.type.create(
      cb.attrs,
      hpSchema.text("# 这是注释\n- 不是列表\n* 也不是 改过", cb.child(0)?.marks ?? [])
    );
    // 只替换索引 1（代码块），其余孩子原样带上 —— 漏掉 child2 会把正文段落整段丢掉
    const all = kids(doc);
    const out = applyChanges(src, doc, doc.copy(Fragment.from([all[0], edited, all[2]]))).text;

    expect(out).toContain("* 也不是 改过");
    // 代码块之前的内容逐字节不变
    expect(out.slice(0, blocks[1].from)).toBe(src.slice(0, blocks[1].from));
    expect(out).toContain("# 标题");
    expect(out).toContain("正文段落。");
    // 代码块仍是**一个** code 节点，没被拆成标题/列表
    expect(topBlocks(out).map((b) => b.node.type)).toEqual(["heading", "code", "paragraph"]);
  });
});
