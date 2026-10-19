import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 闸门：界面文案不许再硬编码中文（M3-134 i18n 之后必须守住）。
 *
 * 两处入口，各管一层：
 *  - `.vue` 的 `<template>`：只扫**给人看**的位置（文本节点、`title` / `aria-label` /
 *    `placeholder` / `alt`）。注释、`{{ t("…") }}` 里的 key、script 里的逻辑字符串都不算 ——
 *    后者是判断依据，翻成别的语言就废了。
 *  - `src/kernel/**`：JS 建元素时塞进 DOM 的字符串字面量（139 补的那道缝，见第二道闸）。
 *
 * 命中就红，并列出文件与原文。**豁免要写理由**，没理由的豁免按违规处理。
 */
const ALLOW: Record<string, string> = {
  "ThemeToggle.vue": "title 是 `${o.label}主题` 模板拼接，label 本身要不要翻译还没定（另开口径）",
};

/**
 * 中日韩汉字范围。**刻意写 \u 转义而不是字面汉字**：这一行原本用字面汉字写，
 * 上界那个字被某次工具链写入吞掉了，剩下的半截在正则里退化成「某个字 或 连字符」，
 * 于是任何带 `-` 的字符串都算中文 —— 而它一直没报警，只因为当时还没人用它
 * （139 之前只有模板那道闸，用的是下面两条内联正则）。
 * **一道自己不验证的判据，比没有判据更危险**：所以「收集器」那条 it 正面拿「中文」二字
 * 过一次 `CJK.test`，范围写坏了它先红。
 */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

function scanTemplate(src: string): string[] {
  const start = src.indexOf("<template>");
  if (start < 0) return [];
  let tpl = src.slice(start);
  tpl = tpl.replace(/<!--[\s\S]*?-->/g, "");            // 去注释
  tpl = tpl.replace(/\/\*[\s\S]*?\*\//g, "");
  const hits: string[] = [];
  for (const m of tpl.matchAll(/>([^<>{}\n]*[\u3400-\u9fff][^<>{}\n]*)</g)) hits.push(m[1].trim());
  for (const m of tpl.matchAll(/(?:title|aria-label|placeholder|alt)="([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)) hits.push(m[1]);
  return [...new Set(hits)];
}

/**
 * 第二道闸（139）：**`src/kernel/**` 里 JS 直接写进 DOM 的字符串也不许硬编码界面中文**。
 *
 * 为什么单独加这一道：133 那轮只扫 `.vue` 模板，而阅读/编辑模式里有相当一部分文字是
 * JS 建元素时塞进去的（代码块工具条、图片失效占位、`[TOC]` 标题、灯箱、不透明块说明、
 * Mermaid 双击改字的拒绝理由……），**整批从模板那道缝里漏了出去** ——
 * 默认语言还是中文时，漏掉的这些地方测试全绿也看不见，是 136-A 切 English 才撞出来的。
 *
 * 扫法：取**字符串字面量内容**（含模板字符串与其 `${}` 插值），出现中日韩文字就算命中。
 * 注释与正则字面量不算：前者是给人读的代码说明，后者是匹配规则不是文案。
 */
const KERNEL_ALLOW: Record<string, string> = {
  "blockPatch.ts": "三条 `throw new Error(...)` 是开发期断言（真触发说明程序错了），不是给人读的界面文案",
};

/** 出现在这些字符之后的 `/` 是正则起点，不是除法 */
const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">"]);
/** `return` / `typeof` 等关键字之后的 `/` 同样是正则起点 */
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|case|in|of|new|delete|void|do|else)\s*$/;

/**
 * 取出一份 TS 源码里的**字符串字面量内容**（含模板字符串；`${}` 插值递归扫）。
 *
 * 之所以手写小状态机，而不是「去掉注释后用正则抓引号」：像
 * `/^state\s+("[^"]*"|'[^']*')\s+as\s+\S+$/` 这种**正则里带引号**的写法（`mermaidLabels.ts` 真有），
 * 会让引号配对整个错位 —— 一段代码被当成字符串，途中顺到的中文全算命中，判据自己先误报。
 * 未闭合的引号 / 正则按「就地断开」处理，避免一个特殊字符把整份文件带偏。
 */
function collectStringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  let prevSig = ""; // 上一个有意义的代码字符（空白与注释不算）
  let tail = "";    // 最近若干字符，用来认关键字

  const skipRegex = () => {
    let inClass = false;
    i++; // 吃掉起始 /
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") { i++; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) { i++; break; }
      else if (c === "\n") break; // 没闭合：当除法收场，别让后面全错位
    }
    while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
  };

  const takeString = (quote: string) => {
    i++; // 吃掉起始引号
    let val = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { val += c + (src[i + 1] ?? ""); i += 2; continue; }
      if (c === quote) { i++; break; }
      if (quote === "`" && c === "$" && src[i + 1] === "{") {
        let depth = 1;
        let inner = "";
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) break; }
          inner += src[i];
          i++;
        }
        i++; // 吃掉收尾 }
        out.push(...collectStringLiterals(inner)); // 插值里也可能藏着要扫的文案
        continue;
      }
      if (c === "\n" && quote !== "`") break; // 未闭合的 ' 或 "
      val += c;
      i++;
    }
    out.push(val);
    prevSig = quote;
    tail += quote;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
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

function scanKernelStrings(src: string): string[] {
  const hits: string[] = [];
  for (const lit of collectStringLiterals(src)) {
    const flat = lit.replace(/\s+/g, " ").trim();
    if (flat && CJK.test(flat)) hits.push(flat.slice(0, 60));
  }
  return [...new Set(hits)];
}

it("kernel 里 JS 注入 DOM 的文案都走字典（139 补的那道缝）", () => {
  const dir = path.resolve(import.meta.dirname, "../../src/kernel");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(dir);
  // 目录结构变了这条要先红，否则「扫到 0 个文件」会被当成全绿
  expect(files.length, `只扫到 ${files.length} 个 kernel 文件，路径或结构变了`).toBeGreaterThan(20);
  const bad: string[] = [];
  for (const f of files) {
    const hits = scanKernelStrings(fs.readFileSync(f, "utf8"));
    const name = path.basename(f);
    if (!hits.length) continue;
    if (KERNEL_ALLOW[name]) {
      expect(hits.length, `${name} 的豁免条目数变了（原 ${KERNEL_ALLOW[name]}），请复核理由是否仍成立`).toBeLessThanOrEqual(4);
      continue;
    }
    for (const h of hits) bad.push(`${name}: ${h}`);
  }
  expect(bad, "以下 JS 注入的文案没走 i18n 字典：\n" + bad.join("\n")).toEqual([]);
});

/**
 * 判据自己也得有据可依（139 这轮踩的就是「常量写坏了但没人用它」）。
 * 正面验两件事：范围认得中文、不认得 class 名；收集器分得清正则、注释、字符串里的斜杠。
 */
it("汉字范围与字符串收集器没退化（判据的判据）", () => {
  expect(CJK.test("中文")).toBe(true);
  expect(CJK.test("hp-code-copy")).toBe(false);
  expect(CJK.test("copyFailed")).toBe(false);

  const src = [
    "const desc = /^state\\s+(\"[^\"]*\"|'[^']*')\\s+as\\s+\\S+\\s*$/.exec(text);",
    'const a = "这是中文文案";',
    "const b = 1 / 2; const c = /a'b\"\\/x/.test(y) / 3;",
    '// const z = "注释里的中文";',
    "const tpl = `前缀${'插值里的中文'}后缀`;",
    'const w = "字符串里的 // 不算注释";',
  ].join("\n");

  const got = collectStringLiterals(src);
  expect(got).toContain("这是中文文案");
  expect(got).toContain("插值里的中文");
  expect(got).toContain("字符串里的 // 不算注释");
  expect(got.some((s) => s.includes("注释里的中文")), "注释里的内容不该算字符串").toBe(false);
  expect(got.some((s) => s.includes("exec") || s.includes("\\s")), "正则字面量不该被当成字符串").toBe(false);
  expect(scanKernelStrings(src).sort()).toEqual(
    ["插值里的中文", "前缀后缀", "这是中文文案", "字符串里的 // 不算注释"].sort(),
  );
});

it("组件模板里没有硬编码的界面中文文案（豁免必须带理由）", () => {
  const dir = path.resolve(import.meta.dirname, "../../src");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".vue")) files.push(p);
    }
  };
  walk(dir);
  expect(files.length).toBeGreaterThan(10);
  const bad: string[] = [];
  for (const f of files) {
    const hits = scanTemplate(fs.readFileSync(f, "utf8"));
    const name = path.basename(f);
    if (!hits.length) continue;
    if (ALLOW[name]) {
      // 豁免项也要一致：内容变了还豁免，等于把闸门开 blind
      expect(hits.length, `${name} 的豁免条目数变了，请复核理由是否仍成立`).toBeLessThanOrEqual(4);
      continue;
    }
    for (const h of hits) bad.push(`${name}: ${h}`);
  }
  expect(bad, "以下界面文案没走 i18n 字典：\n" + bad.join("\n")).toEqual([]);
});
