import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 闸门：界面文案不许再硬编码中文（M3-134 i18n 之后必须守住）。
 *
 * 三道闸各管一层，**层与层之间不重叠**（139 就是被"以为覆盖到了"坑的）：
 *  1. `.vue` 的 `<template>`：文本节点（**含跨行、含 `{{ }}` 混排**）、
 *     `title` / `aria-label` / `placeholder` / `alt` 属性、以及
 *     `{{ ok ? "置顶" : "取消置顶" }}` 这种**写在插值表达式里的字面量**。
 *  2. `src/kernel/**` 的**全部字符串字面量**：JS 建元素时直接写进 DOM 的那批（139 补的缝）。
 *  3. `src/**` 里**属性名一看就是给人看的**那几处：`title:` / `label:` / `message:` / `hint:` /
 *     `tooltip:` / `placeholder:` / `text:` 与 `actions: [...]`，以及赋给
 *     `globalError` / `hint` / `detail` 的字面量。
 *
 * 逻辑字符串（`r.error !== "已取消"` 这类判断依据）**不在闸里** —— 翻成别的语言就废了。
 * 命中就红，并列出文件、行号与原文。**豁免必须写理由**：文件级写在 `FILE_ALLOW`，
 * 行内写 `// i18n-allow: 理由`（**没写理由的标记本身按违规处理**）。
 */
const FILE_ALLOW: Record<string, string> = {
  "blockPatch.ts": "三条 `throw new Error(...)` 是开发期断言（真触发说明程序错了），不是给人读的界面文案",
};

/**
 * 中日韩汉字范围。**刻意写 \u 转义而不是字面汉字**：这一行原本用字面汉字写，
 * 上界那个字被某次工具链写入吞掉了，剩下的半截在正则里退化成「某个字 或 连字符」，
 * 于是任何带 `-` 的字符串都算中文 —— 而它一直没报警，只因为当时还没人用它。
 * 同形字还有一坑：兼容表意区的 U+FA48 与主区的 U+8C48 是同一个字形，手打会把下界挪六千多码位。
 * **一道自己不验证的判据，比没有判据更危险**：所以「判据的判据」那条 it 正面拿「中文」二字
 * 过一遍 `CJK.test`，范围写坏了它先红。
 */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 行内豁免标记：`i18n-allow: 理由`（冒号后面必须有内容） */
const ALLOW_MARK = /i18n-allow:\s*(.*)/;

interface Hit {
  text: string;
  line: number; // 0 基
}

const lineOf = (src: string, offset: number): number => {
  let n = 0;
  for (let i = 0; i < offset; i++) if (src[i] === "\n") n++;
  return n;
};

/** 该命中是否被「本行或上一行」的 i18n-allow 标记豁免（标记没写理由 = 不豁免） */
function exempted(lines: string[], line: number): boolean {
  for (const i of [line - 1, line]) {
    const l = lines[i];
    if (!l) continue;
    const m = ALLOW_MARK.exec(l);
    if (m && m[1].trim().length > 0) return true;
  }
  return false;
}

/** 收集「没写理由的豁免标记」—— 它们自己就是违规，防止有人拿空标记把闸焊死 */
function bareMarks(lines: string[]): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const m = ALLOW_MARK.exec(l);
    if (m && m[1].trim().length === 0) out.push(`第 ${i + 1} 行的 i18n-allow 没写理由`);
  });
  return out;
}

function scanTemplate(src: string): Hit[] {
  const start = src.indexOf("<template>");
  const end = src.indexOf("</template>");
  if (start < 0 || end <= start) return [];
  const tpl = src.slice(start, end).replace(/<!--[\s\S]*?-->/g, (s) => " ".repeat(s.length));
  const hits: Hit[] = [];
  const push = (text: string, offset: number) => {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat && CJK.test(flat)) hits.push({ text: flat.slice(0, 60), line: lineOf(src, start + offset) });
  };
  // 文本节点：先把 {{ ... }} 表达式换成占位符，剩下的才是给人看的字（允许跨行）
  const stripped = tpl.replace(/\{\{[\s\S]*?\}\}/g, (s) => "#".repeat(s.length));
  for (const m of stripped.matchAll(/>([^<>]*)</g)) push(m[1].replace(/#+/g, " "), m.index ?? 0);
  for (const m of tpl.matchAll(/(?:title|aria-label|placeholder|alt)="([^"\n]*)"/g)) push(m[1], m.index ?? 0);
  // 插值表达式里的字面量（`{{ ok ? "置顶" : "取消置顶" }}` 这种，旧闸完全看不见）
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    for (const s of m[1].matchAll(/(["'])([^"'`$]*)\1/g)) push(s[2], (m.index ?? 0) + (s.index ?? 0));
  }
  return hits;
}

/** 属性名 / actions / 错误提示赋值 —— 一看就是「给人看」的那几处 */
const USER_PROP = /\b(?:title|label|hint|tooltip|placeholder|message|okText|cancelText|text)\s*:\s*(["'])([^"'`$\n]*)\1/g;
const ACTIONS = /actions:\s*\[([^\]]*)\]/g;
const COPY_ASSIGN = /\b(?:globalError|hint|detail|message)(?:\.value)?\s*=\s*(?:`([^`]*)`|(["'])([^"'`\n]*)\2)/g;

function scanUserProps(src: string): Hit[] {
  const hits: Hit[] = [];
  const each = (re: RegExp, pick: (m: RegExpExecArray) => string) => {
    for (const m of src.matchAll(re)) {
      const text = pick(m);
      if (text && CJK.test(text)) {
        hits.push({ text: text.replace(/\s+/g, " ").slice(0, 60), line: lineOf(src, m.index ?? 0) });
      }
    }
  };
  each(USER_PROP, (m) => m[2]);
  each(ACTIONS, (m) => m[1]);
  each(COPY_ASSIGN, (m) => m[1] ?? m[3] ?? "");
  return hits;
}

/** 出现在这些字符之后的 `/` 是正则起点，不是除法 */
const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">"]);
/** `return` / `typeof` 等关键字之后的 `/` 同样是正则起点 */
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|case|in|of|new|delete|void|do|else)\s*$/;

/**
 * 取出一份 TS 源码里的**字符串字面量内容**（含模板字符串；`${}` 插值递归扫），带行号。
 *
 * 注释和正则字面量一律跳过：前者是给人读的代码说明，后者是匹配规则不是文案。
 * 之所以手写小状态机，而不是「去掉注释后用正则抓引号」：像
 * `/^state\s+("[^"]*"|'[^']*')\s+as\s+\S+$/` 这种**正则里带引号**的写法（`mermaidLabels.ts` 真有），
 * 会让引号配对整个错位 —— 一段代码被当成字符串，途中顺到的中文全算命中，判据自己先误报。
 * 未闭合的引号 / 正则按「就地断开」处理，避免一个特殊字符把整份文件带偏。
 */
function collectStringLiterals(src: string): Hit[] {
  const out: Hit[] = [];
  let i = 0;
  let line = 0;
  let prevSig = ""; // 上一个有意义的代码字符（空白与注释不算）
  let tail = "";    // 最近若干字符，用来认关键字

  const skipRegex = () => {
    let inClass = false;
    i++; // 吃掉起始 /
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\n") { line++; break; } // 没闭合：当除法收场，别让后面全错位
      if (c === "\\") { i++; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) { i++; break; }
    }
    while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
  };

  const takeString = (quote: string) => {
    const startLine = line;
    i++; // 吃掉起始引号
    let val = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\n") {
        line++;
        if (quote !== "`") break; // 未闭合的 ' 或 "
      }
      if (c === "\\") { val += c + (src[i + 1] ?? ""); i += 2; continue; }
      if (c === quote) { i++; break; }
      if (quote === "`" && c === "$" && src[i + 1] === "{") {
        let depth = 1;
        let inner = "";
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "\n") line++;
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) break; }
          inner += src[i];
          i++;
        }
        i++; // 吃掉收尾 }
        for (const h of collectStringLiterals(inner)) out.push({ text: h.text, line: startLine });
        continue;
      }
      val += c;
      i++;
    }
    out.push({ text: val, line: startLine });
    prevSig = quote;
    tail += quote;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; tail += "\n"; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "/") {
      if (prevSig === "" || BEFORE_REGEX.has(prevSig) || KEYWORD_BEFORE_REGEX.test(tail)) {
        skipRegex();
        tail += "/";
        continue;
      }
      prevSig = "/";
      tail += "/";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { takeString(c); continue; }
    if (!/\s/.test(c)) prevSig = c;
    tail = (tail + c).slice(-32);
    i++;
  }
  return out;
}

const SRC = path.resolve(import.meta.dirname, "../../src");

function listFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");
const isI18n = (f: string) => rel(f).startsWith("i18n");

/** 文件:行号 原文（被行内标记豁免过的不报） */
function report(f: string, hits: Hit[], lines: string[]): string[] {
  return hits.filter((h) => !exempted(lines, h.line)).map((h) => `${rel(f)}:${h.line + 1}  ${h.text}`);
}

it("kernel 里 JS 注入 DOM 的文案都走字典（139 补的那道缝）", () => {
  const files = listFiles(path.join(SRC, "kernel"), /\.ts$/);
  // 目录结构变了这条要先红，否则「扫到 0 个文件」会被当成全绿
  expect(files.length, `只扫到 ${files.length} 个 kernel 文件，路径或结构变了`).toBeGreaterThan(20);
  const bad: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const hits = collectStringLiterals(src).filter((h) => CJK.test(h.text.trim()));
    if (!hits.length) continue;
    const name = path.basename(f);
    if (FILE_ALLOW[name]) {
      expect(hits.length, `${name} 的豁免条目数变了（原 ${FILE_ALLOW[name]}），请复核理由是否仍成立`).toBeLessThanOrEqual(4);
      continue;
    }
    bad.push(...report(f, hits, src.split("\n")));
  }
  expect(bad, "以下 JS 注入的文案没走 i18n 字典：\n" + bad.join("\n")).toEqual([]);
});

it("模板里给人看的位置没有硬编码中文（含跨行文本与插值表达式里的字面量）", () => {
  const files = listFiles(SRC, /\.vue$/).filter((f) => !isI18n(f));
  expect(files.length).toBeGreaterThan(10);
  const bad: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    bad.push(...report(f, scanTemplate(src), src.split("\n")));
  }
  expect(bad, "以下界面文案没走 i18n 字典：\n" + bad.join("\n")).toEqual([]);
});

it("script / state 里那些「一看就是给人看」的属性与提示都走字典（139 补的第二层）", () => {
  const files = listFiles(SRC, /\.(ts|vue)$/).filter((f) => !isI18n(f));
  // 同 kernel 那道闸：扫到的文件数先钉一条，目录改名/清空不会把这闸变成空转
  expect(files.length, `只扫到 ${files.length} 个 src 文件，路径或结构变了`).toBeGreaterThan(40);
  const bad: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    bad.push(...report(f, scanUserProps(src), src.split("\n")));
  }
  expect(
    bad,
    "以下 title / label / message / actions / 错误提示是硬编码中文（逻辑判断串不算，别把它们翻掉）：\n" + bad.join("\n"),
  ).toEqual([]);
});

/**
 * 判据自己也得有据可依（139 这轮踩的就是「常量写坏了却没人用它」）。
 * 正面验一遍：范围认得中文、不认得 class 名；收集器认得正则里的引号；
 * 三道闸各自抓得住它声称要抓的东西，而且**认得行内豁免标记**。
 */
it("汉字范围与三道扫描器没退化（判据的判据）", () => {
  expect(CJK.test("中文")).toBe(true);
  expect(CJK.test("hp-code-copy")).toBe(false);
  expect(CJK.test("copyFailed")).toBe(false);

  const ts = [
    "const desc = /^state\\s+(\"[^\"]*\"|'[^']*')\\s+as\\s+\\S+\\s*$/.exec(text);",
    'const a = "这是中文文案";',
    "const b = 1 / 2; const c = /a'b\"\\/x/.test(y) / 3;",
    '// const z = "注释里的中文";',
    "const tpl = `前缀${'插值里的中文'}后缀`;",
    'const w = "字符串里的 // 不算注释";',
  ].join("\n");
  const got = collectStringLiterals(ts).map((h) => h.text);
  expect(got).toContain("这是中文文案");
  expect(got).toContain("插值里的中文");
  expect(got).toContain("字符串里的 // 不算注释");
  expect(got.some((s) => s.includes("注释里的中文")), "注释里的内容不该算字符串").toBe(false);
  expect(got.some((s) => s.includes("exec") || s.includes("\\s")), "正则字面量不该被当成字符串").toBe(false);
  expect(got.filter((s) => CJK.test(s)).sort()).toEqual(
    ["插值里的中文", "前缀后缀", "这是中文文案", "字符串里的 // 不算注释"].sort(),
  );

  const vue = [
    "<template>",
    '  <div class="x">',
    '    {{ ok ? "置顶" : "取消置顶" }}',
    "    <span>{{ n }} 字 · 段</span>",
    '    <button title="按钮提示">文本节点中文</button>',
    "  </div>",
    "</template>",
  ].join("\n");
  const tplHits = scanTemplate(vue).map((h) => h.text);
  expect(tplHits).toContain("文本节点中文");
  expect(tplHits.some((h) => h.includes("取消置顶")), "插值表达式里的字面量要抓到").toBe(true);
  expect(tplHits.some((h) => h.includes("字 · 段")), "混着 {{ }} 的文本节点要抓到").toBe(true);
  expect(tplHits.some((h) => h.includes("按钮提示"))).toBe(true);
  expect(tplHits.some((h) => h.includes("class")), "属性值不该被当成文本节点报").toBe(false);

  const propHits = scanUserProps(
    [
      'const req = { title: "文件打不开", actions: ["清空", "取消"] };',
      "globalError.value = `找不到小节：${x}`;",
      'const keep = "已取消"; // 判断依据，不是文案',
    ].join("\n"),
  ).map((h) => h.text);
  expect(propHits).toContain("文件打不开");
  expect(propHits.some((h) => h.includes("清空"))).toBe(true);
  expect(propHits.some((h) => h.includes("找不到小节"))).toBe(true);
  expect(propHits.some((h) => h.includes("已取消")), "逻辑判断串不许报").toBe(false);

  // 行内豁免：写了理由才算，空标记不豁免
  const withMark = 'const req = { title: "诊断文本" }; // i18n-allow: 这是自检面板';
  expect(report(path.join(SRC, "x.ts"), scanUserProps(withMark), withMark.split("\n"))).toEqual([]);
  const bare = 'const req = { title: "诊断文本" }; // i18n-allow:';
  expect(report(path.join(SRC, "x.ts"), scanUserProps(bare), bare.split("\n")).length).toBe(1);
});

it("没写理由的 i18n-allow 标记本身按违规处理", () => {
  const files = listFiles(SRC, /\.(ts|vue)$/).filter((f) => !isI18n(f));
  const bad: string[] = [];
  for (const f of files) bad.push(...bareMarks(fs.readFileSync(f, "utf8").split("\n")));
  expect(bad, "这些豁免标记没写理由：\n" + bad.join("\n")).toEqual([]);
});
