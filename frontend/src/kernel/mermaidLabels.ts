/**
 * 125：Mermaid **标签的源码级解析**。
 *
 * 一件事同时被两个功能需要，所以只做一份：
 * - 「渲染前我们自己折行」（方案 A，125 选的）：把长中文标签按字宽插 `<br/>` 后再交给 mermaid，
 *   mermaid 就按我们定的行数算形状高度 —— 不再出现「折了行却溢出盒子」；
 * - 「双击图上的文字直接改」（125 要的）：要知道屏幕上这行字**对应源码里哪一段字符**，
 *   才能只替换那一处文字、不动结构。
 *
 * 两条口径先说清，后面别改：
 * ① **只认标签，不认结构**。解析不出来的一律不当标签（宁可少认，不可错认 —— 认错会把用户的图改坏）；
 * ② **折行只发生在渲染输入上，绝不写回用户文档**。落盘的永远是用户那份源码，
 *    所以 104 的按块回写与 120 的保真矩阵不受影响。
 */

import { t, tf } from "../i18n";

export type LabelKind =
  /** flowchart 节点标签 `A[文字]` */
  | "node"
  /** 一切「边上的文字」：flowchart 的 `|…|`、ER 的关系标签、state 的迁移标签 */
  | "edge"
  /** 图里的一段纯文字：ER 的属性行、state 的 `state "…" as X` 与 note */
  | "text"
  /** **标识符**：ER 实体名、state 状态名。解析得出来但不许改 —— 它在别处被引用 */
  | "id";

export interface LabelSpan {
  kind: LabelKind;
  /** 节点 id / 实体名 / 状态名；边与通用文字用 `edge#<源码顺序>` 形式给定位键 */
  id: string;
  /** 标签正文（不含定界符、不含外层引号） */
  text: string;
  /** 正文在源码里的字符区间（不含引号） */
  from: number;
  to: number;
  /** **可替换区**：紧跟在起始定界符之后、结束定界符之前，含外层引号。改字时替换这一段 */
  bodyFrom: number;
  bodyTo: number;
  /** 定界符，用于判断新文字里哪些字符会破坏语法 */
  open: string;
  close: string;
  quoted: boolean;
  /**
   * 通用文字（kind === "text"）在渲染产物里的**元素类名线索**。
   * ER 的属性行是 `<div class="label attribute-comment">` 这种，
   * 靠类名 + 文字内容就能对上，不需要 mermaid 给 id。
   */
  domHint?: string;
  /**
   * 这段文字允不允许出现换行（`<br/>`）。
   * 只有 flowchart 的 htmlLabels 支持 —— ER 的属性行、state 的迁移标签都是**单行语法**，
   * 塞 `<br/>` 进去会被当字面文字显示，甚至把行结构弄坏。
   */
  multiline: boolean;
  /**
   * 只能是一串不带空格的标识符（ER 的属性类型 / 属性名 / 键标记）。
   * 这类位置塞进空格会把一行拆成两个 token，等于改坏语法结构。
   */
  singleWord?: boolean;
}

/**
 * 节点标签的定界符表，**长的在前**（`[[` 必须先于 `[` 试，否则 `A[[x]]` 会被切成 `[x]`）。
 * 表里没有的形状（如 `A^"..."`、非标准写法）一律不认 —— 不认就不会改错。
 */
const NODE_FORMS: [string, string][] = [
  ["((", "))"],
  ["[[", "]]"],
  ["[(", ")]"],
  ["([", "])"],
  ["{{", "}}"],
  ["[/", "/]"],
  ["[\\", "\\]"],
  ["[", "]"],
  ["{", "}"],
  ["(", ")"],
  [">", "]"],
];

/** mermaid 允许的节点 id 字符（含中文 id；`-` 放最后免得被当区间） */
const ID_RE = /[A-Za-z0-9_一-鿿-]+$/;

/** 起始定界符的首字符，用来快速跳过绝大多数位置 */
const OPEN_HEADS = new Set(["[", "{", "(", ">", "|"]);

function idBefore(src: string, i: number): string | null {
  const m = src.slice(0, i).match(ID_RE);
  if (!m) return null;
  // **必须含字母/数字/下划线/汉字**才算 id。
  // 少了这一条，箭头 `-->|文字|` 里那个 `>` 会被当成「旗形节点」的起始定界符
  // （它前面的 `--` 恰好落在 id 字符集里），于是一整段 `|文字| B[归档]` 被认成一个标签 ——
  // 单测第一次跑就红在这儿。宁可少认，不可错认。
  return /[A-Za-z0-9_一-鿿]/.test(m[0]) ? m[0] : null;
}

interface Body {
  text: string;
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  quoted: boolean;
}

/**
 * 从 `p`（起始定界符之后）读到结束定界符 `close` 之前。
 *
 * 三条硬规矩：
 * - **不跨行**：标签不写多行源码，遇到 `\n` 直接判定「这不是标签」；
 * - 引号态：`A["文本 ] 也算文本"]` 里的 `]` 不是结束符，所以带引号时按引号找终点；
 * - 终点后面（跳过行内空格）必须**正好**是结束定界符，否则整条不认。
 */
function matchBody(src: string, p: number, close: string): Body | null {
  let q = p;
  while (q < src.length && (src[q] === " " || src[q] === "\t")) q++;
  const quoted = src[q] === '"';
  const start = quoted ? q + 1 : q;
  let k = start;
  while (k < src.length) {
    const ch = src[k];
    if (ch === "\n") return null;
    if (quoted) {
      if (ch === "\\") {
        k += 2;
        continue;
      }
      if (ch === '"') break;
      k++;
      continue;
    }
    if (src.startsWith(close, k)) break;
    k++;
  }
  if (k >= src.length) return null;
  const text = src.slice(start, k);
  if (quoted) {
    if (src[k] !== '"') return null;
    let m = k + 1;
    while (m < src.length && (src[m] === " " || src[m] === "\t")) m++;
    if (!src.startsWith(close, m)) return null;
    return { text, from: start, to: k, bodyFrom: p, bodyTo: k + 1, quoted: true };
  }
  if (!src.startsWith(close, k)) return null;
  return { text, from: start, to: k, bodyFrom: p, bodyTo: k, quoted: false };
}

/**
 * 扫出源码里所有**可识别的标签**，按源码顺序返回。
 *
 * 按图类型分派：flowchart 一套（定界符）、erDiagram 一套、stateDiagram 一套。
 * 认不出的图类型返回空表 —— 空表 = 图上没有可改的文字 = 双击会明确拒绝，
 * **不会**拿 flowchart 的语法去猜别的图（那才会写坏用户的图）。
 */
export function scanMermaidLabels(src: string): LabelSpan[] {
  const type = diagramType(src);
  if (type === "er") return scanEr(src);
  if (type === "state") return scanState(src);
  if (type === "flowchart") return scanFlowchart(src);
  return [];
}

/**
 * 已知的「别的图」的表头。它们**不能**拿 flowchart 语法去扫 ——
 * 比如 `pie "甲" : 1` 里的引号与冒号，按 flowchart 规则会切出莫名其妙的"标签"。
 */
const OTHER_HEADERS =
  /^(pie|sequenceDiagram|classDiagram|journey|gantt|gitGraph|mindmap|timeline|quadrantChart|xyChart|requirementDiagram|architectureBeta|packet|block\b|sankey|ishikawa|kanban|C4Context|C4Container|C4Component)/i;

/**
 * 图类型看第一行有效内容（`%%` 指令行与空行跳过）。
 *
 * **没有表头的裸片段算 flowchart**（`A[开始] --> B[结束]` 这种在测试与用户片段里很常见，
 * mermaid 自己也接受），但明确写着别的图名的就不扫 —— 这条是单测钉着的：
 * 把 `pie` 当 flowchart 扫会切出假标签，改字就会写坏用户的图。
 */
export function diagramType(src: string): "flowchart" | "er" | "state" | "other" {
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    if (/^erDiagram\b/i.test(line)) return "er";
    if (/^stateDiagram(-v2)?\b/i.test(line)) return "state";
    if (/^(flowchart|graph)\b/i.test(line)) return "flowchart";
    return OTHER_HEADERS.test(line) ? "other" : "flowchart";
  }
  return "other";
}

function scanFlowchart(src: string): LabelSpan[] {
  const out: LabelSpan[] = [];
  let edgeSeq = 0;
  let i = 0;
  let atLineHead = true;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") {
      atLineHead = true;
      i++;
      continue;
    }
    if (atLineHead && (ch === " " || ch === "\t")) {
      i++;
      continue;
    }
    atLineHead = false;
    if (src.startsWith("%%", i)) {
      // 注释行（含 `%%{init}%%` 指令）整行跳过：指令里的花括号不是标签
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (!OPEN_HEADS.has(ch)) {
      i++;
      continue;
    }
    if (ch === "|") {
      const b = matchBody(src, i + 1, "|");
      if (b && b.text.trim()) {
        out.push({ kind: "edge", id: `edge#${edgeSeq++}`, ...b, open: "|", close: "|", multiline: true });
        i = b.bodyTo + 1; // 跳过结束竖线
        continue;
      }
      i++;
      continue;
    }
    const id = idBefore(src, i);
    if (!id) {
      i++;
      continue;
    }
    let hit = false;
    for (const [open, close] of NODE_FORMS) {
      if (!src.startsWith(open, i)) continue;
      const b = matchBody(src, i + open.length, close);
      // **空标签不认**（`A[]`）：图上没有可显示的文字，既没得折，也不该被当成可改的一段
      if (!b || !b.text.trim()) continue;
      out.push({ kind: "node", id, ...b, open, close, multiline: true });
      i = b.bodyTo + close.length;
      hit = true;
      break;
    }
    if (!hit) i++;
  }
  return out;
}

/* ------------------------------------------------- erDiagram / stateDiagram */

/**
 * 逐行扫描。
 *
 * `at0` 是**这行去掉缩进后的第一个字符在整篇源码里的绝对偏移**
 * （行首偏移 + 缩进量）。只给缩进量不给行首偏移是 126 第一版的 bug：
 * 所有 ER / state 的区间都从第二行起整体前移，`slice(from,to)` 切出来是别的行的字。
 */
function eachLine(src: string, fn: (raw: string, text: string, at0: number) => void): void {
  let pos = 0;
  for (const raw of src.split("\n")) {
    const text = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    fn(raw, text, pos + indent);
    pos += raw.length + 1;
  }
}

/** 带引号的 token → 去掉引号后的正文区间 */
function quotedSpan(token: string, at: number, kind: LabelKind, id: string, domHint?: string): LabelSpan | null {
  const q = token[0];
  if ((q !== '"' && q !== "'") || token.length < 2 || token[token.length - 1] !== q) return null;
  return {
    kind,
    id,
    text: token.slice(1, -1),
    from: at + 1,
    to: at + token.length - 1,
    bodyFrom: at,
    bodyTo: at + token.length,
    open: q,
    close: q,
    quoted: true,
    multiline: false,
    domHint,
  };
}

/** 裸 token（到行尾或本身就是个词）→ 文字区间 */
function bareSpan(
  token: string,
  at: number,
  kind: LabelKind,
  id: string,
  o: { domHint?: string; singleWord?: boolean } = {}
): LabelSpan {
  return {
    kind,
    id,
    text: token,
    from: at,
    to: at + token.length,
    bodyFrom: at,
    bodyTo: at + token.length,
    open: "",
    close: "",
    quoted: false,
    multiline: false,
    domHint: o.domHint,
    singleWord: o.singleWord,
  };
}

/** 按空白切 token，**引号包住的算一个**（属性注释里有空格）。返回 token 与它的绝对偏移 */
function splitTokens(text: string, base: number): { tok: string; at: number }[] {
  const out: { tok: string; at: number }[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const start = i;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      i++;
      while (i < text.length && text[i] !== q) i++;
      i = Math.min(i + 1, text.length);
    } else {
      while (i < text.length && !/\s/.test(text[i])) i++;
    }
    out.push({ tok: text.slice(start, i), at: base + start });
  }
  return out;
}

/**
 * erDiagram：关系标签、实体块里的属性行都能改；**实体名不能改**
 * （它在关系行里被引用多次，改一处就对不上 —— 解析出来只为给出拒绝理由）。
 */
function scanEr(src: string): LabelSpan[] {
  const out: LabelSpan[] = [];
  let edgeSeq = 0;
  let inEntity = false;
  eachLine(src, (raw, text, at0) => {
    if (!text || text.startsWith("%%") || /^erDiagram\b/i.test(text)) return;
    if (text === "}") {
      inEntity = false;
      return;
    }
    /** 引号 token 优先按 quoted 解析，解析不了再退回裸 token */
    const span = (tok: string, at: number, kind: LabelKind, id: string, domHint?: string): LabelSpan =>
      quotedSpan(tok, at, kind, id, domHint) ?? bareSpan(tok, at, kind, id, { domHint });

    // 实体块头：`名字 {`
    if (/\{\s*$/.test(text)) {
      const nameTok = text.replace(/\s*\{\s*$/, "").trim();
      out.push(span(nameTok, at0 + text.indexOf(nameTok), "id", nameTok));
      inEntity = true;
      return;
    }
    if (inEntity) {
      // 属性行：type name [keys] ["comment"]
      const parts = splitTokens(text, at0);
      if (parts.length < 2) return;
      const [type, name, third, fourth] = parts;
      out.push(bareSpan(type.tok, type.at, "text", "attr-type", { domHint: "attribute-type", singleWord: true }));
      // 属性名带引号时允许空格；裸 token 才是「一个词」
      out.push(
        quotedSpan(name.tok, name.at, "text", "attr-name", "attribute-name") ??
          bareSpan(name.tok, name.at, "text", "attr-name", { domHint: "attribute-name", singleWord: true })
      );
      // 注释认「以引号开头的那个 token」；剩下那个才是键标记（PK/FK/UK）
      const comment = [third, fourth].find((p) => p && /^["']/.test(p.tok));
      const keys = [third, fourth].find((p) => p && p !== comment);
      if (keys) out.push(bareSpan(keys.tok, keys.at, "text", "attr-keys", { domHint: "attribute-keys", singleWord: true }));
      if (comment) out.push(span(comment.tok, comment.at, "text", "attr-comment", "attribute-comment"));
      return;
    }
    // 关系行：`A ||--o{ B : "标签"`（没有 `--` 或没有 `:` 就不当关系）
    if (!text.includes("--")) return;
    const colon = text.indexOf(":");
    if (colon < 0) return;
    const label = text.slice(colon + 1).trim();
    if (!label) return;
    // 序号只取一次：写成 `quotedSpan(…, \`edge#${edgeSeq++}\`) ?? bareSpan(…, \`edge#${edgeSeq++}\`)`
    // 会让 `??` 两边各自增一次，第一条边就成了 edge#1
    const id = `edge#${edgeSeq++}`;
    out.push(span(label, at0 + text.indexOf(label, colon), "edge", id));
  });
  return out;
}

/**
 * stateDiagram-v2：迁移标签、`state "描述" as X` 的描述、note 正文能改；
 * **状态名不能改**（同上，它是被引用的标识符）。
 */
function scanState(src: string): LabelSpan[] {
  const out: LabelSpan[] = [];
  let edgeSeq = 0;
  const seen = new Set<string>();
  eachLine(src, (raw, text, at0) => {
    if (
      !text ||
      text.startsWith("%%") ||
      /^stateDiagram/i.test(text) ||
      /^direction\b/i.test(text) ||
      /^left to right direction$/i.test(text) ||
      /^hide\s+empty\s+description$/i.test(text)
    )
      return;
    // `state "描述" as ID`
    const desc = /^state\s+("[^"]*"|'[^']*')\s+as\s+\S+\s*$/.exec(text);
    if (desc) {
      const s = quotedSpan(desc[1], at0 + text.indexOf(desc[1]), "text", "state-desc", "stateDescription");
      if (s) out.push(s);
      return;
    }
    // `note left|right|top|bottom of ID : 正文`
    const note = /^note\s+(?:left|right|top|bottom)\s+of\s+\S+\s*:\s*(.+)$/i.exec(text);
    if (note) {
      out.push(bareSpan(note[1].trim(), at0 + text.indexOf(note[1], text.indexOf(":")), "text", "note", { domHint: "note" }));
      return;
    }
    // 迁移：`A --> B : 标签`（含 `-->` 才算；没 `:` 就没有标签）
    if (text.includes("-->")) {
      const colon = text.indexOf(":");
      const head = colon >= 0 ? text.slice(0, colon) : text;
      // 两端是**状态名（标识符）**：解析出来只为在双击状态方框时给得出具体理由
      // （渲染出来的节点标签就是这些名字，不登记的话双击会毫无反应，像坏了）
      for (const side of head.split("-->")) {
        const name = side.trim();
        if (!name || name === "[*]" || seen.has(name)) continue;
        seen.add(name);
        out.push(bareSpan(name, at0 + text.indexOf(name), "id", name));
      }
      if (colon >= 0) {
        const label = text.slice(colon + 1).trim();
        if (label) {
          const id = `edge#${edgeSeq++}`; // 序号只取一次（`??` 两边各写一次会增两下）
          const at = at0 + text.indexOf(label, colon);
          out.push(quotedSpan(label, at, "edge", id) ?? bareSpan(label, at, "edge", id));
        }
      }
      return;
    }
    // 光秃秃的状态声明 `ID`（或 `state ID`）→ 标识符，解析出来只为给出拒绝理由
    const bare = /^(?:state\s+)?(\S+)\s*$/.exec(text);
    if (bare && !bare[1].includes(":")) {
      out.push(bareSpan(bare[1], at0 + text.indexOf(bare[1]), "id", bare[1]));
    }
  });
  return out;
}

/* ------------------------------------------------------------------ 折行 */

/** 一个字符是不是「可以单独断行」的（中日韩文字与全角标点） */
function isCjk(ch: string): boolean {
  return /[⺀-鿿豈-﫿＀-￯ -〿]/.test(ch);
}

/**
 * 把一段文字切成「断行单元」：中文一字一单元，英文按词，空格跟着前一个单元走
 * （这样断行时不会在行首留下空格）。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  for (const ch of text) {
    if (isCjk(ch)) {
      if (word) tokens.push(word), (word = "");
      tokens.push(ch);
    } else if (ch === " " || ch === "\t") {
      if (word) tokens.push(word), (word = "");
      tokens.push(ch); // 空格自成一单元，断行时允许被吃掉
    } else {
      word += ch;
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

/**
 * 按像素宽度给**一段标签文字**折行，返回折好的行数组。
 *
 * `measure` 是注入的：单测给假函数（中文 1em、英文 0.5em）就能钉住断行位置，
 * 运行时用 `createTextMeasurer` 走 canvas —— **和浏览器同一套字宽**，
 * 这正是「我们折的行数 == 浏览器显示的行数」的前提。
 */
export function wrapLabelLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  const flush = () => {
    lines.push(cur.replace(/[ \t]+$/, ""));
    cur = "";
    curW = 0;
  };
  for (const tk of tokenize(text)) {
    const w = measure(tk);
    if (cur && curW + w > maxWidth) {
      // 行首的空格没意义，丢掉再断行
      if (curW > 0 && tk.trim() === "") continue;
      flush();
    }
    // 单个单元就超宽（长 URL、连续英文）→ 按字硬切，不然一定溢出
    if (!cur && w > maxWidth) {
      let piece = "";
      let pieceW = 0;
      for (const ch of tk) {
        const cw = measure(ch);
        if (piece && pieceW + cw > maxWidth) {
          lines.push(piece);
          piece = "";
          pieceW = 0;
        }
        piece += ch;
        pieceW += cw;
      }
      cur = piece;
      curW = pieceW;
      continue;
    }
    cur += tk;
    curW += w;
  }
  if (cur.trim()) flush();
  return lines.length ? lines : [""];
}

/** 标签里已有的换行（`<br>` / `<br/>` / `<br />`） */
const BR_RE = /<br\s*\/?>/i;

/**
 * 折一整段标签：先按已有的 `<br>` 分段（**不重复折**，保证幂等），
 * 每段再按宽度折，最后用 `<br/>` 接回去。
 */
export function wrapLabel(text: string, maxWidth: number, measure: (s: string) => number): string {
  return text
    .split(BR_RE)
    .flatMap((seg) => wrapLabelLines(seg, maxWidth, measure))
    .join("<br/>");
}

/**
 * 渲染前预处理：把源码里每个标签按 `maxWidth` 折行（插 `<br/>`）。
 *
 * 只在**喂给 mermaid 之前**调用；用户文档里存的是没折过的原文。
 * 从后往前替换，前面的偏移才不会被打乱。
 *
 * **只折 flowchart**（`span.multiline` 就是那个筛子）：ER 的属性行、state 的迁移标签
 * 都是单行语法，插 `<br/>` 等于把一行劈成两行 = 改坏结构。
 */
export function preWrapMermaid(
  src: string,
  o: { maxWidth: number; measure: (s: string) => number }
): string {
  const spans = scanMermaidLabels(src).filter((s) => s.multiline && s.text.trim().length > 0);
  let out = src;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    const wrapped = wrapLabel(s.text, o.maxWidth, o.measure);
    if (wrapped === s.text) continue;
    out = out.slice(0, s.from) + wrapped + out.slice(s.to);
  }
  return out;
}

/* -------------------------------------------------- 通用兜底：渲染文字 → 源码 */

/**
 * 127：把**渲染出来的那行字**反查回源码里的候选位置。
 *
 * 为什么需要它：125/126 是按图类型解析的（flowchart / ER / state 各写一遍），
 * 而 mermaid 的图类型有二十来种，逐个写既写不完也跟不上它的版本。
 * 通用路子换成**从产物倒推**：屏幕上这行字，在源码里只出现一次，那它就是这行字的出处。
 *
 * 三条硬约束，缺一条就**别给可改标记**（认错会把用户的图改坏，比改不动严重得多）：
 * ① 只在 `kind === "text"` 的兜底路上用，前面的类型专属解析先走 —— 它们知道定界符、知道哪一处是标识符；
 * ② 命中次数必须**正好等于 1**。0 次是找不到（被 mermaid 改写过了），多次是有歧义，都拒绝；
 * ③ 围栏代码块（``` 里面）的行不参与查找 —— mermaid 会把 ```` ``` ```` 之类当字面量显示，
 *    那几行不是标签，撞上它们等于把注释当正文改。
 */
export function findTextSpans(src: string, rendered: string): LabelSpan[] {
  const t = rendered.trim();
  if (!t) return [];
  const out: LabelSpan[] = [];
  let inFence = false;
  let order = 0;
  const push = (s: Omit<LabelSpan, "id">) => out.push({ ...s, id: "text#" + order++ });

  eachLine(src, (_raw, line, at0) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || !line) return;

    // ① 整行就是这段文字（sequence 的 `participant 报销单`、journey 的任务名、mindmap 的缩进节点）
    if (line === t) {
      const at = at0;
      push({
        kind: "text",
        text: line,
        from: at,
        to: at + line.length,
        bodyFrom: at,
        bodyTo: at + line.length,
        open: "",
        close: "",
        quoted: false,
        multiline: false,
      });
      return;
    }

    // ② 带引号的字面量（`"本次验收金额"`、关系标签 `: "发起验收"`）
    const quotedHits = indexOfAll(line, `"${t}"`);
    for (const i of quotedHits) {
      const at = at0 + i;
      push({
        kind: "text",
        text: t,
        from: at + 1,
        to: at + t.length + 1,
        bodyFrom: at,
        bodyTo: at + t.length + 2,
        open: '"',
        close: '"',
        quoted: true,
        multiline: false,
      });
    }

    // ③ 行内裸着的一段（gantt `写草稿: 2026-01-01, 3d`、journey `小王: 提交申请`）
    // 整行相等时已在 ① 处理；引号形式命中时也别再把引号里面那段重复挂一遍，
    // 否则同一个字有两个候选，`length === 1` 的唯一性判据就把它们都拒了（明明是能用 A 案）。
    if (quotedHits.length === 0) {
      for (const i of indexOfAll(line, t)) {
        const at = at0 + i;
        push({
          kind: "text",
          text: t,
          from: at,
          to: at + t.length,
          bodyFrom: at,
          bodyTo: at + t.length,
          open: "",
          close: "",
          quoted: false,
          multiline: false,
        });
      }
    }
  });
  return out;
}

/** 全部出现位置（不允许重叠，`indexOf` 逐个往后找就够了） */
function indexOfAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/* -------------------------------------------------------------- 改字写回 */

export type LabelEditResult = { ok: true; src: string; quoted: boolean } | { ok: false; reason: string };

/**
 * 把某个标签的文字换成 `input`，**只动那一段**，定界符与其余源码一个字符都不碰。
 *
 * 四条判据（都是「不许悄悄写坏用户的图」）：
 * ① 空标签拒绝（图里没有空标签，多半是误操作）；
 * ② 位置是单行的（ER 属性行、state 迁移标签）却打了换行 → 拒绝，不折成 `<br/>`；
 * ③ 标识符位置（属性类型 / 属性名 / 键标记）不许出现空格；
 * ④ 新文字里有**会提前结束标签的字符**时自动加引号保住它；连双引号都有就没法安全表示 → 拒绝并说明。
 */
export function applyLabelEdit(src: string, span: LabelSpan, input: string): LabelEditResult {
  if (/\r?\n/.test(input) && !span.multiline) {
    return { ok: false, reason: t("mermaid.oneLineOnly") };
  }
  // contenteditable 里的换行（Shift+Enter）只在支持的地方落成 mermaid 的 <br/>
  const text = (span.multiline ? input.replace(/\r?\n/g, "<br/>") : input).replace(/^\s+|\s+$/g, "");
  if (!text) return { ok: false, reason: t("mermaid.emptyLabel") };
  if (span.singleWord && /\s/.test(text)) {
    return { ok: false, reason: t("mermaid.identifierRule") };
  }
  const breaksOut = span.close !== "" && text.includes(span.close);
  if (text.includes('"') && (breaksOut || span.quoted)) {
    return {
      ok: false,
      reason: tf("mermaid.wouldBreak", { text: span.close }),
    };
  }
  const quoted = span.quoted || breaksOut;
  const body = quoted ? `"${text}"` : text;
  return { ok: true, src: src.slice(0, span.bodyFrom) + body + src.slice(span.bodyTo), quoted };
}

/**
 * 源码里的标签文字 → 就地编辑区要显示的 HTML。
 *
 * 这条是 125 踩出来的真缺陷：编辑区若直接用**渲染产物**的文字，
 * 里面会带着我们为了折行**在渲染时插进去的 `<br/>`**（innerText 把它们变成 `\n`），
 * 提交时就按「用户自己换的行」写回源码 —— 于是取消一次编辑，
 * 源码里凭空多出 `<br/>`（探针实测：`A[…主管<br/>确认并出具…]`）。
 *
 * 正解是：**编辑的内容来自源码那一段文字**，不是来自屏幕上的渲染结果。
 * 用户自己写的 `<br>` 原样保留（它确实是换行），其余一律转义 ——
 * 编辑区里绝不能出现活的标签，否则 `<img onerror>` 这类东西会在 contenteditable 里被执行。
 */
export function labelToEditableHtml(text: string): string {
  return text
    .split(/(<br\s*\/?>)/i)
    .map((part) =>
      /^<br\s*\/?>$/i.test(part)
        ? "<br>"
        : part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    )
    .join("");
}

/* ---------------------------------------------------------------- 量字宽 */
/**
 * canvas 量字宽。
 *
 * **必须和 mermaid 用同一套字体与字号**，否则「我们折的行数」和「浏览器显示的行数」
 * 不一致，溢出就又回来了。字号在 `mermaid.ts` 里用 `themeVariables.fontSize` 钉死，
 * 这边按同一个值建测量器。
 */
export function createTextMeasurer(font: string): (s: string) => number {
  const ctx =
    typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  if (ctx) ctx.font = font;
  const cache = new Map<string, number>();
  const one = (ch: string): number => {
    let w = cache.get(ch);
    if (w === undefined) {
      w = ctx ? ctx.measureText(ch).width : 16; // 没 canvas（单测/SSR）时按 16px 估
      cache.set(ch, w);
    }
    return w;
  };
  return (s: string) => {
    if (s.length <= 1) return one(s);
    // 整串量一次最准（字距、连字），失败再退回逐字
    const whole = ctx ? ctx.measureText(s).width : 0;
    if (whole) return whole;
    return [...s].reduce((a, ch) => a + one(ch), 0);
  };
}

/* ------------------------------------------- 159：标识符改名与别名（纯函数） */

/**
 * 「一起改名」与「只改显示（别名）」的底层。
 *
 * 三条口径是这颗功能的全部风险，都体现在代码里，别绕过去：
 * ① **只动标识符语法位**：先把"一定不是标识符"的区间（标签正文、引号内容、注释、
 *    关系行冒号之后、ER 属性行）刷成空格，再在剩下的字符里按整词找名字 ——
 *    `B[读 A 的值]` 里那个 A 是内容不是引用，一个字节都不许动；
 * ② **整词匹配**：少了这一条，`ADMIN` 会被当成含 `A` 的位置一起改掉；
 * ③ **拿不准就拒绝，拒绝时一个字都不写**：图类型不认识 / 新名字不合法 /
 *    新名字已经是别的名字 / 源码里没找到 —— 四种理由都说得出口。
 */

/** 合法标识符（改名与别名共用）：字母 / 数字 / 下划线 / 汉字，不含空格与定界符。**汉字区间用 \u 写** */
const RENAMEABLE_ID = /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*$/;

/**
 * 扫描时「一个标识符」的字符集。**刻意不含 `-`**：`A-->B` 里减号是箭头的一部分，
 * 含进来会把 `A--` 当一个名字，等于每行都认错。
 */
const ID_RUN = /[A-Za-z0-9_\u4e00-\u9fff]+/g;

export type RenameKind = "flowchart" | "er" | "state" | "sequence" | "none";

/** 图类型看第一行（跳过空行与注释行） */
export function renameKindOf(src: string): RenameKind {
  const first = src.split(/\r?\n/).find((l) => l.trim() !== "" && !l.trim().startsWith("%%")) ?? "";
  const head = first.trim().toLowerCase();
  if (/^(flowchart|graph)\b/.test(head)) return "flowchart";
  if (head.startsWith("erdiagram")) return "er";
  if (head.startsWith("statediagram")) return "state";
  if (head.startsWith("sequencediagram")) return "sequence";
  return "none";
}

/** 各图类型的关键字：整词命中就当作「不是标识符」刷掉（一律小写比较） */
const MASK_KEYWORDS: Record<RenameKind, Set<string>> = {
  flowchart: new Set(["subgraph", "end", "direction", "classdef", "click", "linkstyle", "style", "class"]),
  er: new Set(["erdiagram", "pk", "fk", "uk"]),
  state: new Set([
    "statediagram",
    "state",
    "as",
    "note",
    "left",
    "right",
    "top",
    "bottom",
    "of",
    "direction",
    "hide",
    "empty",
    "description",
    "class",
    "click",
    "linkstyle",
  ]),
  sequence: new Set([
    "sequencediagram",
    "participant",
    "actor",
    "as",
    "note",
    "over",
    "loop",
    "alt",
    "else",
    "end",
    "opt",
    "par",
    "and",
    "critical",
    "break",
    "activate",
    "deactivate",
    "autonumber",
    "box",
    "title",
  ]),
  none: new Set<string>(),
};

interface Run {
  text: string;
  from: number;
  to: number;
}

/** 切出「标识符候选」的整词区间（base 用来把行内下标换成源码下标） */
function runsOf(text: string, base = 0): Run[] {
  const out: Run[] = [];
  ID_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_RUN.exec(text))) out.push({ text: m[0], from: base + m.index, to: base + m.index + m[0].length });
  return out;
}

/**
 * 产出一张与 `src` **等长**的掩码副本：只保留标识符语法位上的字符，其余换成空格。
 * 等长是关键 —— 掩码里的下标可以直接当源码里的下标用，不用二次换算。
 */
function identifierMask(src: string, kind: RenameKind): string {
  const chars = src.split("");
  const blank = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < Math.min(chars.length, to); i++) chars[i] = " ";
  };

  let inEntityBlock = false;
  let headerSeen = false;

  eachLine(src, (raw, text, at0) => {
    if (!text) return;
    const lineStart = at0 - (raw.length - raw.trimStart().length);
    const lineEnd = lineStart + raw.length;

    if (text.startsWith("%%")) {
      blank(lineStart, lineEnd);
      return;
    }
    // 图类型声明行（flowchart LR / erDiagram / …）整行不是标识符
    if (!headerSeen) {
      headerSeen = true;
      blank(lineStart, lineEnd);
      return;
    }

    if (kind === "er") {
      // 块头 `名字 {`：`{` 之后不是标识符；块里的属性行整行不是标识符（那是另一个命名空间）
      if (text === "}") {
        inEntityBlock = false;
        blank(lineStart, lineEnd);
        return;
      }
      if (inEntityBlock) {
        blank(lineStart, lineEnd);
        return;
      }
      if (/\{\s*$/.test(text)) {
        inEntityBlock = true;
        blank(at0 + text.indexOf("{"), lineEnd);
      }
    }

    // 引号包住的整段都不是标识符
    for (let i = at0; i < lineEnd; i++) {
      const q = chars[i];
      if (q !== '"' && q !== "'") continue;
      let j = i + 1;
      while (j < lineEnd && chars[j] !== q) j++;
      blank(i, Math.min(j + 1, lineEnd));
      i = j;
    }

    if (kind === "flowchart" || kind === "state") {
      // 标签定界符 `[...]` `(...)` `{...}` `|...|`：里面是显示文字
      for (let i = at0; i < lineEnd; i++) {
        const open = chars[i];
        const close = open === "[" ? "]" : open === "(" ? ")" : open === "{" ? "}" : open === "|" ? "|" : null;
        if (!close) continue;
        let j = i + 1;
        while (j < lineEnd && chars[j] !== close) j++;
        blank(i, j < lineEnd ? j + 1 : lineEnd);
        if (j >= lineEnd) break;
        i = j;
      }
      if (/^(classdef|click|linkstyle)\b/i.test(text)) blank(lineStart, lineEnd);
      if (/^class\b/i.test(text)) {
        // `class A,B nodeStyle`：最后那个是被套的样式名，不是节点
        const runs = runsOf(chars.slice(at0, lineEnd).join(""), at0);
        const last = runs[runs.length - 1];
        if (last) blank(last.from, last.to);
      }
    }

    // 冒号之后一律是文字（ER 关系标签、state 迁移标签、sequence 消息正文）
    for (let i = at0; i < lineEnd; i++) {
      if (chars[i] === ":") {
        blank(i, lineEnd);
        break;
      }
    }

    // `participant A as 显示名`：` as ` 之后是显示名，不是标识符
    if (kind === "sequence" && /^(participant|actor)\b/i.test(text)) {
      const as = /\s+as\s+/i.exec(text);
      if (as) blank(at0 + (as.index ?? 0), lineEnd);
    }

    // 关键字整词刷掉
    for (const r of runsOf(chars.slice(at0, lineEnd).join(""), at0)) {
      if (MASK_KEYWORDS[kind].has(r.text.toLowerCase())) blank(r.from, r.to);
    }
  });

  return chars.join("");
}

/** 「一起改名」的结果：成功给新源码与处数，失败给**说得出口的理由** */
export type RenameResult = { ok: true; src: string; count: number } | { ok: false; reason: string };

/**
 * 这个名字在源码里作为**标识符**出现的所有位置（界面用它算按钮上的处数）。
 * 图类型不认识时返回空表 —— 空表就是"不许改"的形状，不是"没找到"。
 */
export function scanIdentifierOccurrences(src: string, id: string): { from: number; to: number }[] {
  const kind = renameKindOf(src);
  if (kind === "none") return [];
  return runsOf(identifierMask(src, kind))
    .filter((r) => r.text === id)
    .map((r) => ({ from: r.from, to: r.to }));
}

export function applyIdentifierRename(src: string, id: string, nextId: string): RenameResult {
  const kind = renameKindOf(src);
  if (kind === "none") return { ok: false, reason: t("mermaid.renameUnsupported") };
  if (!RENAMEABLE_ID.test(nextId)) return { ok: false, reason: tf("mermaid.renameBadId", { name: nextId }) };

  const mask = identifierMask(src, kind);
  const all = runsOf(mask);
  const hits = all.filter((r) => r.text === id);
  if (!hits.length) return { ok: false, reason: tf("mermaid.renameNotFound", { name: id }) };
  if (nextId !== id && all.some((r) => r.text === nextId))
    return { ok: false, reason: tf("mermaid.renameClash", { name: nextId }) };

  let out = src;
  for (const r of [...hits].reverse()) out = out.slice(0, r.from) + nextId + out.slice(r.to);
  return { ok: true, src: out, count: hits.length };
}

/** 「只改显示」在 ER / state / sequence 里的落点：别名**就地改写**，没有别名才新建一条 */
export type AliasResult = { ok: true; src: string; created: boolean } | { ok: false; reason: string };

/** 名字要进正则，先转义 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyAliasSet(src: string, id: string, display: string): AliasResult {
  const kind = renameKindOf(src);
  if (kind === "none") return { ok: false, reason: t("mermaid.renameUnsupported") };
  // flowchart 的"显示名"就是节点标签本身，走 125 那条 applyLabelEdit，不在这里再插一份
  if (kind === "flowchart") return { ok: false, reason: t("mermaid.aliasViaLabel") };
  if (!RENAMEABLE_ID.test(id)) return { ok: false, reason: tf("mermaid.renameNotFound", { name: id }) };
  if (!display.trim() || display.includes('"') || /[\r\n]/.test(display))
    return { ok: false, reason: t("mermaid.aliasBadText") };

  const lines = src.split("\n");
  /**
   * 别名声明必须独立成行：挂到关系行尾巴上是 Parse error（实测），
   * 追加第二份又会按图类型不同表现不一致（state 出两个框 / ER 第一个赢 / sequence 最后一个赢）。
   */
  const specs = {
    er: {
      re: new RegExp(`^(\\s*)${escapeRe(id)}\\s*\\[[^\\]]*\\]\\s*$`),
      make: (indent: string, _line?: string) => `${indent}${id}["${display}"]`,
    },
    state: {
      re: new RegExp(`^(\\s*)state\\s+"[^"]*"\\s+as\\s+${escapeRe(id)}\\s*$`, "i"),
      make: (indent: string, _line?: string) => `${indent}state "${display}" as ${id}`,
    },
    sequence: {
      re: new RegExp(`^(\\s*)(participant|actor)\\s+${escapeRe(id)}(?:\\s+as\\s+.*)?\\s*$`, "i"),
      make: (indent: string, line: string) => {
        const kw = /^\s*actor\b/i.test(line) ? "actor" : "participant";
        return `${indent}${kw} ${id} as ${display}`;
      },
    },
  } as const;
  const spec = specs[kind as "er" | "state" | "sequence"];

  for (let i = 0; i < lines.length; i++) {
    if (!spec.re.test(lines[i])) continue;
    const m = spec.re.exec(lines[i]);
    // **就地改写**这一行，绝不新插一条（重复声明的行为各图类型不一致）
    lines[i] = spec.make(m?.[1] ?? "  ", lines[i]);
    return { ok: true, src: lines.join("\n"), created: false };
  }

  // 没有别名 → 在图类型声明那一行之后补一条独立语句
  let head = 0;
  while (head < lines.length && (lines[head].trim() === "" || lines[head].trim().startsWith("%%"))) head++;
  const next = lines[head + 1] ?? "";
  const indent = /^(\s*)/.exec(next)?.[1] || "  ";
  lines.splice(head + 1, 0, spec.make(indent, next));
  return { ok: true, src: lines.join("\n"), created: true };
}

/* ------------------------------------------- 159 片 2：这一处背后有没有标识符 */

/** 「一起改名」那颗键要改的东西 */
export interface RenameTarget {
  /** 要改的名字（标识符，不是显示文字） */
  id: string;
  /** 这个名字作为标识符出现在几处 —— 按钮文案把它写出来，点之前就知道动多大范围 */
  count: number;
  /**
   * `true` = 双击的那段字**本身就是**标识符（ER 实体头、state 状态名）。
   * 这时「只改显示」不能把标识符换成一段带空格的文字（那是改名，而且是非法改名），
   * 得走别名那条路 `applyAliasSet`；`false` = 双击的是标签文字，名字在别处，
   * 「只改显示」照 125 的老路 `applyLabelEdit` 只换那一段。
   */
  self: boolean;
}

/** token 开头那段合法标识符：`CUSTOMER["客户"]` → `CUSTOMER`（**字符区间用 \u 写**，见 139 那条教训） */
const ID_HEAD = /^[A-Za-z0-9_\u4e00-\u9fff]+/;

function headIdentifier(token: string): string {
  return ID_HEAD.exec(token)?.[0] ?? "";
}

/** 某个绝对下标所在的那一行（去缩进、去行尾空白） */
function lineAt(src: string, at: number): string {
  const from = src.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  let to = src.indexOf("\n", from);
  if (to < 0) to = src.length;
  return src.slice(from, to).trim();
}

/**
 * 这段**文字**所在那一行背后的标识符 —— 只有两种形状算"有"：
 * `state "描述" as S2`（描述是显示名，名字是 S2）、
 * `participant A as 显示名` / `actor A as 显示名`（同上）。
 * 迁移标签、边标签、note 正文、ER 属性行都落不进这两种形状 → 返回空串，界面只给一颗键。
 */
function owningIdentifierOfLine(src: string, span: LabelSpan): string {
  const line = lineAt(src, span.from);
  const stateAs = /^state\s+("[^"]*"|'[^']*')\s+as\s+(\S+)\s*$/i.exec(line);
  if (stateAs) return stateAs[2];
  const partAs = /^(?:participant|actor)\s+(\S+)\s+as\s+\S+\s*$/i.exec(line);
  if (partAs) return partAs[1];
  return "";
}

/**
 * 双击这一处，能不能"连名字一起改"。
 *
 * 三条口径（界面摆几颗键、点下去改什么，全看这张表）：
 * ① **图类型不认识就 null** —— 别摆一颗点下去必然被拒绝的键；
 * ② **认不出名字也 null**：`edge#3`、`attr-name`、`text#0` 这类定位键不是标识符，
 *    `!RENAMEABLE_ID.test(id)` 一道就挡住了；
 * ③ **名字在源码里数不到标识符位就 null**（`count === 0`）——
 *    按钮上的处数必须是真处数，不能点了才发现"源码里没找到这个名字"。
 */
export function renameTargetOf(src: string, span: LabelSpan): RenameTarget | null {
  if (renameKindOf(src) === "none") return null;
  let id = "";
  let self = false;
  if (span.kind === "id") {
    id = headIdentifier(span.text);
    self = true;
  } else if (span.kind === "node") {
    id = span.id;
  } else if (span.kind === "text") {
    id = owningIdentifierOfLine(src, span);
  }
  if (!id || !RENAMEABLE_ID.test(id)) return null;
  const count = scanIdentifierOccurrences(src, id).length;
  if (count === 0) return null;
  return { id, count, self };
}

/**
 * 双击**标识符**时，编辑区里该摆哪段文字。
 *
 * 屏幕上那个方框里的字可能就是名字本身（`S2`），也可能是别名（`CUSTOMER["客户"]` 渲成「客户」）。
 * 「只改显示」编辑的是**显示名**，所以带别名时必须把别名剥出来当编辑内容 ——
 * 直接把 `CUSTOMER["客户"]` 整串交给用户改，落盘就是别名语句里塞着一串带括号的名字。
 * 没有别名时返回原文（就是名字本身），用户输入的新文字会被当成第一个显示名。
 */
export function aliasTextOf(span: LabelSpan, id: string): string {
  const rest = span.text.slice(id.length).trim();
  if (!rest.startsWith("[") || !rest.endsWith("]") || rest.length < 2) return span.text;
  const inner = rest.slice(1, -1).trim();
  const q = inner[0];
  if ((q === '"' || q === "'") && inner.length >= 2 && inner[inner.length - 1] === q) return inner.slice(1, -1);
  return inner;
}

/**
 * 159 片 3：**同一段文字出现在多处**时，把「屏幕上第 k 个元素」对上「源码里第 k 个区间」。
 *
 * 127 的旧口径是"多次就全拒"，代价是两条一模一样的消息根本改不动。
 * 这里改成按顺序配对，但**配对结果要自己经得起核对**：
 * ① 数量必须相等（多一个少一个都说明渲染顺序与源码顺序对不上，或者有的被 mermaid 吃了）；
 * ② **逐对文字必须相同** —— 这一条是防"顺序被打乱"的：mermaid 哪天换了渲染顺序，
 *    第 1 个元素对上第 2 个区间，`texts[i] !== spans[i].text` 当场就散，整组退回"不给改"。
 * 任何一条不满足就返回全 null（宁可少认，不可错认 —— 认错会把用户别处的那段字改掉）。
 *
 * 两个列表都必须是**各自的正序**：`elements` 按 `querySelectorAll` 的文档顺序，
 * `spans` 来自逐行扫描的源码顺序。
 */
export function pairSpansByOrder(texts: string[], spans: LabelSpan[]): (LabelSpan | null)[] {
  if (texts.length === 0 || texts.length !== spans.length) return texts.map(() => null);
  if (!texts.every((t, i) => spans[i].text === t)) return texts.map(() => null);
  return spans;
}
