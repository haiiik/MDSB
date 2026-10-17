import type { Root as MdRoot } from "mdast";
import { htmlToMdast } from "./htmlToMdast";

/**
 * 115：剪贴板纯文本兜底 —— TSV（制表符分隔）转成 GFM 表格。
 *
 * 为什么需要它：Excel 复制区域时，剪贴板里**同时**放 `text/html` 与 `text/plain`，
 * 而 plain 那份就是制表符分隔的表。有些来源（部分网页表格、老版本 WPS）只给 plain 那份，
 * 这时按 `\t` 拆列、按 `\n` 拆行，仍然能还原成表格 —— 这就是「兜底」。
 *
 * **不做 CSV**：逗号在字段里合法（`"甲,乙",丙`），要正确切就得实现 RFC 4180 的引号状态机，
 * 而剪贴板路径上 Excel/Word/WPS 给的 plain 都是 TSV，逗号那一路实际不发生。
 * 真的需要 CSV，应当是「导入文件」功能而不是「粘贴」，别在这里猜。
 */

/** 这份纯文本像不像一张表（含制表符就算；Excel 复制单行也是 `a\tb`） */
export function looksLikeTable(text: string): boolean {
  return text.includes("\t") && text.trim().length > 0;
}

const cell = (value: string) => ({ type: "tableCell", children: value.trim() ? [{ type: "text", value: value.trim() }] : [] });
const row = (values: string[]) => ({ type: "tableRow", children: values.map(cell) });

/** TSV → mdast 表格（首行当表头；列数取最大值，短行补空格子，绝不丢字） */
export function tsvToMdast(text: string): MdRoot {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  const rows = lines.map((l) => l.split("\t"));
  const cols = Math.max(...rows.map((r) => r.length));
  const table = {
    type: "table",
    // 兜底路径没有任何对齐信息，全默认
    align: Array.from({ length: cols }, () => null),
    children: rows.map((r) => row([...r, ...Array.from({ length: cols - r.length }, () => "")])),
  };
  return { type: "root", children: [table] } as unknown as MdRoot;
}

/**
 * 剪贴板 → mdast 的**选择器**（114/115/116 共用的入口）。
 *
 * 优先级：`text/html` > 含制表符的 `text/plain` > 都不是（返回 null，
 * 让 PM 走默认纯文本插入 —— 这就是验收里「纯文本粘贴不触发转换」那条）。
 */
export function clipboardToMdast(data: { html?: string; text?: string }): MdRoot | null {
  if (data.html?.trim()) return htmlToMdast(data.html);
  if (data.text && looksLikeTable(data.text)) return tsvToMdast(data.text);
  return null;
}
