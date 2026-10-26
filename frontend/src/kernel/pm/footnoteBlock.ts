/**
 * 136-B：脚注定义块的「拆开 / 拼回」。
 *
 * 为什么单独一个纯函数模块：编辑模式要能**就地改定义正文**，
 * 而回写走的是「按块拼原文」（`blockPatch` + `docToMdast` 把整块当 html 节点逐字节写回），
 * 所以这一块必须能被拆成「标记 / 续行缩进 / 正文」再**一字不差地拼回去**。
 * `join(split(raw)) === raw` 这条性质就是 136-B 的保真地基 ——
 * 没有它，"只动被编辑的那一块"（Q27 已定的口径）根本无从谈起。
 *
 * 三个容易搞坏往返的细节：
 * 1. **续行缩进是原文的一部分**，不是排版噪音。`[^b]: 一\n  二` 里的两格如果按 CommonMark
 *    社区习惯重排成四格（remark 的序列化器就是这么干的），diff 里会多出一行没改过的改动。
 * 2. **空续行不带缩进**。原文里 `\n\n` 夹在定义中间时，那行是空的；
 *    拼回去时给空行补缩进就会凭空多出两个空格。
 * 3. **标记里的 label 原样保留**，不做大小写归一、不做 URL 编码 ——
 *    `[^note_1]` 和 `[^Note_1]` 在 CommonMark 里是**两个不同**的标识符，改了就把引用接不上。
 */

export interface FootnoteDefParts {
  /** `[^这里]` 里的内容，原样保留 */
  label: string;
  /**
   * 冒号后面那段空白（通常是" "）。**单独存一个字段而不是并进正文**，
   * 因为并进正文后一删就把语法删坏了：`[^a]:正文` 不是合法的脚注定义，
   * micromark 要求冒号后面必须跟空白或换行。拼回时这里保证至少一个空格。
   */
  gap: string;
  /** 续行的缩进（原文里是几格就是几格）；单行定义时给个默认值，用不上 */
  indent: string;
  /** 去掉 `[^label]:`、冒号后空白与续行缩进之后的正文，可编辑 */
  body: string;
}

/** 拆开一个脚注定义块。不是脚注定义（或形态不对）时返回 null，让调用方回落不透明块。 */
export function splitFootnoteDef(raw: string): FootnoteDefParts | null {
  // `.` 不匹配换行，所以这个正则只吃掉**第一行** —— 续行从 m[0] 之后单独切
  const m = /^\[\^([^\]]+)\]:( *)(.*)/.exec(raw);
  if (!m) return null;
  const label = m[1];
  const gap = m[2];
  const firstLine = m[3];
  // m[0] 已经吃掉整行第一行（含冒号后空白与正文首行），续行从它之后开始
  const tail = raw.slice(m[0].length);
  const cont = tail.startsWith("\n") ? tail.slice(1).split("\n") : [];
  const lines = [firstLine, ...cont];
  let indent = "  ";
  if (lines.length > 1) {
    const lead = /^[\t ]*/.exec(lines[1]);
    indent = lead ? lead[0] : "";
  }
  const body = lines
    .map((l, i) =>
      i === 0 ? l : l.length >= indent.length ? l.slice(indent.length) : l.replace(/^[\t ]+/, "")
    )
    .join("\n");
  return { label, gap, indent, body };
}

/** 拼回去。与 split 严格互逆（见单测里的往返性质）。 */
export function joinFootnoteDef(p: FootnoteDefParts): string {
  const body = p.body
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : p.indent + l))
    .join("\n");
  // 冒号后没有空白就不是脚注定义了 —— 删掉那个空格也不该把语法弄坏
  const gap = body === "" ? p.gap : p.gap === "" ? " " : p.gap;
  return `[^${p.label}]:${gap}${body}`;
}

/** 行内脚注引用 `[^label]` 的 label；不是引用时返回 null */
export function footnoteRefLabel(raw: string): string | null {
  const m = /^\[\^([^\]]+)\]$/.exec(raw.trim());
  return m ? m[1] : null;
}
