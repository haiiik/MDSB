import type { BlockContent, Root } from "mdast";
import { parseMd, serializeMd } from "./md";

/**
 * 101 保真拼接接缝：**按块替换，不做整篇 re-stringify**（D23）。
 *
 * 为什么需要它：实测整篇 `serializeMd` 做不到逐字节保真 —— remark 会补齐表格列宽、
 * 把 `***` 归一成 `---`、把 `&amp;` 归一成 `&`，且这些关不掉。用户只改一句话，
 * 整篇表格却被重排，那是静默损坏文档。
 *
 * 本模块的做法：块 = mdast 根节点的**直接子节点**（一个段落 / 一个列表（含所有嵌套）/
 * 一个表格 / 一个围栏代码块 / 一段裸 HTML 各算一块）。只把被点名的块送进序列化器，
 * 其余区间从原文逐字节拷贝。块与块之间的空行、行尾风格、末尾换行一律不进序列化器。
 *
 * 注意：M1 的生产落盘路径本来就没有整篇序列化（`saveTab` 写的是 `tab.markdown` 原文），
 * 这里防的是 M2 编辑模式引入的新漂移 —— 见工单 104 的回写口径。
 */

/** 一个顶层块在原文中的字符区间（不是行列号：行号在 CRLF 与全角标点下会漂） */
export type BlockRange = { from: number; to: number; node: BlockContent };

/** 一次替换：把 `source.slice(from, to)` 换成 `md` */
export type BlockPatch = { from: number; to: number; md: string };

/**
 * 列出原文的所有顶层块及其区间。
 *
 * 区间取自 remark 的 `position`，是**字符偏移**。frontmatter（`yaml` 节点）也占一个
 * 顶层位置，因此它天然落在「不点名就不动」的那一侧。
 */
export function topBlocks(md: string): BlockRange[] {
  const ast = parseMd(md);
  return ast.children.map((node, i) => {
    // mdast 的类型把 `offset` 标成可选（deviation 时可以没有），
    // remark-parse 实际总会给出；这里显式收窄，拿不到就报错而不是产出坏区间。
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from == null || to == null) {
      throw new Error(`第 ${i} 个块（${node.type}）没有源区间，无法按块替换`);
    }
    return { from, to, node: node as BlockContent };
  });
}

/**
 * 去掉序列化器补在首尾的换行。
 *
 * 尾随换行是一直有的；**前导换行**是 107 撞出来的：
 * 列表首项为空时，remark 会为它吐出空白行，于是 patch 之后文件开头凭空多出两个空行。
 * 块区间本身按 101 的定义**不含前后空行**，所以这里两头都削。
 */
function trimBlockNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

/** 序列化单个块（块级规范化是既定代价，块外由 `patch` 保证不动） */
export function serializeBlock(node: BlockContent): string {
  return trimBlockNewlines(serializeMd({ type: "root", children: [node] } as unknown as Root));
}

/** 文件的主导行尾：出现 CRLF 就按 CRLF 写，否则按 LF */
function detectEol(source: string): "\r\n" | "\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/** 把任意换行风格统一成目标行尾 */
function withEol(text: string, eol: "\r\n" | "\n"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * 按块替换。
 *
 * 保证：
 * - `patch(source, [])` **恒等于** `source`（不编辑时零改动，这是第一道防线）；
 * - 未被点名的字节区间原样拷贝，包括块间空行、行尾风格与文件末尾换行；
 * - 新内容里的换行按目标文件的主导行尾写出。
 *
 * 区间重叠 / 越界 / from>to 一律抛错，不静默产出坏文本。
 */
export function patch(source: string, patches: readonly BlockPatch[]): string {
  if (patches.length === 0) return source;

  const sorted = [...patches].sort((a, b) => a.from - b.from);
  let cursor = 0;
  for (const p of sorted) {
    if (!Number.isInteger(p.from) || !Number.isInteger(p.to)) {
      throw new Error(`块区间必须是整数：[${p.from}, ${p.to})`);
    }
    if (p.from < 0 || p.to > source.length || p.from > p.to) {
      throw new Error(`块区间越界：[${p.from}, ${p.to})，原文长度 ${source.length}`);
    }
    if (p.from < cursor) {
      throw new Error(`块区间重叠：上一个到 ${cursor}，这个却从 ${p.from} 开始`);
    }
    cursor = p.to;
  }

  const eol = detectEol(source);
  let out = "";
  let at = 0;
  for (const p of sorted) {
    out += source.slice(at, p.from);
    out += withEol(p.md, eol);
    at = p.to;
  }
  out += source.slice(at);
  return out;
}
