import { describe, expect, it } from "vitest";
import {
  basename,
  decodeSrc,
  dirname,
  isAbsoluteFsPath,
  isExternalUrl,
  resolveFsPath,
  toSlashes,
} from "../../src/kernel/paths";

describe("paths", () => {
  it("识别外部 URL 与本地绝对路径", () => {
    expect(isExternalUrl("https://example.com/a.png")).toBe(true);
    expect(isExternalUrl("data:image/png;base64,AAA")).toBe(true);
    expect(isExternalUrl("//cdn.example.com/a.png")).toBe(true);
    expect(isExternalUrl("#anchor")).toBe(true);
    expect(isExternalUrl("./a.png")).toBe(false);

    expect(isAbsoluteFsPath("C:/docs/a.png")).toBe(true);
    expect(isAbsoluteFsPath("C:\\docs\\a.png")).toBe(true);
    expect(isAbsoluteFsPath("/demo/a.png")).toBe(true);
    expect(isAbsoluteFsPath("a.png")).toBe(false);

    // 回归：单字母盘符不能被当成 URI scheme —— 桌面端一旦误判，
    // 相对图片整条解析会被跳过，表现为图裂且没有任何网络请求
    expect(isExternalUrl("C:/Users/han/文档/a.png")).toBe(false);
    expect(isExternalUrl("D:/a.png")).toBe(false);
    expect(isExternalUrl("file:///C:/a.png")).toBe(true);
  });

  it("dirname / basename 对反斜杠与正斜杠都成立", () => {
    expect(dirname("C:/docs/prd/审批.md")).toBe("C:/docs/prd");
    expect(dirname("C:\\docs\\prd\\审批.md")).toBe("C:/docs/prd");
    expect(dirname("/a.md")).toBe("/");
    expect(basename("C:/docs/prd/审批.md")).toBe("审批.md");
  });

  it("相对路径按文档目录解析，含中文与空格", () => {
    expect(resolveFsPath("/demo", "./diagrams/arch.png")).toBe("/demo/diagrams/arch.png");
    expect(resolveFsPath("/demo", "../共享/时间 线.svg")).toBe("/共享/时间 线.svg");
    expect(resolveFsPath("C:/用户/韩/文档/prd", "图/架构 v2.png")).toBe(
      "C:/用户/韩/文档/prd/图/架构 v2.png"
    );
  });

  it("多层 .. 与多余斜杠被折叠，越出根不产生 .. 段", () => {
    expect(resolveFsPath("/a/b/c", "./d/../e.png")).toBe("/a/b/c/e.png");
    expect(resolveFsPath("/a", "../../../../x.png")).toBe("/x.png");
    expect(resolveFsPath("/a/b/", "///c.png")).toBe("/a/b/c.png");
  });

  it("Windows 基准目录解析后仍是绝对路径", () => {
    const abs = resolveFsPath(dirname("C:/docs/prd/审批.md"), "./img/a.png");
    expect(abs).toBe("C:/docs/prd/img/a.png");
    expect(isAbsoluteFsPath(abs)).toBe(true);
  });

  it("decodeSrc 处理 URL 编码的中文路径，非法编码不抛", () => {
    expect(decodeSrc("%E5%9B%BE/a.png")).toBe("图/a.png");
    expect(decodeSrc("%E5%AE%B")).toBe("%E5%AE%B");
    expect(toSlashes("a\\b\\c")).toBe("a/b/c");
  });
});
