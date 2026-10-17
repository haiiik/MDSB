import { describe, expect, it } from "vitest";
import { computeStats } from "../../src/kernel/stats";

/**
 * 023 统计口径逐条钉住。口径定义在 kernel/stats.ts 顶部，
 * 这里改一个数字就等于改口径，必须是有意识的动作。
 */

describe("computeStats", () => {
  it("中文按字计，英文按词计", () => {
    const s = computeStats("审批时效 5 小时\n\nhello world foo");
    expect(s.cjk).toBe(6); // 审批时效 + 小时
    expect(s.latin).toBe(4); // 5 / hello / world / foo
    expect(s.words).toBe(10);
  });

  it("代码块与行内代码不计入字数", () => {
    const s = computeStats("正文三个字\n\n`inlineCode`\n\n```ts\nconst abc = 1;\n```");
    expect(s.cjk).toBe(5);
    expect(s.latin).toBe(0);
    expect(s.codeBlocks).toBe(1);
  });

  it("Mermaid 算一个代码块，内容不计字数", () => {
    const s = computeStats("说明\n\n```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```");
    expect(s.mermaid).toBe(1);
    expect(s.codeBlocks).toBe(1);
    expect(s.cjk).toBe(2);
    expect(s.latin).toBe(0);
  });

  it("表格里的正文计入，图片 alt 不计", () => {
    const s = computeStats("| 指标 | 值 |\n| --- | --- |\n| 平均时长 | 3 |\n\n![替代文字](a.png)");
    expect(s.tables).toBe(1);
    expect(s.images).toBe(1);
    expect(s.cjk).toBe(7); // 指标 值 平均时长
    expect(s.latin).toBe(1); // 3
  });

  it("标题数按 h1~h6 统计，井号不计入字数", () => {
    const s = computeStats("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f");
    expect(s.headings).toBe(6);
    expect(s.latin).toBe(6);
  });

  it("链接只计锚文本，URL 不计；行内代码整段不计", () => {
    const s = computeStats("看[这里](https://example.com/very/long/path)谢谢");
    expect(s.cjk).toBe(5); // 看 这 里 谢 谢
    expect(s.latin).toBe(0);
  });

  it("行数含空行，空文档全零", () => {
    expect(computeStats("a\nb\n\nc").lines).toBe(4);
    const empty = computeStats("");
    expect(empty.lines).toBe(0);
    expect(empty.words).toBe(0);
  });

  it("未闭合的代码围栏按 CommonMark 延伸到文末，后文不计字数", () => {
    // CommonMark：文档结尾仍未闭合的围栏会一直吞到文末。统计与渲染必须同一口径，
    // 否则状态栏字数和屏幕上看到的内容对不上。
    const s = computeStats("```ts\ncode\n\n后面这句还在统计里");
    expect(s.codeBlocks).toBe(1);
    expect(s.cjk).toBe(0);
  });

  it("3000 行文档统计在 30ms 内（不拖慢输入）", () => {
    const md = Array.from({ length: 3000 }, (_, i) => `第 ${i} 段：审批时效监控的中文正文。`).join("\n\n");
    // 三次取最优：单次计时会被 V8 预热与同机并发进程带偏（实测 13.6ms 的代码
    // 在满负载下能跑到 36ms，撞开 30ms 的线）。阈值不放宽，改的是计时口径。
    let dt = Number.POSITIVE_INFINITY;
    let s = computeStats(md);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      s = computeStats(md);
      dt = Math.min(dt, performance.now() - t0);
    }
    console.log(`computeStats 3000 行: ${dt.toFixed(1)}ms（最优），words=${s.words}`);
    expect(s.lines).toBe(5999);
    expect(dt).toBeLessThan(30);
  });
});
