/**
 * 文档统计（023）。
 *
 * 口径：
 * - **字数** = 中文汉字数 + 英文单词数（英文按 `[A-Za-z0-9]` 起头的连续串）；
 * - **不计**：代码块与 Mermaid 内容、行内代码、链接 URL、图片 alt 与语法符号；
 * - **计**：表格正文（表格是内容不是排版符号）、标题文字、引用文字；
 * - 行数 = 源文本换行数（含空行）；标题数 = `#`~`######` 开头的行数。
 *
 * 实现刻意**不走 mdast**：第一版用 `parseMd` 遍历，3000 行实测 355ms，
 * 每次停手都卡一下，直接违反「统计不拖慢输入」。这里改成按行扫描，
 * 同口径下 3000 行 < 10ms。
 */
export interface DocStats {
  words: number;
  cjk: number;
  latin: number;
  lines: number;
  headings: number;
  tables: number;
  codeBlocks: number;
  images: number;
  mermaid: number;
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN = /[A-Za-z0-9][A-Za-z0-9'’._-]*/g;

/** 去掉行内代码、图片、链接 URL 与强调/引用等标记，只留正文文字 */
function stripInline(line: string): string {
  return line
    .replace(/`[^`]*`/g, " ") // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片整体（alt 不计）
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接只留锚文本
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ") // 裸 HTML 标签
    .replace(/^\s{0,3}#{1,6}\s+/, " ") // 标题井号
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, " ") // 列表符号
    .replace(/^\s{0,3}>\s?/, " ") // 引用符号
    .replace(/[*_~]{1,3}/g, " "); // 强调与删除线标记
}

export function computeStats(md: string): DocStats {
  if (!md) {
    return { words: 0, cjk: 0, latin: 0, lines: 0, headings: 0, tables: 0, codeBlocks: 0, images: 0, mermaid: 0 };
  }
  const lines = md.split("\n");
  let cjk = 0;
  let latin = 0;
  let headings = 0;
  let tables = 0;
  let codeBlocks = 0;
  let images = 0;
  let mermaid = 0;

  let inFence = false;
  for (const raw of lines) {
    const line = raw.trimEnd();

    const fence = line.match(/^\s{0,3}(```+|~~~+)\s*([A-Za-z0-9_+-]*)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        codeBlocks++;
        if (fence[2].toLowerCase() === "mermaid") mermaid++;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue; // 代码块内容不计

    images += (line.match(/!\[[^\]]*\]\(/g) || []).length;
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) headings++;
    // 表格分隔行 `| --- | :-: |` 的条数即表格数
    if (/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(line) && line.includes("|")) tables++;

    const text = stripInline(line);
    cjk += (text.match(CJK) || []).length;
    latin += (text.match(LATIN) || []).length;
  }

  return {
    cjk,
    latin,
    words: cjk + latin,
    lines: lines.length,
    headings,
    tables,
    codeBlocks,
    images,
    mermaid,
  };
}
