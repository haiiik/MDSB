/**
 * 118：查找与替换的**纯判据层**。
 *
 * 三种模式（阅读 / 所见即所得 / 源码）的「文本表面」完全不同：
 * 阅读找渲染出来的文字、源码找原始 Markdown、编辑找 PM 文档里的文字节点。
 * 但「什么算一次命中」只有一份，就是这里 —— 所以它必须是不碰 DOM、不碰 PM、
 * 不碰 CodeMirror 的纯函数，才能被单测穷举（大小写 × 全词 × 正则 × 中文 × 重叠）。
 *
 * 三条容易写错、也最容易在评审时被质疑的口径，写在下面：
 *
 * 1. **字面量模式不走正则**。用户输入 `(`、`*`、`**加粗**` 时不该报错，
 *    也不该被当成量词 —— 所以字面量用 `indexOf` 扫描，不做 `escapeRegExp` 后丢给引擎。
 * 2. **全词对中文 = 「整段词字符」**。词字符取 Unicode 字母 / 数字 / 下划线（`\p{L}\p{N}_`），
 *    中文字符属于 `\p{L}`，所以「指标」在「指标口径」里**不算**全词命中。
 *    这不是偷懒：中文没有空格分词，若把汉字当非词字符，「全词」对中文就完全等于没开。
 * 3. **零宽正则匹配跳过一格**。`(a*)` 这类模式会在每个位置匹配空串，
 *    不前进就会死循环；按 JS 正则的惯例手动 `lastIndex++`。
 */

export type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export type Match = { from: number; to: number };

/** 正则模式下表达式非法 —— 调用方要「给提示且不清空输入」，所以是可控异常不是 bug */
export class InvalidPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPatternError";
  }
}

/** 词字符：Unicode 字母、数字、下划线（见文件头第 2 条） */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function flagsFor(opts: SearchOptions): string {
  return opts.caseSensitive ? "gu" : "giu";
}

/** 一次扫描的全部命中（不重叠、从左到右）。空查询 = 零命中，不是「全匹配」 */
export function findMatches(text: string, query: string, opts: SearchOptions): Match[] {
  if (!query || !text) return [];
  if (opts.regex) return scanWithRegex(text, query, opts);
  return scanLiteral(text, query, opts);
}

function scanLiteral(text: string, query: string, opts: SearchOptions): Match[] {
  const out: Match[] = [];
  // 大小写不敏感时按小写比较，但**长度不变**：ASCII 里 İ/ı 一类会变长，
  // 用 toLowerCase 后按字符索引对齐要冒风险，所以只在长度相等时才敢复用索引。
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  if (hay.length !== text.length) {
    // 退化路径：大小写折叠改变了长度（极少数字符），逐字符重新定位
    return scanWithRegex(text, escapeRegExp(query), opts);
  }
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (!opts.wholeWord || isWholeWord(text, at, at + needle.length)) out.push({ from: at, to: at + needle.length });
    from = at + needle.length;
  }
  return out;
}

function scanWithRegex(text: string, pattern: string, opts: SearchOptions): Match[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flagsFor(opts));
  } catch (e) {
    throw new InvalidPatternError(e instanceof Error ? e.message : String(e));
  }
  const out: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex += 1; // 零宽匹配：手动前进，否则死循环
      continue; // 空命中不高亮（用户看不到，计数也会与高亮不一致）
    }
    if (!opts.wholeWord || isWholeWord(text, from, to)) out.push({ from, to });
  }
  return out;
}

/** 全词：命中片段前后都不能是词字符（见文件头第 2 条） */
export function isWholeWord(text: string, from: number, to: number): boolean {
  return !isWordChar(text[from - 1]) && !isWordChar(text[to]);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 上下跳转的索引推进：循环、不越界。
 * `total` 为 0 时返回 -1（没有命中就没有「当前项」）。
 */
export function advance(total: number, current: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return ((base + delta) % total + total) % total;
}

/**
 * 146：**按「人现在站在哪儿」推进**，而不是按上一次的索引加一。
 *
 * 报来的问题：查找用着的时候改了几个字，当前那一处被改没了，
 * 再点 ↑ / ↓ 就跳回**第一处** —— 明明站在第七处附近，视图却甩到文件开头。
 * 索引在这种情况下已经不代表任何位置（命中列表刚被重算过），
 * 而**光标在文本里的偏移**仍然代表光标在哪儿，所以拿它当起点：
 * - `delta > 0` → 起点之后第一处；后面没有就回到第一处（循环）；
 * - `delta < 0` → 起点之前最后一处；前面没有就落到最后一处（循环）。
 * 起点用 `to <= 起点` 判上一个，是为了让「光标正落在当前这一处里面」时按 ↑ 回到**上一处**，
 * 而不是原地不动（原地不动看起来像按钮坏了）。
 *
 * `起点 === null`（这一档没有光标可言，例如阅读模式）时退回索引推进的老语义：
 * 正向给第一处、反向给最后一处。
 */
export function advanceNear(matches: Match[], 起点: number | null, delta: 1 | -1): number {
  const total = matches.length;
  if (!total) return -1;
  if (起点 === null) return advance(total, -1, delta);
  if (delta > 0) {
    const i = matches.findIndex((m) => m.from > 起点);
    return i >= 0 ? i : 0;
  }
  for (let i = total - 1; i >= 0; i--) if (matches[i].to <= 起点) return i;
  return total - 1;
}


/** 计数文案：`3 / 12`；没有命中时是 `0 / 0`，不写「无结果」让 UI 自己决定 */
export function formatCount(total: number, current: number): string {
  if (total === 0) return "0 / 0";
  return `${current + 1} / ${total}`;
}
