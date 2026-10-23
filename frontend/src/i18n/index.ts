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
  "common.cancel": "Cancel",
  "search.find": "Find",
  "search.replaceWith": "Replace with",
  "search.prev": "Previous (Shift+Enter)",
  "search.next": "Next (Enter)",
  "search.close": "Close (Esc)",
  "search.replaceToggle": "Show / hide replace (Ctrl+H opens it directly)",
  "search.replaced": "Replaced {done}, {left} left",
  "search.caseTitle": "Case sensitive",
  "search.wholeLabel": "Word",
  "search.wholeTitle": "Whole word",
  "search.regexTitle": "Regular expression",
  "tb.body": "Body",
  "tb.bodyTitle": "Body paragraph",
  "tb.h1Title": "Heading 1",
  "tb.h2Title": "Heading 2",
  "tb.h3Title": "Heading 3",
  "tb.quote": "Quote",
  "tb.quoteTitle": "Blockquote (click again to clear)",
  "tb.code": "Code",
  "tb.codeTitle": "Code fence",
  "tb.bullet": "Bulleted",
  "tb.bulletTitle": "Bulleted list (click again to leave the list)",
  "tb.ordered": "Numbered",
  "tb.orderedTitle": "Numbered list",
  "tb.task": "Task",
  "tb.taskTitle": "Task item (click again to uncheck)",
  "tb.bold": "B",
  "tb.boldTitle": "Bold",
  "tb.italic": "I",
  "tb.italicTitle": "Italic",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "empty.open": "Open a Markdown file",
  "toolbar.linkOk": "Apply",
  "toolbar.linkClear": "Clear",
  "status.dirtyShort": "Unsaved",
  "nav.notFound": "Section not found: {text}",
  "open.cannotOpenDetail": "Can't open \u201c{name}\u201d: {error}",
  "quit.autoSavePending": "Auto-save hasn't finished",
  "quit.title": "Exit MDStar",
  "quit.dirtyOne": "\u201c{name}\u201d has unsaved changes.",
  "quit.dirtyNewNote": "\nThis one has never been saved \u2014 saving will ask where to put it.",
  "quit.dirtyMany": "{n} tabs have unsaved changes:\n{list}",
  "quit.saveAndExit": "Save and exit",
  "quit.discardAndExit": "Discard and exit",
  "quit.saveFailedTitle": "Save failed \u2014 exit aborted",
  "quit.saveFailedMsg": "{name}: {error}",
  "sidebar.fileUnopenable": "Can't open this file",
  "sidebar.unopenableMsg": "\u201c{name}\u201d no longer exists or can't be read.\n{path}",
  "search.replace": "Replace",
  "toolbar.aria": "Formatting toolbar",
  "toolbar.link": "Link",
  "toolbar.clearLink": "Remove link from selection",
  "toolbar.fontSize": "Editing font size (use zoom for reading)",
  "theme.label": "Theme",
  "theme.pick": "{label} theme",
  "tab.closeTab2": "Close tab",
  "empty.new": "New",
  "empty.hint": "or press Ctrl+T for a new tab, Ctrl+O to open",
  "empty.noDoc": "No document open",
  "sidebar.emptyRecent": "No files opened yet",
  "sidebar.remove": "Remove from list",

  "dialog.unsavedTitle": "Unsaved changes",
  "dialog.unsavedMsg": "“{name}” has unsaved changes. Save first?",
  "dialog.unsavedNewNote": "\nThis document was never saved - saving asks for a location and a name.",
  "dialog.saveAsName": "Save and name",
  "dialog.discard": "Discard",
  "dialog.saveFailed": "Save failed",
  "dialog.unknownError": "Unknown error",
  "dialog.gotIt": "OK",
  "dialog.recoverTitle": "Unsaved content found",
  "dialog.recoverMissing": "The file behind “{name}” is gone, but an unsaved snapshot exists. Restore it?",
  "dialog.recoverDiff": "An unsaved snapshot of “{name}” differs from the file on disk. Restore it?",
  "dialog.restore": "Restore",
  "open.cannotOpen": "Cannot open “{name}”",
  "drop.onlyMarkdown": "Only .md / .markdown files can be opened",
  "drop.hint": "Drop to open a Markdown file",
  "dialog.saveAsFailed": "Save as failed",

  "status.words": "{words} words",
  "status.lines": "{lines} lines",
  "status.headings": "{headings} headings",
  "status.notOpened": "No document open",
  "mode.read": "Reading",
  "mode.edit": "Editing",
  "mode.source": "Source",
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
  "tab.newTabHint": "New tab (blank, ready to type)",
  "tab.openHint": "Open file (Ctrl+O)",
  "tab.settingsHint": "Settings (Ctrl+,)",
  "menu.reveal": "Reveal in Explorer",
  "tab.dirty": "Unsaved changes",
  "menu.copyPath": "Copy file path",
  "menu.closeOthers": "Close others",
  "menu.closeRight": "Close to the right",
  "sidebar.recent": "Recent",
  "sidebar.outline": "Outline",
  "sidebar.recentHint": "Recently opened files",
  "sidebar.outlineHint": "Heading structure of this document",
  "sidebar.collapse": "Collapse sidebar",
  "sidebar.expand": "Expand sidebar",
  "sidebar.unavailable": "File is missing or unreadable",
  "sidebar.unavailableShort": "Unavailable",
  "sidebar.pin": "Pin",
  "sidebar.unpin": "Unpin",
  "sidebar.clear": "Clear",
  "sidebar.clearHint": "Open tabs are not affected.",
  "sidebar.noDoc": "No document open",
  "sidebar.noHeadings": "This document has no headings",
  "sidebar.clearAll": "Clear recent files",

  "tab.closeTab": "Close tab",
  "tab.newTab": "New tab",
  "tab.open": "Open file",
  "tab.close": "Close",
  "tab.moreHint": "{n} more tabs don't fit \u2014 click to pick one",
  "tab.pickerTitle": "All tabs",
  "footnotes.title": "Footnotes",
  "footnotes.backTo": "Back to reference {n}",
  "math.errorTip": "Formula not rendered (syntax error): ",
  "math.editHint": "Formula · edit the source below, preview updates live",
  "math.opaqueInline": "formula {src}",
  "math.opaqueBlock": "formula {src} · not editable here yet",
  "toolbar.doclink": "Doc link",
  "doclink.title": "Insert document link",
  "doclink.search": "Search by file name…",
  "doclink.loading": "Scanning this folder…",
  "doclink.empty": "No Markdown documents found nearby",
  "doclink.noBase": "This file isn't saved yet, so a relative path can't be computed — absolute only",
  "doclink.rel": "Relative path",
  "doclink.abs": "Absolute path",
  "doclink.relHint": "Relative to the current file's folder; links survive moving the whole folder",
  "doclink.insert": "Insert",
  "doclink.capped": "Showing the first {n} matches — keep typing to narrow it down",
  "doclink.scanError": "Could not scan the folder: {msg}",

  // 139：JS 直接写进 DOM 的那批（见 zh.ts 同名分节）
  "code.expand": "Show all {n} lines",
  "code.collapse": "Collapse",
  "code.editSource": "Edit source",
  "code.zoomIn": "Zoom this diagram in",
  "code.zoomOut": "Zoom this diagram out",
  "code.zoomReset": "Reset to 100% (click)",
  "code.copy": "Copy",
  "code.copied": "Copied",
  "code.copyFailed": "Copy failed",
  "code.plainText": "Plain text",
  "code.unknownLang": "Unrecognized language tag: {lang} (highlighted as plain text; the tag is kept as you wrote it)",
  "code.unknownLangOption": "{lang} (unrecognized)",
  "image.broken": "Image can't be displayed: {name}",
  "image.copyPath": "Copy path",
  "image.seqOverflow": "More than 999 images in the same second — refusing to write: {stamp}",
  "toc.title": "Contents",
  "lightbox.hint": "Scroll to zoom · drag to pan",
  "lightbox.hintBoth": "Scroll to zoom · drag with left or right button",
  "lightbox.close": "Close (Esc)",
  "lightbox.reset": "Actual size",
  "lightbox.fit": "Fit to screen",
  "lightbox.mermaidTitle": "Mermaid diagram (double-click to reopen)",
  "mermaid.zoomHint": "Double-click for the large view; hold the right button to slide a wide diagram",
  "mermaid.diagram": "Mermaid diagram",
  "mermaid.errorBlockTitle": "Mermaid syntax error — the diagram isn't rendered. Source below:",
  "mermaid.errorPrefix": "Mermaid syntax error, diagram not rendered: ",
  "mermaid.dismissErrorBlock": "Dismiss this error block",
  "mermaid.dismissErrorTip": "Dismiss this error message",
  "mermaid.editHint": "Double-click a label to edit it in place (Enter or click away commits); click the diagram to edit the source below",
  "mermaid.duplicateDefinition": "This node is defined twice in the source — unclear which one to change.",
  "mermaid.ambiguousMatch": "This text appears more than once in the source — unclear which one to change.",
  "mermaid.identifierLocked": "This is an entity / state name that relation lines still refer to; changing only this one would break the diagram. Please edit the whole block in source mode.",
  "mermaid.notInSource": "“{text}” is text Mermaid computed or escaped itself — it isn't in the source, so it can't be edited here. Please edit the source below.",
  "mermaid.sourceMoved": "The source changed elsewhere after the double-click, so this position is no longer trustworthy — nothing was written. Please edit the source below.",
  "mermaid.ambiguousNoEdit": "This spot isn't uniquely located in the source, so in-place editing stayed off to avoid breaking the diagram. Please edit the source below.",
  "mermaid.dblClickToEdit": "Double-click to edit this text",
  "mermaid.cannotEditHere": "This spot can't be edited directly",
  "mermaid.oneLineOnly": "This spot only accepts one line (ER attribute lines and state-diagram transition labels don't wrap).",
  "mermaid.emptyLabel": "The label can't be empty. To remove this node, edit the source mode.",
  "mermaid.identifierRule": "This is an identifier (type name / attribute name / key marker) — it must be one word without spaces.",
  "mermaid.wouldBreak": 'This text contains a double quote and "{text}", which would end the label early and break the diagram. Please edit it in source mode.',
  "math.notLoaded": "Formula renderer isn't loaded yet",
  "opaque.defaultLabel": "(this content isn't modified in edit mode)",
  "opaque.yaml": "Document properties (YAML) · not modified in edit mode",
  "opaque.html": "Raw HTML · not modified in edit mode",
  "opaque.footnoteDef": "Footnote definition [^{label}] · not modified in edit mode",
  "opaque.unsupported": "Unsupported content ({type}) · not modified in edit mode",
  "paste.noRoomForImage": "There's no room for an image here ({where}) — put the cursor in the body text first.",
  "table.addRowAbove": "Insert row above",
  "table.addRowBelow": "Insert row below",
  "table.moveRowUp": "Move row up",
  "table.moveRowDown": "Move row down",
  "table.addColumnLeft": "Insert column left",
  "table.addColumnRight": "Insert column right",
  "table.moveColumnLeft": "Move column left",
  "table.moveColumnRight": "Move column right",
  "table.toggleHeader": "Set / unset header row",
  "table.deleteRow": "Delete this row",
  "table.deleteColumn": "Delete this column",
};

export { en };
