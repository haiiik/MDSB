import { describe, expect, it } from "vitest";
import { buildHeadingTree, slugify, uniqueSlug } from "../../src/kernel/anchors";
import { outlineOf } from "../../src/kernel/outline";

describe("slugify", () => {
  it("中文标题保留，空格转连字符，标点被去掉", () => {
    expect(slugify("审批时效 监控")).toBe("审批时效-监控");
    expect(slugify("1. 背景与目标")).toBe("1-背景与目标");
    expect(slugify("指标（口径）")).toBe("指标口径");
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("数字开头不加前缀，空标题有兜底 id", () => {
    expect(slugify("123")).toBe("123");
    expect(slugify("!!!")).toBe("section");
    expect(slugify("")).toBe("section");
  });

  it("重复标题得到可区分的 id，且规则确定", () => {
    const used = new Set<string>();
    expect(uniqueSlug("说明", used)).toBe("说明");
    expect(uniqueSlug("说明", used)).toBe("说明-2");
    expect(uniqueSlug("说明", used)).toBe("说明-3");
  });
});

describe("outlineOf", () => {
  const md = [
    "# 一级",
    "",
    "## 二级 A",
    "",
    "### 三级 A1",
    "",
    "## 二级 B",
    "",
    "#### 跳级（没有三级）",
    "",
    "## 代码里的标题",
    "",
    "```md",
    "# 这是代码块里的，不算标题",
    "```",
    "",
    "> 引用里的 # 也不算标题",
  ].join("\n");

  it("只收真正的标题，代码块与引用内容不算", () => {
    expect(outlineOf(md).map((h) => h.text)).toEqual([
      "一级",
      "二级 A",
      "三级 A1",
      "二级 B",
      "跳级（没有三级）",
      "代码里的标题",
    ]);
  });

  it("层级正确", () => {
    expect(outlineOf(md).map((h) => h.level)).toEqual([1, 2, 3, 2, 4, 2]);
  });

  it("折成树：子节点挂在最近的更浅一层下，跳级不补假节点", () => {
    const tree = buildHeadingTree(outlineOf(md));
    expect(tree).toHaveLength(1);
    const first = tree[0];
    expect(first.text).toBe("一级");
    expect(first.children.map((c) => c.text)).toEqual(["二级 A", "二级 B", "代码里的标题"]);
    expect(first.children[0].children.map((c) => c.text)).toEqual(["三级 A1"]);
    // 四级「跳级」直接挂到一级下（因为没有比它浅且未闭合的三级）
    expect(first.children[1].children.map((c) => c.text)).toEqual(["跳级（没有三级）"]);
  });

  it("无标题文档返回空数组", () => {
    expect(outlineOf("只有一段话。\n")).toEqual([]);
  });
});

describe("渲染与大纲的 id 必须一致", () => {
  it("同一篇文档两次解析得到同样的 id（确定性）", () => {
    const md = "# 说明\n\n正文\n\n## 说明\n\n再来一个同名\n";
    expect(outlineOf(md).map((h) => h.id)).toEqual(["说明", "说明-2"]);
    expect(outlineOf(md).map((h) => h.id)).toEqual(["说明", "说明-2"]);
  });
});
