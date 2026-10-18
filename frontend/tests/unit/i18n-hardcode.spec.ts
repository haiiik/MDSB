import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 闸门：界面文案不许再硬编码中文（M3-134 i18n 之后必须守住）。
 *
 * 只扫 `<template>` 里**给人看**的位置：文本节点、`title` / `aria-label` / `placeholder` / `alt`。
 * 注释、`{{ t("…") }}` 里的 key、script 里的逻辑字符串（如 `"已取消"`）都不算 ——
 * 后者是判断依据，翻成别的语言就废了。
 *
 * 命中就红，并列出文件与原文。**豁免要写理由**，没理由的豁免按违规处理。
 */
const ALLOW: Record<string, string> = {
  "ThemeToggle.vue": "title 是 `${o.label}主题` 模板拼接，label 本身要不要翻译还没定（另开口径）",
};

const CJK = /[㐀-]/;
function scanTemplate(src: string): string[] {
  const start = src.indexOf("<template>");
  if (start < 0) return [];
  let tpl = src.slice(start);
  tpl = tpl.replace(/<!--[\s\S]*?-->/g, "");            // 去注释
  tpl = tpl.replace(/\/\*[\s\S]*?\*\//g, "");
  const hits: string[] = [];
  for (const m of tpl.matchAll(/>([^<>{}\n]*[㐀-鿿][^<>{}\n]*)</g)) hits.push(m[1].trim());
  for (const m of tpl.matchAll(/(?:title|aria-label|placeholder|alt)="([^"\n]*[㐀-鿿][^"\n]*)"/g)) hits.push(m[1]);
  return [...new Set(hits)];
}

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
