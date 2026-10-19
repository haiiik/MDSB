import { describe, expect, it } from "vitest";
import {
  baseName,
  buildLink,
  dirOf,
  encodeLinkTarget,
  matchesQuery,
  mdLink,
  relPath,
  stemOf,
} from "../../src/kernel/docLinks";

/**
 * 137 的路径换算判据。
 *
 * 这一层是唯一**会写进她文件、肉眼又难验**的部分：弹层里看着对、插进去打不开，
 * 是最差的失败。所以每条边界都单独钉。
 */

describe("dirOf / baseName / stemOf", () => {
  it("反斜杠统一成正斜杠", () => {
    expect(dirOf("C:/Users/x/文档/周报 v1.md")).toBe("C:/Users/x/文档");
    expect(dirOf("C:\\Users\\x\\文档\\周报 v1.md")).toBe("C:/Users/x/文档");
    expect(baseName("C:/a/b/周报 v1.md")).toBe("周报 v1.md");
  });
  it("根目录下只剩文件名", () => {
    expect(dirOf("/a.md")).toBe("/");
    expect(baseName("/a.md")).toBe("a.md");
  });
  it("没有目录分隔时 dir 为空（= 没有相对基准）", () => {
    expect(dirOf("a.md")).toBe("");
  });
  it("去扩展名当链接文字；开头的点不算扩展名", () => {
    expect(stemOf("周报 v1.md")).toBe("周报 v1");
    expect(stemOf("审批.PRD.md")).toBe("审批.PRD");
    expect(stemOf(".gitignore")).toBe(".gitignore");
    expect(stemOf("无扩展名")).toBe("无扩展名");
  });
});

describe("relPath：相对当前文件所在目录", () => {
  it("同目录 / 子目录 / 兄弟目录 / 往上多层", () => {
    expect(relPath("/a/b", "/a/b/c.md")).toBe("c.md");
    expect(relPath("/a", "/a/b/c.md")).toBe("b/c.md");
    expect(relPath("/a/b", "/a/c/d.md")).toBe("../c/d.md");
    expect(relPath("/a/b/c", "/a/d.md")).toBe("../../d.md");
  });
  it("根目录当基准时不退化", () => {
    expect(relPath("/", "/a.md")).toBe("a.md");
    expect(relPath("/", "/x/a.md")).toBe("x/a.md");
  });
  it("Windows 大小写不敏感：C:/A/B 与 c:/a/b 是同一个目录", () => {
    expect(relPath("C:/A/B", "c:/a/b/周报.md")).toBe("周报.md");
    expect(relPath("C:/A/B", "C:/A/C/周报.md")).toBe("../C/周报.md");
  });
  it("**跨盘符不硬凑 `../`，直接退回绝对路径**", () => {
    expect(relPath("C:/a/b", "D:/x/y.md")).toBe("D:/x/y.md");
  });
  it("拿不到基准（未保存）时给绝对", () => {
    expect(relPath("", "/a/b.md")).toBe("/a/b.md");
  });
  it("**同库就一律给相对，哪怕 `../` 串很长**（换台机器还能打开比好看重要）", () => {
    expect(relPath("/a/b/c/d/e/f/g/h/i/j/k", "/a/x.md")).toBe("../../../../../../../../../../x.md");
    // 曾经有一条"相对比绝对还长就用绝对"的规则，它把最常见的兄弟目录
    // （/a/b → /a/c/d.md，相对 10 字符 vs 绝对 9 字符）全判成了绝对 —— 已删。
    expect(relPath("/a/b", "/a/c/d.md")).toBe("../c/d.md");
  });
  it("结尾多一个斜杠不影响判断", () => {
    expect(relPath("/a/b/", "/a/b/c.md")).toBe("c.md");
  });
});

describe("encodeLinkTarget：只编码会截断链接的那几个字符", () => {
  it("空格、括号、#、?、方括号被编码", () => {
    expect(encodeLinkTarget("./项目 周报 v1.md")).toBe("./项目%20周报%20v1.md");
    expect(encodeLinkTarget("./a(b).md")).toBe("./a%28b%29.md");
    expect(encodeLinkTarget("./a#b.md")).toBe("./a%23b.md");
    expect(encodeLinkTarget("./a?b.md")).toBe("./a%3Fb.md");
    expect(encodeLinkTarget("./[x].md")).toBe("./%5Bx%5D.md");
    expect(encodeLinkTarget("./100%.md")).toBe("./100%25.md");
  });
  it("**中文不编码**（全 encodeURI 会变成一串 %E5%，没人看得懂）", () => {
    expect(encodeLinkTarget("../标准成本/审批时效PRD.md")).toBe("../标准成本/审批时效PRD.md");
  });
});

describe("mdLink / buildLink：最终插进文档的那串", () => {
  it("链接文字是去扩展名的文件名", () => {
    expect(mdLink("审批时效PRD.md", "./docs/审批时效PRD.md")).toBe("[审批时效PRD](./docs/审批时效PRD.md)");
  });
  it("相对与绝对两行都给，弹层才能让她插入前就看见结果", () => {
    const c = buildLink("周报 v1.md", "/a/b/项目 周报 v1.md", "/a/b");
    expect(c.rel).toBe("项目 周报 v1.md");
    expect(c.mdRel).toBe("[周报 v1](项目%20周报%20v1.md)");
    expect(c.abs).toBe("/a/b/项目 周报 v1.md");
    expect(c.mdAbs).toBe("[周报 v1](/a/b/项目%20周报%20v1.md)");
  });
  it("**当前文件未保存 → 没有相对可选项**（没有基准就不假装有一个）", () => {
    const c = buildLink("x.md", "/a/b/x.md", "");
    expect(c.rel).toBeNull();
    expect(c.mdRel).toBeNull();
    expect(c.mdAbs).toBe("[x](/a/b/x.md)");
  });
  it("跨盘时相对退化成绝对 → 相对项同样不可选", () => {
    const c = buildLink("x.md", "D:/a/x.md", "C:/b");
    expect(c.rel).toBeNull();
  });
});

describe("matchesQuery：弹层按名搜索", () => {
  it("空查询全放行；大小写不敏感；命中路径任意一段", () => {
    expect(matchesQuery("docs/审批时效PRD.md", "")).toBe(true);
    expect(matchesQuery("docs/审批时效PRD.md", "审批")).toBe(true);
    expect(matchesQuery("docs/Readme.MD", "readme")).toBe(true);
    expect(matchesQuery("docs/审批时效PRD.md", "不存在")).toBe(false);
  });
  it("空格分词要求每段都命中、顺序不限", () => {
    expect(matchesQuery("docs/成本/标准.md", "标准 成本")).toBe(true);
    expect(matchesQuery("docs/成本/标准.md", "标准 别的")).toBe(false);
  });
});
