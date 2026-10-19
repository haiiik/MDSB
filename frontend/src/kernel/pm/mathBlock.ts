/**
 * 138-B：公式的「拆开 / 拼回」。
 *
 * 形状只有一句：`raw = before + value + after`。
 * - `before` = 前导缩进 + 开定界符 + **它后面那段空白**
 * - `value`  = LaTeX 本体（**唯一可编辑的部分**）
 * - `after`  = **闭定界符前面那段空白** + 闭定界符 + 行尾空白
 *
 * 两侧空白归骨架而不是归正文，是为了「拼回去永远是原串」这条构造性保证：
 * 她能改的只有 `value`，`$$` 的个数、定界符旁的空格、CRLF、缩进都由骨架原样带回去。
 * 与 136-B 的脚注定义同一套路子 —— 编辑模式的回写是按块拼原文，
 * 这条往返性质一断，就会在她看不见的地方改她的文件。
 */

export interface MathParts {
  before: string;
  value: string;
  after: string;
}

/**
 * @param minDollars 块级要 2（`$$`），行内要 1（`$`）
 *
 * 认不出来就返回 null —— **调用方必须回落到不可编辑的占位**，
 * 不许"猜一个拆法"：猜错的拆法拼回去就是一个她没写过的文件。
 */
function split(raw: string, minDollars: number): MathParts | null {
  const start = /^\s*/.exec(raw)![0].length;
  if (raw[start] !== "$") return null;
  let openLen = 0;
  while (start + openLen < raw.length && raw[start + openLen] === "$") openLen++;
  if (openLen < minDollars) return null;

  // 最后一个**非空白**字符下标（行尾空白属于 after，不参与定界符识别）
  let last = raw.length - 1;
  while (last >= 0 && /\s/.test(raw[last])) last--;
  if (last < 0 || raw[last] !== "$") return null;
  let closeLen = 0;
  while (last - closeLen >= 0 && raw[last - closeLen] === "$") closeLen++;
  // 开闭必须等长：`$$x$$$` 这种"看起来像但说不清"的形状一律不认
  if (closeLen !== openLen) return null;

  const bodyFrom = start + openLen;
  const closeStart = last - closeLen + 1;
  // 重叠 = `"$$"` 这种手滑：开定界符和闭定界符是同一段字符，不构成公式
  if (closeStart < bodyFrom) return null;

  const body = raw.slice(bodyFrom, closeStart);
  const lead = /^\s*/.exec(body)![0];
  const rest = body.slice(lead.length);
  const trail = /\s*$/.exec(rest)![0];
  return {
    before: raw.slice(0, bodyFrom) + lead,
    value: rest.slice(0, rest.length - trail.length),
    after: trail + raw.slice(closeStart),
  };
}

/** 块级 `$$…$$`（定界符至少两格） */
export function splitMathBlock(raw: string): MathParts | null {
  return split(raw, 2);
}

/** 行内 `$…$`（定界符至少一格；`$$x$$` 那种单行写法 remark 也判成行内） */
export function splitInlineMath(raw: string): MathParts | null {
  return split(raw, 1);
}

/** 拼回去 —— 三个片段直接相接，没有任何再排版 */
export function joinMathBlock(p: MathParts): string {
  return p.before + p.value + p.after;
}

export function joinInlineMath(p: MathParts): string {
  return p.before + p.value + p.after;
}
