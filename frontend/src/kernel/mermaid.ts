import type { ThemeName } from "./render";
import { addDismiss, openSvgLightbox } from "./enhance";
import { t } from "../i18n";
import { createTextMeasurer, preWrapMermaid } from "./mermaidLabels";

/**
 * Mermaid 渲染。
 *
 * 本地打包（`mermaid` 作为依赖被 Vite 切成独立 chunk，只在文档真的含图时才加载），
 * 不走 CDN —— 这是 D11 的硬要求：离线可用，且不把用户文档内容发给第三方。
 */

/**
 * 125：图上文字的字体与字号。
 *
 * **字号必须钉死**：折行是我们自己按字宽算的（`preWrapMermaid`），
 * 用的测量字体就是这里这一套。字号若跟着界面的「基础字号」走，
 * 我们折的行数与浏览器显示的行数就会错开，溢出立刻回来 ——
 * 探针实测过：改基础字号 14/15/18，mermaid 标签始终是 16px，两边本来就不是一回事。
 */
export const MERMAID_FONT_SIZE = 16;
export const MERMAID_FONT_FAMILY = '"Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';
/** 与 `flowchart.wrappingWidth` 同一个数：mermaid 按它算盒子，我们按它折行 */
export const MERMAID_WRAP_WIDTH = 240;

let measure: ((s: string) => number) | null = null;

/** 渲染前折行：只改「喂给 mermaid 的那份文本」，用户文档一个字节都不动 */
function wrapForRender(source: string): string {
  if (typeof document === "undefined") return source;
  measure ??= createTextMeasurer(`${MERMAID_FONT_SIZE}px ${MERMAID_FONT_FAMILY}`);
  // 比 wrappingWidth 留 24px 余量：mermaid 自己那套字宽估算比我们略宽，
  // 折得比它窄一点，它就只照单全收、不会再折第二遍
  return preWrapMermaid(source, { maxWidth: MERMAID_WRAP_WIDTH - 24, measure });
}

let seq = 0;

async function loadMermaid(theme: ThemeName) {
  const mod = await import("mermaid");
  const mermaid = mod.default;
  mermaid.initialize({
    startOnLoad: false,
    // D3：深色档用 mermaid 的 dark 主题反色，而不是给图套一层滤镜
    theme: theme === "dark" ? "dark" : "default",
    // strict：图内标签里的 HTML 被转义，避免外来 md 通过节点文案注入脚本
    securityLevel: "strict",
    fontFamily: MERMAID_FONT_FAMILY,
    // 字号钉死，与 `createTextMeasurer` 用的是同一个数（见上面的注释）
    themeVariables: { fontSize: `${MERMAID_FONT_SIZE}px` },
    /*
     * 修 bug（她截图指出的「图中文字显示不全」）：
     * - `useMaxWidth: false` —— 默认 true 时 mermaid 把 svg 宽度写成 100%，
     *   宽图会被**整篇压扁**到容器宽（探针实测 viewBox 1482 只画 836，缩放比 0.56），
     *   中文小字直接糊掉；关掉后按真实尺寸画，超宽交给我们的横向滚动。
     * - `wrappingWidth` —— mermaid 就是按这个宽度给标签折行并**据此算盒子高度**的，
     *   默认 200 对中文偏挤；240 是一屏内两到三行的折中。
     *   注意它只管折行计算，真能不能折还取决于 CSS 有没有把 `white-space` 放开
     *   （mermaid 给标签写的是 `nowrap`，见 reading.css 那条配套修复）。
     */
    flowchart: { useMaxWidth: false, wrappingWidth: MERMAID_WRAP_WIDTH, htmlLabels: true },
    sequence: { useMaxWidth: false },
  });
  return mermaid;
}

export interface MermaidOptions {
  theme: ThemeName;
}

export interface MermaidResult {
  svg?: string;
  error?: string;
}

/**
 * 渲染单份 Mermaid 源码。
 *
 * 110 需要它：编辑模式的「点开即改 + 原地重绘」要在**不重建 DOM** 的前提下
 * 反复渲染同一块，而 `hydrateMermaid` 是「一次性把 pre 换成图」，两者不能共用。
 * 所以把渲染本身抽出来，`hydrateMermaid` 与 NodeView 都调它。
 */
export async function renderMermaid(source: string, theme: ThemeName): Promise<MermaidResult> {
  try {
    const mermaid = await loadMermaid(theme);
    const { svg } = await mermaid.render("hp-mermaid-" + ++seq, wrapForRender(source));
    return { svg };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把 `<pre><code class="language-mermaid">` 原地换成渲染后的图。
 * 语法错误时保留错误块 + 原始源码，不白屏（004 验收点）。
 */
export async function hydrateMermaid(root: HTMLElement, opts: MermaidOptions): Promise<number> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("code.language-mermaid"));
  if (blocks.length === 0) return 0;

  let done = 0;

  for (const code of blocks) {
    const source = code.textContent ?? "";
    const target = (code.closest("pre") ?? code) as HTMLElement;

    const box = document.createElement("div");
    box.className = "hp-mermaid";
    box.dataset.state = "pending";
    target.replaceWith(box);

    const result = await renderMermaid(source, opts.theme);
    if (result.svg) {
      box.innerHTML = result.svg;
      box.dataset.state = "done";
      /*
       * 127（她：「应用架构图很大，无法看到全貌，这种图应该给我单独缩放功能」）：
       * **阅读模式双击图 → 进灯箱，在里面滚轮缩放 + 拖拽平移**。
       * 为什么是点开大图而不是就地缩放：她的诉求是「看全貌」，而缩到能看全貌时字必然糊 ——
       * 对症的是一块没有正文干扰的画布；正文里 `Ctrl+滚轮` 已经是「整篇缩放」，
       * 再叠一层「停在图上时只缩放这张」就成了同一个手势两种含义。
       * 只在阅读档做：编辑档的双击已经是「改字」（125/126/127），两个语义不能抢同一处。
       */
      box.title = t("mermaid.zoomHint");
      box.dataset.testid = "mermaid-diagram";
      box.addEventListener("dblclick", () => {
        const s = box.querySelector("svg");
        if (s) openSvgLightbox(s as SVGSVGElement, t("mermaid.diagram"));
      });
      done++;
      continue;
    }

    box.className = "hp-mermaid hp-mermaid--error";
    box.dataset.state = "error";

    const title = document.createElement("p");
    title.className = "hp-mermaid__error-title";
    title.textContent = t("mermaid.errorBlockTitle");

    const pre = document.createElement("pre");
    const err = document.createElement("code");
    err.textContent = source;
    pre.appendChild(err);

    const detail = document.createElement("pre");
    detail.className = "hp-mermaid__error-msg";
    detail.textContent = result.error ?? "";

    box.replaceChildren(title, pre, detail);
    // 127：错误块也要能自己关掉（叉在右边）
    addDismiss(box, t("mermaid.dismissErrorBlock"));
  }

  return done;
}
