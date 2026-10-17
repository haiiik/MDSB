import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import type { Root } from "mdast";

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
  });

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
  const tree = toHast(ast, {
    handlers: {
      yaml: () => ({ type: "text", value: "" }),
    },
  });
  return toHtml(tree, {
    characterReferences: { useNamedReferences: true },
    allowDangerousHtml: false,
  });
}
