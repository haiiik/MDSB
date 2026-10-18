/**
 * i18n 基座（M3-134 第一步：只搭骨架，不改任何组件）。
 *
 * 三条设计口径：
 * 1. **不引 vue-i18n**。我们只需要「查一张扁平表 + 一个响应式当前语言」，自己写约 80 行，
 *    少一个运行时依赖，也少一类「字典缺 key」的静默失败（这里用 TS 类型把 key 钉死）。
 * 2. **key 的权威来源是中文表**：`MsgKey` 由 `zh` 反推，英文表被 `Record<MsgKey,string>` 约束，
 *    **漏译一个 key 就编译不过** —— 这是"翻译完整性"唯一可靠的守门方式（跑一遍全量测试不如让类型报错）。
 * 3. **界面文案与判据分离**：断言一律押 `data-testid`，不押中文文本。
 *    这条是本基座存在的真正原因 —— 否则每加一种语言就要重写一批测试。
 *
 * 语言从哪来（她的口径）：**安装时选**（安装器读系统语言预选，读不到则必须选一项才能继续），
 * 写进 `HKCU\Software\MDStar\Language`；应用首启若设置里没有语言项就读它，之后**以设置为准**，
 * 设置里只有「中文 / English」双选（不做跟随系统）。
 */

import { reactive } from "vue";

export type Lang = "zh" | "en";

export const LANGS: readonly Lang[] = ["zh", "en"] as const;

import zh from "./zh";

export type MsgKey = keyof typeof zh;

/**
 * 当前界面语言。**必须是响应式的**：模板里 `t()` 读的是它，
 * 用普通对象的话切完语言界面不会重渲染（表现成「设置里切了没反应」）。
 * 默认中文：读不到任何来源时的兜底（安装器一定会写一个值，正常走不到这里）。
 */
export const ui = reactive<{ lang: Lang }>({ lang: "zh" });

/** 取文案。缺 key 时不静默返回 undefined —— 宁可把 key 印在界面上，让人一眼看见漏译 */
export function t(key: MsgKey): string {
  const table = ui.lang === "en" ? en : zh;
  return table[key] ?? zh[key] ?? `!${key}`;
}

/**
 * 带占位的文案：`tf("status-word-count", { words: 12 })` → 「12 字」。
 * 只做 `{name}` 替换，不引模板语法 —— 复数、性别这类真要处理时再单开口径，别顺手写个半成品。
 */
export function tf(key: MsgKey, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export function setLang(next: Lang): void {
  if (!LANGS.includes(next)) return;
  ui.lang = next;
}

/**
 * 从宿主给的语言标识里挑一个可用语言（安装器注册表值、`navigator.language` 都走这里）。
 * 认不出的一律返回 null，让调用方决定兜底 —— 这里不猜。
 */
export function normalizeLang(raw: string | null | undefined): Lang | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  return null;
}

const en: Record<MsgKey, string> = {
  "status.words": "{words} words",
  "status.lines": "{lines} lines",
  "status.headings": "{headings} headings",
  "status.notOpened": "No document open",
  "mode.read": "Reading",
  "mode.edit": "Editing",
  "mode.source": "Source",
  "search.replace": "Replace",
  "search.placeholder": "Find",
  "search.replaceAll": "Replace all",
  "dialog.save": "Save",
  "dialog.cancel": "Cancel",
  "mode.tooltip": "Switch to {label} mode",
  "settings.language": "Language",
  "settings.languageHint": "Interface text only; your documents are untouched. The choice is remembered",
  "lang.zh": "中文",
  "lang.en": "English",
  "status.width": "Width",
  "status.width.narrow": "Narrow",
  "status.width.normal": "Normal",
  "status.width.wide": "Wide",
  "status.width.full": "Full",
  "status.measureWidth": "Content measure width",
  "status.zoomIn": "Zoom in 10%",
  "status.zoomOut": "Zoom out 10%",
  "status.zoomReset": "Reset to 100%",
  "status.closeHint": "Dismiss this message",
  "status.dirty": "Unsaved changes",
  "status.statsTitle": "{cjk} CJK + {latin} words; code blocks and inline code excluded",
  "dialog.settings": "Settings",
  "settings.appliesNote": "Changes apply immediately and are remembered.",
  "settings.autoSave": "Auto save",
  "settings.autoSaveHint": "Writes 1 second after you stop typing; when off, only Ctrl+S saves",
  "settings.codeLineNumbers": "Code block line numbers",
  "settings.codeLineNumbersHint": "Display only — your document content is untouched",
  "win.minimize": "Minimize",
  "win.maximize": "Maximize",
  "win.restore": "Restore",
  "win.close": "Close",
};

export { en };
