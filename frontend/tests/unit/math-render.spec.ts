import { beforeAll, describe, expect, it } from "vitest";
import { loadMathRuntime, mathPlaceholder, mathReady, renderMath } from "../../src/kernel/math";
import { mdToHtml } from "../../src/kernel/md";

/**
 * 138-A：公式（KaTeX）。
 *
 * 判据分两层，故意的：
 * - `renderMath` 是**纯字符串进 / 出**的接缝，坏公式在这里必须**报得出错**，
 *   不是悄悄渲成一片红字让用户以为是文档本来就这样（004 定下的降级口径）。
 * - `mdToHtml` 那几条验的是**接进渲染管线之后**真的生效 ——
 *   只测纯函数会漏掉「handler 没注册」「allowDangerousHtml 被打开」这类集成缺陷。
 *
 * **DOM 那半边（水合后 KaTeX 真的出现在页面里）不在这儿测**：unit 是 node 环境，
 * 而且 KaTeX 与样式都是**动态 chunk**（见 math.ts 的 ensureMath），
 * 所以水合归 `tests/e2e/math.spec.ts`，那里跑的是真构建产物。
 * 这里能测的是「占位形状对不对」—— 占位错了，水合永远不会发生。
 *
 * 所有含反斜杠的输入一律在本文件里写两遍（`\\frac`）：
 * JS 字符串会把 `\p` 这种无效转义**丢掉反斜杠**，第一次做这件事时我把探针自己的 bug
 * 当成了 KaTeX 的 bug（见工单 138 的实测记录），别再踩。
 */

let rt: Awaited<ReturnType<typeof loadMathRuntime>>;

beforeAll(async () => {
  rt = await loadMathRuntime();
  expect(mathReady(), "KaTeX 没加载成功，下面的渲染判据全是空的").toBe(true);
  expect(rt, "运行时句柄为空，说明动态加载根本没跑").not.toBeNull();
});

describe("renderMath：纯函数接缝", () => {
  it("合法公式产出 KaTeX 的 HTML，命令没有被吞", () => {
    const r = renderMath(rt, "x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain("katex");
    // \pm 应当排成 ±；反斜杠丢了的话这里只会剩下 "pm"
    expect(r.html).toContain("±");
  });

  it("display 模式与行内模式产出不同（块级要居中占整行）", () => {
    const inline = renderMath(rt, "\\alpha");
    const block = renderMath(rt, "\\alpha", true);
    expect(inline.ok && block.ok).toBe(true);
    if (!inline.ok || !block.ok) return;
    expect(block.html).toContain("katex-display");
    expect(inline.html).not.toContain("katex-display");
  });

  it("空内容不算错（$ $ 这种手滑不该弹错误态）", () => {
    const r = renderMath(rt, "");
    expect(r.ok).toBe(true);
  });

  it("坏公式**报得出错**，不是 throwOnError:false 那片看不清的红字", () => {
    const r = renderMath(rt, "\\typeout{x}");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Undefined control sequence");
  });

  it("未闭合大括号也报错（KaTeX 会当成「还能猜」而不抛，除非我们要求）", () => {
    const r = renderMath(rt, "\\frac{1}{2");
    expect(r.ok).toBe(false);
  });
});

describe("mathPlaceholder：渲染期落的占位（水合的靶子）", () => {
  it("块级是 div、行内是 span，都带 hp-math--pending 与原文", () => {
    const block = mathPlaceholder("\\int_0^1 x\\,dx", true);
    const inline = mathPlaceholder("x^2", false);
    expect(block.tagName).toBe("div");
    expect(inline.tagName).toBe("span");
    for (const [el, src, disp] of [
      [block, "\\int_0^1 x\\,dx", "1"],
      [inline, "x^2", "0"],
    ] as const) {
      const cls = el.properties?.className as string[];
      expect(cls).toContain("hp-math--pending");
      // 属性里是百分号编码后的源码（见 math.ts 的注释：不让 `<` `"` 进属性值）
      expect(el.properties?.["data-math-src"]).toBe(encodeURIComponent(src));
      expect(el.properties?.["data-math-display"]).toBe(disp);
      // 文字内容仍是原文（含定界符）—— 未水合时用户看得见自己写了什么，查找也搜得到
      expect(JSON.stringify(el.children)).toContain(
        JSON.stringify(disp === "1" ? "$$" + src + "$$" : "$" + src + "$")
      );
    }
  });
});

describe("mdToHtml：公式接进渲染管线", () => {
  it("行内 `$x^2$` 落成占位节点，原文可见且带着编码后的 data-math-src", () => {
    const html = mdToHtml("行内 $x^2$ 结束。");
    expect(html).toContain("hp-math--pending");
    expect(html).toContain('data-math-src="x%5E2"');
    expect(html).toContain("$x^2$");
    expect(html).toContain("行内");
    expect(html).toContain("结束。");
    // 占位阶段不该有 KaTeX 结构（那意味着 katex 被静态拖进了渲染管线）
    expect(html).not.toContain("katex");
  });

  it("块级 `$$…$$` 独占一块，是 div 占位", () => {
    const html = mdToHtml("前一段。\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后一段。");
    expect(html).toContain('<div class="hp-math hp-math--block hp-math--pending"');
    expect(html).toContain("前一段。");
    expect(html).toContain("后一段。");
  });

  it("占位**不被 remark-math 的 hast 兜底改写成 `<code>`/`<pre>`**", () => {
    // mdast-util-math 在节点上挂了 data.hName（行内→code、块级→pre），
    // toHast 的 patch 会用它覆写 handler 返回的 tagName —— 摘不掉的话
    // 排好的公式会跟着正文代码变等宽加底色。这条就是把「摘掉了」钉住。
    const html = mdToHtml("行内 $x^2$ 结束。\n\n$$\n\\alpha\n$$\n");
    expect(html).not.toContain("language-math");
    expect(html).not.toMatch(/<pre[^>]*class="[^"]*hp-math/);
    expect(html).not.toMatch(/<code[^>]*class="[^"]*hp-math/);
  });

  it("单行 `$$E=mc^2$$` 也认（remark 把它解析成**行内**公式，这里如实钉住）", () => {
    const html = mdToHtml("质能方程：$$E=mc^2$$ 收尾。");
    expect(html).toContain("hp-math--inline");
    expect(html).toContain('data-math-src="E%3Dmc%5E2"');
  });

  it("与粗体 / 行内代码混排互不吞", () => {
    const html = mdToHtml("**粗** 里的 $x$ 和 `code` 共存。");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>");
    expect(html).toContain('data-math-src="x"');
  });

  it("KaTeX 不成为放开裸 HTML 的理由：正文里的 `<img>` 不落地", () => {
    expect(mdToHtml("<img src=x onerror=alert(1)>正文")).not.toContain("<img");
  });

  /**
   * 公式源码里带的尖括号与引号**进不了属性值**（`data-math-src` 是百分号编码的，见 math.ts）。
   *
   * 这条原来写成「输出里不许出现 `<script`」，测的是我当时的假设而不是事实 ——
   * `hast-util-to-html` 在 `useNamedReferences:true` 下转义属性里的 `"`（出不了属性，本来就不是洞），
   * 但 `<` `>` 原样留在值里，于是判据会误报。改成编码之后这条测的是真东西：
   * **属性值里没有尖括号、没有裸引号**，将来把阅读模式的 HTML 导出或嵌进别的模板也不用重新论证。
   */
  it("公式源码里的尖括号与引号被编码掉，只留在文字内容里（转义后的）", () => {
    const html = mdToHtml('$<script>"quote"</script>$ 收尾。');
    const attr = /data-math-src="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(attr).toBeTruthy();
    expect(attr).not.toMatch(/[<>"']/);
    expect(decodeURIComponent(attr)).toBe('<script>"quote"</script>');
    // 未水合时肉眼看到的是转义后的原文，不是可执行标签
    expect(html).not.toMatch(/>\s*<script/);
  });

  /**
   * 这条是**记录性断言**，不是愿望：单个 `$` 的歧义是 remark-math 的通病
   * （Obsidian / VS Code / GitHub 都一样），我们的回写走「按块拼原文」，
   * 所以文件字节不受影响，受影响的只有排版。
   * 哪天改成 `singleDollarTextMath: false`（Q30 的备选），这条会红 —— 那是故意的，
   * 逼着人来同步文档与口径，而不是让行为悄悄漂移。见 `docs/待确认口径.md` Q30。
   */
  it("已知歧义（Q30）：正文里的裸 `$` 会被当公式起点", () => {
    const html = mdToHtml("不该当公式：a $ b 和 10\\$5。\n");
    expect(html).toContain("hp-math");
  });
});
