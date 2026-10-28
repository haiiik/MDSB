import type { ThemeName } from "./render";
import { addDismiss, openSvgLightbox } from "./enhance";
import { attachRightButtonPan } from "./panDrag";
import { t } from "../i18n";
import { createTextMeasurer, preWrapMermaid } from "./mermaidLabels";
import { 建缩放控件, 缩放键 as 拼缩放键 } from "./mermaidZoom";

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
     * 修 bug（截图指出的「图中文字显示不全」）：
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
  /**
   * 161：这一篇的标签页标识，用来给「每张图自己的缩放倍率」定位到哪一格。
   * 编辑档传的是 `tab.id`（146 起就是它），阅读档必须传**同一个值**，
   * 否则两档各存一份倍率 —— 同一个功能两份状态（口径见 `mermaidZoom.ts` 头上那段）。
   */
  tabKey?: string;
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
 * 152（10-22：「浅色主题可以看清，深色主题看不清啊，我觉得是软件层面的问题」，两张同图两档截图）：
 * **量出来确实是软件这一层的锅**，不是文档写坏了。
 *
 * 同一张三节点图（两个节点用 `classDef` 写了浅底），深色档实测：
 * - 没写样式的节点：底 `rgb(31,32,32)` + 字 `rgb(204,204,204)` → 对比度 **10.17** ✓
 * - 浅粉底那个：底 `rgb(255,230,230)` + 字 `rgb(204,204,204)` → 对比度 **1.35** ✗
 * - 浅蓝底那个：底 `rgb(230,240,255)` + 字 `rgb(204,204,204)` → 对比度 **1.40** ✗
 * （浅色档三个都 ≥10.6，所以只有深色档坏。）
 *
 * 机制：mermaid 的 dark 主题只换**它自己那套调色板**（底色与字色配套，所以没写样式的节点没事）；
 * 文档显式写的 `fill` 它照收不改，字色却仍按全局 `primaryTextColor` 翻成浅灰 —— 浅底 + 浅字。
 * WCAG AA 正文要 4.5，1.35 是"读不了"，不是"有点淡"。
 *
 * 拍的兜底口径：**只翻字色，底色一个不改** —— 作者写的颜色是内容，软件不能擅自改内容；
 * 但"字要看得见"是软件的责任。所以只在**对比度不合格**时才动，合格就一律不碰
 * （这条同时保住了"作者自己写了配好的深字色"那种情况不被我们改坏）。
 */

/** WCAG 相对亮度（sRGB 线性化那一套，阈值 4.5 就是按它算的） */
export function 相对亮度(色: [number, number, number]): number {
  const f = 色.map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}

/** 两个颜色的对比度（1~21）；解析不出来给 99（= 当作合格，不去动它） */
export function 对比度(a: string, b: string): number {
  const x = 读色(a);
  const y = 读色(b);
  if (!x || !y) return 99;
  const l1 = 相对亮度(x);
  const l2 = 相对亮度(y);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** `rgb(...)` / `rgba(...)` / `#hex` → 三元组；`none`、`transparent` 与解析不出的一律 null */
function 读色(s: string): [number, number, number] | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+)\s*)?\)/i.exec(s ?? "");
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (a === 0) return null; // 全透明 = 底色不是这个元素给的，别拿它算
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const h = /^\s*#([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(s ?? "");
  if (!h) return null;
  let t = h[1];
  if (t.length === 3) t = t.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(t.slice(i, i + 2), 16)) as [number, number, number];
}

/** 对比度及格线：WCAG AA 正文 4.5 */
const 及格线 = 4.5;

/** 翻字色时用的两个值：浅底配深字、深底配浅字（与两档主题各自的字色同一族，不引入第三种观感） */
const 深字 = "#111111";
const 浅字 = "#f5f5f5";

/**
 * 找出标签里**真正被画出来的那一些元素**（文字叶子）。
 *
 * mermaid 的 htmlLabels 是 `foreignObject > div > span.nodeLabel > p` 这样一串，
 * 主题的 `color:#ccc` 挂在**里面那两级**上。只改外层 div 等于什么都没改 ——
 * 里面的 `p` 照用自己的规则，肉眼看到的就是"粉色矩形里还是浅灰字"
 * （第一版判据全绿而产品没修好，栽的就是这一条：量的是外层，画的是里层）。
 */
function 文字叶子(起: Element): Element[] {
  const out: Element[] = [];
  const 走 = (el: Element) => {
    let 有子 = false;
    for (const c of Array.from(el.children)) {
      if (!(c.textContent ?? "").trim()) continue;
      有子 = true;
      走(c);
    }
    if (!有子 && (el.textContent ?? "").trim()) out.push(el);
  };
  走(起);
  return out;
}

/**
 * 扫一遍渲染好的图，把对比度不合格的节点标签字色翻过来。
 * 返回改了几颗 —— 用例钉的就是这个数（"该修的修了、不该修的没动"两半都要能问出来）。
 */
export function 兜底字色对比度(根: HTMLElement): number {
  let 修了 = 0;
  for (const g of Array.from(根.querySelectorAll("g.node, .node"))) {
    // 形状按文档顺序取第一个能当底的：flowchart 是 rect，decision 是 polygon，circle 图是 ellipse
    const 形 = g.querySelector<SVGElement>("rect, polygon, ellipse, circle, path");
    const 标签 = g.querySelector("foreignObject, .nodeLabel, .label, text");
    if (!形 || !标签) continue;
    const 底 = getComputedStyle(形).fill;
    let 动过 = false;
    for (const 叶 of 文字叶子(标签)) {
      if (对比度(底, getComputedStyle(叶).color) >= 及格线) continue;
      const 亮 = 读色(底);
      (叶 as HTMLElement).style.color = 亮 && 相对亮度(亮) < 0.4 ? 浅字 : 深字;
      动过 = true;
    }
    if (动过) 修了++;
  }
  return 修了;
}

/**
 * 「把渲染好的 svg 塞进容器」这件事的**唯一入口**：插入 →（可选的收尾改造）→ 对比度兜底。
 *
 * 为什么包一层而不是让两个调用方各自 `innerHTML = svg` 再各调一次兜底：
 * 本项目吃过「预览与插入各拼一次」的亏 —— 漏一处就是阅读档好了、编辑档还糊着。
 * 阅读档 hydrate、编辑档 NodeView 都走这里；大图灯箱是**克隆**这份 DOM，自动跟着好。
 *
 * **兜底必须排在最后一步**（`收尾` 之后）：编辑档的 `markEditableLabels` 会重写标签里的内容
 * 好挂上"双击改字"，它跑在兜底之前的话，翻好的行内颜色会被它换掉的新元素盖掉 ——
 * 实测就是这样：阅读档好了、编辑档还是浅灰字。
 *
 * **量样式必须等容器真的在文档里**：游离元素没有计算样式（`fill` 拿到 `none`、`color` 拿到继承值），
 * 于是"没有不合格"永远成立 —— 兜底会静默什么都不做，而判据如果量的是同一个游离子树也会跟着绿。
 * 阅读档 hydrate 时容器已挂上；编辑档第一次渲染可能赶在 PM 把 NodeView 插进文档之前，
 * 所以这里补一个**有界的逐帧重试**（挂上就跑，最多 4 帧；始终没挂上就放弃，不留悬挂回调）。
 */
export function 装入图(容器: HTMLElement, svg: string, 收尾?: () => void): void {
  const 落定 = () => {
    收尾?.();
    兜底字色对比度(容器);
  };
  容器.innerHTML = svg;
  if (容器.isConnected) {
    落定();
    return;
  }
  let 帧 = 0;
  const 试 = () => {
    if (!容器.isConnected) {
      if (++帧 < 4) requestAnimationFrame(试);
      return;
    }
    落定();
  };
  requestAnimationFrame(试);
}

/**
 * 把 `<pre><code class="language-mermaid">` 原地换成渲染后的图。
 * 语法错误时保留错误块 + 原始源码，不白屏（004 验收点）。
 */
export async function hydrateMermaid(root: HTMLElement, opts: MermaidOptions): Promise<number> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("code.language-mermaid"));
  if (blocks.length === 0) return 0;

  let done = 0;

  for (let 序 = 0; 序 < blocks.length; 序++) {
    const code = blocks[序];
    const source = code.textContent ?? "";
    const target = (code.closest("pre") ?? code) as HTMLElement;

    const box = document.createElement("div");
    box.className = "hp-mermaid";
    box.dataset.state = "pending";
    target.replaceWith(box);

    const result = await renderMermaid(source, opts.theme);
    if (result.svg) {
      /*
       * 149-C：阅读档这块**照编辑档的形状搭**（功能栏 + 空提示行 + 图），
       * 而不是只把 svg 塞进去。为什么：编辑档那块 143px、阅读档 94px，
       * 图本身两档一模一样大（708×70），差的 49px 全是编辑档的功能栏与提示行 ——
       * 于是同一篇文档切个模式，每张图下面的正文都上下跳一次。
       * 已定的口径：「让低的兼容高的，两个图整体大小一致（编辑模式包括功能栏）」。
       * 空栏/空提示的高度走 CSS 变量，与编辑档那两处**同源**（见 style.css 的 --hp-codebar-h）。
       *
       * 161：这条栏不再是空的了 —— 编辑档功能栏右端那组缩放键（146-A）在这里也摆一份。
       * 栏还是同一条、高度还是同一个 token，所以 149-C 那条"两档整块等高"不会因为这组键而破。
       */
      const bar = document.createElement("div");
      bar.className = "hp-codebox__bar hp-mermaid__bar";

      const hint = document.createElement("p");
      hint.className = "hp-mermaidbox__hint";
      hint.setAttribute("aria-hidden", "true");
      // 没有行盒就没有高度：空 <p> 是 0px，这条 147 踩过（&nbsp; 撑出真行高）
      hint.textContent = " ";

      const host = document.createElement("div");
      host.className = "hp-mermaidbox__svg";
      // 151：图比正文宽时，**按住右键拖**就把那段溢出滑出来（左键仍留给选字）
      attachRightButtonPan(host);

      /*
       * 161（要求：「阅读模式的 mermaid 加上缩放功能」）：这条栏右端摆的就是 146-A 那三颗键，
       * **不是新做一套缩放** —— 键的构造、档位表、倍率那张表都在 `mermaidZoom.ts`，
       * 编辑档调的是同一个 `建缩放控件`。两档认同一个键（标签页 + 第几张图），
       * 所以「阅读档放大这张图 → 切到编辑档」看到的还是那一档，反过来也一样。
       *
       * 倍率作用在 `host`（`.hp-mermaidbox__svg`）上，与编辑档同一格：
       * 用 CSS `zoom` 不用 `transform`（146 实测 transform 不改布局盒，下面的正文不会被顶开）；
       * 也因此**不会带进灯箱** —— 灯箱拿的是 svg 的克隆，缩放挂在外层容器上，
       * 大图里永远从原尺寸起步（127 那条"看全貌"的语义不该被这篇里调过的倍率污染）。
       */
      const 缩放 = 建缩放控件({
        // 没给标签页 = 认不出这是哪一篇的哪一张图，宁可不记倍率（读回 100%，也不挂到别篇去）
        键: () => (opts.tabKey ? 拼缩放键(opts.tabKey, 序) : ""),
        图: () => host,
        testid: {
          组: "rd-mermaid-zoom",
          缩小: "rd-mermaid-zoom-out",
          倍率: "rd-mermaid-zoom-reset",
          放大: "rd-mermaid-zoom-in",
        },
      });
      bar.append(缩放.dom);
      /*
       * 栏里现在有真能点的键了，`aria-hidden` 必须去掉 —— 挂着它等于把控件对读屏藏起来，
       * 而键还在原地能聚焦（152 那条同一类：别对"没人看得见的东西"做处理）。
       *
       * 这条 dblclick 是必需的：下面 `box` 上那颗"双击图 → 灯箱"会收到从栏里冒上来的双击，
       * 于是**连点两次「放大」= 放大一档 + 顺手弹一张大图**（同一个手势两种含义，127 一直在躲的那种）。
       * 栏是控件区、不是图，双击它不该有语义。
       */
      bar.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        e.preventDefault();
      });

      const stage = document.createElement("div");
      stage.className = "hp-mermaidbox";
      stage.append(hint, host);

      box.replaceChildren(bar, stage);
      box.dataset.state = "done";
      /*
       * 152：插入 + 对比度兜底走同一个入口，而且**必须等这块挂进文档之后**再调。
       * 第一版就栽在顺序上：`装入图(host, …)` 写在 `host` 还没 append 之前，
       * 游离元素没有计算样式（`getComputedStyle` 拿回来是初始值，`fill` 甚至是 `none`），
       * 于是"没有不合格"永远成立 —— **一条也没修，而"不许改坏"那半边判据照样绿**。
       * 兜底类功能必须钉"修了几处 / 每个节点都得及格"，不能只钉"没弄坏"。
       *
       * 161 同一顺序纪律：`缩放.刷新()` 也放在挂载之后 —— 它写的是 `zoom`，
       * 而判据量的是**放大后的图有多宽**，游离状态下量不到真尺寸。
       */
      装入图(host, result.svg);
      缩放.刷新();
      /*
       * 127（要求：「应用架构图很大，无法看到全貌，这种图应该给我单独缩放功能」）：
       * **阅读模式双击图 → 进灯箱，在里面滚轮缩放 + 拖拽平移**。
       * 为什么是点开大图而不是就地缩放：诉求是「看全貌」，而缩到能看全貌时字必然糊 ——
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
