import { mdToHtml } from "./md";
import { uniqueSlug } from "./anchors";
import { decorateFootnotes } from "./footnotes";

export type ThemeName = "light" | "dark";

/** 正文宽度档位（D17）：narrow 适合纯文字通读，full 适合宽表 PRD */
export type WidthPreset = "narrow" | "normal" | "wide" | "full";

export interface RenderOptions {
  theme: ThemeName;
  width: WidthPreset;
  /** 整体缩放倍率，1 = 100%。范围 50%~200%，步进 10%（D16） */
  zoom: number;
  /** 基础字号 px，来自设置（018）；不传用 CSS 默认 */
  baseFontSize?: number;
}

/** 缩放上下限与步进（D16） */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  const snapped = Math.round(z / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(snapped.toFixed(2))));
}

/**
 * 渲染接缝（spec §5.4）：`render(md, {theme, width, zoom}) -> DOM`。
 *
 * 阅读模式、主题切换、整体缩放、正文宽度、日后导出共用这一个入口。
 *
 * 缩放用 CSS `zoom` 而不是 `transform: scale` —— 025 实测：50%~200% 七档下
 * ProseMirror 的「位置 ↔ 屏幕坐标」往返全部命中，而 scale 会破坏
 * getBoundingClientRect 与选区映射。
 */
export function render(md: string, opts: RenderOptions): HTMLElement {
  const article = document.createElement("article");
  article.className = "hp-doc";
  article.dataset.theme = opts.theme;
  article.dataset.width = opts.width;
  article.style.zoom = String(clampZoom(opts.zoom));
  if (opts.baseFontSize) article.style.setProperty("--hp-font-base", opts.baseFontSize + "px");
  article.innerHTML = mdToHtml(md);
  assignHeadingIds(article);
  // 脚注区收尾（标题本地化 + 接管页内跳转）。放在 render 里而不是组件里：
  // 阅读模式与日后导出共用这一个入口，别在调用方各补一遍。
  decorateFootnotes(article);
  return article;
}

/**
 * 给 h1~h6 打锚点 id。
 *
 * 大纲跳转（014）与 `[TOC]`（022）共用这一套规则，且必须**确定性**：
 * 同一篇文档每次渲染出的 id 要一样，否则保存重开后锚点会集体指错。
 */
export function assignHeadingIds(root: HTMLElement): void {
  const used = new Set<string>();
  for (const el of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (!el.id) el.id = uniqueSlug(el.textContent ?? "", used);
  }
}

/** 把渲染结果挂到容器上（先清空再挂，避免阅读/编辑切换时残留） */
export function mountRender(container: HTMLElement, md: string, opts: RenderOptions): HTMLElement {
  container.replaceChildren(render(md, opts));
  return container.firstElementChild as HTMLElement;
}
