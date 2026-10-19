import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import { toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import type { Root } from "mdast";
import { mathPlaceholder } from "./math";

/**
 * 文档模型：md <-> mdast <-> html 的唯一出入口。
 *
 * 选 mdast（而不是 markdown-it 的 token 流）是因为 spec §5.1 把
 * 「md 文本 → 文档模型 → md 文本」定为最高测试接缝：M2 的 ProseMirror
 * 节点树要能从同一个 AST 映射出来，序列化与渲染共用一份模型才谈得上保真。
 *
 * GFM 打开后才有表格 / 删除线 / 任务清单 / 自动链接（US-09 的硬需求）。
 */

/**
 * 序列化选项刻意与 CommonMark 社区习惯对齐，目的是消掉「本可避免」的漂移：
 * remark 默认把无序列表符号改写成 `*`，而用户手写 md 绝大多数用 `-`，
 * 不锁定的话每次往返都会把整篇列表符号换掉 —— 那是纯噪音，不是保真。
 *
 * 注：解析与序列化必须是同一个 processor，且 `remarkStringify` 要排在
 * `remarkParse` 之后 —— 否则 unified 的类型推导在「还没有输入类型」的阶段
 * 匹配不上 Plugin<[], Root, string>，会退到 use(boolean) 那个重载报 TS2345。
 */
const proc = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // frontmatter 只当「一整块不透明原文」对待：不解析 YAML 内容（D11），
  // 但往返时原样写回，避免 `---\nfoo: bar\n---` 被误读成分隔线 + 段落而损坏。
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkStringify, {
    bullet: "-",
    emphasis: "*",
    strong: "*",
    rule: "-",
    listItemIndent: "one",
  })
  // 138：`$$…$$` / `$…$` 认成 math / inlineMath 节点。
  // remark-math 一次带来**两半**：fromMarkdown（认得出公式）与 toMarkdown（写得回 `$$`）。
  // 少了 toMarkdown 那半，序列化会把 math 节点当未知类型 —— 只 warn 一声就把内容丢了，
  // 等于删用户的公式。位置放在 stringify 之后只是与上面那条「stringify 要排在 parse 之后」
  // 的类型推导约束保持同一写法，**扩展注册顺序本身不影响这两半是否生效**（unified 是按
  // parser/compiler 收集扩展的，不是按顺序），改前面面也一样 —— 这条已实测。
  .use(remarkMath);

export function parseMd(md: string): Root {
  return proc.parse(md);
}

export function serializeMd(ast: Root): string {
  return proc.stringify(ast);
}

/**
 * md -> HTML 字符串。
 *
 * `allowDangerousHtml: false`（默认）：mdast-util-to-hast 会把源文档里的
 * 裸 HTML **丢弃**（不是转义）—— 标签消失、其中文字保留。阅读模式渲染的
 * 虽然是用户自己的本地文档，但一旦日后加入「渲染网络拉来的 md」就是 XSS 面，
 * 这里先收紧，需要放开时改成显式选项 + 白名单清洗，而不是默默允许。
 *
 * frontmatter 显式渲染成空：本期不展示（D11），留 handler 是为了压掉
 * toHast 对未知节点类型的告警，而不是靠它兜底。
 * 注：remark-frontmatter 产出的节点类型是 `yaml`（不是 `frontmatter`）。
 */
export function mdToHtml(md: string): string {
  const ast = parseMd(md);
  stripMathHastFallback(ast);
  const tree = toHast(ast, {
    handlers: {
      yaml: () => ({ type: "text", value: "" }),
      /**
       * 138：公式先落**占位**（原文可见），KaTeX 由 `hydrate()` 那一步动态取完再原地替换
       * —— 与 Mermaid 同一条路子。这里绝不 import katex：静态引一次就把它拖进主入口，
       * 每篇没有公式的文档都得为它付冷启动成本（121/123 那条纪律）。
       */
      math: (_state, node) => mathPlaceholder(String((node as { value?: string }).value ?? ""), true),
      inlineMath: (_state, node) => mathPlaceholder(String((node as { value?: string }).value ?? ""), false),
    },
  });
  return toHtml(tree, {
    characterReferences: { useNamedReferences: true },
    allowDangerousHtml: false,
  });
}

/**
 * 把 remark-math 挂在 math 节点上的 **hast 兜底**摘掉。
 *
 * `mdast-util-math` 给每个 math 节点写了 `data.hName` / `data.hProperties`
 * （行内 → `<code class="language-math math-inline">`，块级 → `<pre>`），
 * 那是「下游没有 rehype-katex 时至少别丢内容」的退路。
 * 但 `mdast-util-to-hast` 的 patch 会**用它覆写我们 handler 返回的 tagName**
 * （源码 lib/state.js 里 `result.tagName = hName` 那一段），
 * 结果排好的公式被塞进 `<code>`，跟着正文代码样式变等宽、加底色。
 *
 * `parseMd` 每次返回新树，这里就地删只影响本次渲染，不会污染编辑模式那条路。
 */
function stripMathHastFallback(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string; data?: Record<string, unknown>; children?: unknown[] };
  if (n.type === "math" || n.type === "inlineMath") {
    delete n.data?.hName;
    delete n.data?.hProperties;
  }
  (n.children ?? []).forEach(stripMathHastFallback);
}
