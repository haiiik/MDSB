import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { t } from "../../i18n";
import { paintMath } from "../math";
import { renderMermaid } from "../mermaid";
import { addDismiss } from "../enhance";
import {
  applyLabelEdit,
  findTextSpans,
  labelToEditableHtml,
  scanMermaidLabels,
  type LabelSpan,
} from "../mermaidLabels";
import { HP_STEP_META } from "./history";
import type { ThemeName } from "../render";

/** 110：每次按键都渲一次 Mermaid 会明显卡；250ms 足够让人觉得「改一行图就变了」 */
const MERMAID_DEBOUNCE_MS = 250;

/** 预览区上面那行提示（125 起把「双击改字」也写进去，功能要看得见） */
const MERMAID_HINT = "双击图上的文字可直接改（回车或点别处提交）；点击图则改下方源码";

/**
 * 125：双击图上的文字 → 就地改 → 写回源码里那一段。
 *
 * 从渲染产物回到源码，靠的是 mermaid 给 DOM 挂的 id：
 * 节点是 `<g id="hp-mermaid-3-flowchart-A-0">`（`A` 就是节点 id），
 * 连线标签没有 id，只能按**渲染顺序**与源码里第几条 `|…|` 对齐 ——
 * 两边数量不一致（图里有语法错误、或有我们解析不了的写法）就**拒绝改**，
 * 宁可让人去源码模式，也不能猜一个位置把用户的图写坏。
 */
type LabelTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; index: number }
  | { kind: "text"; id: string };

interface EditableLabel {
  /** 挂 contenteditable 的元素（125：必须是 foreignObject 里的 div，挂 span 打不进字） */
  box: HTMLElement;
  /** 命中判定用的元素 —— 就是用户会点到的那段文字本身 */
  hit: HTMLElement;
  target: LabelTarget;
  span: LabelSpan | null;
  /** span 为 null 时给得出**具体**拒绝理由（标识符 / 位置不唯一），不说空话 */
  reason?: string;
  /**
   * 127：这段文字是 **SVG `<text>`**（sequence / pie / gantt / timeline 都是）。
   * `contentEditable` 在 SVG 元素上根本不存在（探针实测 `"contentEditable" in t === false`，
   * focus 也不进来、打字一个字不进），所以这一类走**覆盖输入框**那条路。
   */
  viaOverlay?: boolean;
}

/** 从 `<g class="node">` 的 id 反解出 flowchart 节点 id（`…-flowchart-A-0` → `A`） */
function nodeIdOf(g: Element): string | null {
  const m = (g.id || "").match(/flowchart-(.+)-\d+$/);
  return m ? m[1] : null;
}

/** 元素**自己**直接挂着的文字（只数文本子节点，不用 textContent 兜底） */
function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
}

/** 往上找那个可以挂 contenteditable 的 div（foreignObject 里的容器） */
function editHost(el: HTMLElement): HTMLElement {
  let cur: HTMLElement | null = el;
  while (cur && cur.tagName.toLowerCase() !== "div") cur = cur.parentElement;
  return cur ?? el;
}

/** 通用文字的定位键：文字 + 类名线索（同一张图里两处同文字同类名 = 不唯一，直接拒绝） */
function textKey(text: string, box: HTMLElement): string {
  return `${text}\u0000${roleHint(box) ?? ""}`;
}

/**
 * 元素「自己 + 往上四层祖先」的类名串。
 *
 * 探针实测：ER 的属性格是 `<g class="row-rect-odd"><foreignObject><div><span class="nodeLabel">string</span>`
 * 这种形状 —— `attribute-type` / `attribute-name` 这些角色类名挂在**外层 g** 上，
 * 不在文字元素自己身上。只读元素自己的 class 会一个都匹配不上
 * （126 第一版就这么全军覆没：标记数 1，只有连线标签侥幸对上）。
 */
function roleHint(box: HTMLElement): string | undefined {
  let cls = "";
  let el: Element | null = box;
  for (let i = 0; el && i < 5; i++, el = el.parentElement) cls += " " + String(el.getAttribute("class") ?? "");
  return ROLES.find((r) => cls.includes(r));
}

const ROLES = [
  "attribute-type",
  "attribute-name",
  "attribute-keys",
  "attribute-comment",
  "stateDescription",
  "note",
  "name",
];

/**
 * 图上**所有**「能双击改」的文字容器，连同它们对应的源码标签区间。
 *
 * 一份清单同时喂给三件事：挂 hover 提示、判双击命中、找要替换的那段源码。
 * 这条是踩出来的：第一版「标记可编辑」与「双击时反查」是两套选择器，
 * 探针实测 `document.querySelector('[data-hp-label]')` 拿到的是**连线标签里的 `<span>`**，
 * 于是标记说「可改」、双击却找不到目标。现在只有一处定义，不可能再对不上。
 *
 * 三条定位路径（126 补齐 ER / state）：
 * ① flowchart 节点 —— 靠 mermaid 挂的 `…-flowchart-A-0` id 精确反查；
 * ② 边上的文字（flowchart 的 `|…|`、ER 的关系标签、state 的迁移标签）——
 *    三者都渲染成 `.edgeLabels > g`，**按顺序与源码里的 edge span 对齐**，数量不等就整条放弃；
 * ③ 通用文字（ER 属性行的四列、state 的 `state "…" as X` 描述、note 正文）——
 *    按「类名 + 文字」匹配，**要求全局唯一**，撞名就不给改。
 * ④ 标识符（ER 实体名、state 状态名）—— 解析得出来但**故意不给改**，
 *    它在别处被引用，改一处就对不上；给出具体理由而不是含糊的「位置不唯一」。
 */
/**
 * 盒子里**真正挂着字的那个元素**（mermaid 通常是 `div > span.nodeLabel > p`）。
 * 命中判定与挂 hover 提示都用它 —— 用外层 div 的话，div 的几何中心可能落在空白处，
 * 第一击会打在 `<svg>` 根上（探针实测到的就是这个）。
 */
function textLeaf(box: HTMLElement): HTMLElement {
  let best = box;
  for (const el of Array.from(box.querySelectorAll<HTMLElement>("p, span, div"))) {
    if (ownText(el)) {
      best = el;
      break;
    }
  }
  return best;
}

export function editableLabels(svg: SVGSVGElement, source: string): EditableLabel[] {
  const spans = scanMermaidLabels(source);
  const out: EditableLabel[] = [];
  const taken = new Set<HTMLElement>();

  for (const g of Array.from(svg.querySelectorAll("g.node"))) {
    const id = nodeIdOf(g);
    if (!id) continue;
    // **要挂 contenteditable 的是 foreignObject 里那个 div，不是 `.nodeLabel` 那个 span**：
    // span 上加了 contenteditable、焦点也在它上面，打字却一个字都进不去（`innerText` 恒空），
    // 表现成「回车后提示标签不能为空」。div 版没这个问题。
    const box = (g.querySelector("foreignObject div") ?? g.querySelector(".nodeLabel")) as HTMLElement | null;
    if (!box || !(box.textContent ?? "").trim()) continue;
    const hits = spans.filter((s) => s.kind === "node" && s.id === id);
    out.push({
      box,
      hit: textLeaf(box),
      target: { kind: "node", id },
      span: hits.length === 1 ? hits[0] : null,
      reason: hits.length === 1 ? undefined : "同一个节点在源码里被定义了两次，改哪一处不确定。",
    });
    taken.add(box);
  }

  const groups = [...svg.querySelectorAll(".edgeLabels > g")].filter((g) => (g.textContent ?? "").trim());
  const edgeSpans = spans.filter((s) => s.kind === "edge");
  if (groups.length === edgeSpans.length) {
    groups.forEach((g, i) => {
      const box = (g.querySelector("div") ?? g.querySelector("span")) as HTMLElement | null;
      if (box) out.push({ box, hit: textLeaf(box), target: { kind: "edge", index: i }, span: edgeSpans[i] });
    });
  }

  // ③ 通用文字 + ④ 标识符：按文字匹配，要求全局唯一
  const textSpans = spans.filter((s) => s.kind === "text");
  const idSpans = spans.filter((s) => s.kind === "id");
  /*
   * 选择器为什么带 `text`：sequence / pie / gantt / timeline 这四类的字是**SVG 文字**，
   * 没有 foreignObject（探针实测 sequence 的 `messageText`、pie 的图例、timeline 的节点名全是 `<text>`）。
   * 只查 foreignObject 的话，「都支持」这件事根本无从谈起。
   */
  for (const node of Array.from(
    svg.querySelectorAll("foreignObject p, foreignObject span, foreignObject div, text")
  )) {
    /*
     * `el` 保持 Element：SVG 的 `<text>` 不是 HTMLElement。
     * 早先写成 `node as HTMLElement`，`instanceof` 那行就把 true 分支推成了 `never`，
     * 而下面用到的 `box` / `hit` 只是**约定交给 contenteditable 或覆盖框两条路分别处理**，
     * 类型上统一按 HTMLElement 传（NodeView 这套接口本来就是给 HTML 用的）。
     */
    const el = node as Element;
    const isHtml = el instanceof HTMLElement;
    const viaOverlay = !isHtml; // SVGTextElement 等
    const text = isHtml ? ownText(el) : (el.textContent ?? "").trim();
    if (!text) continue;
    // HTML 标签的编辑宿主是那个 div；SVG `<text>` 不能挂 contenteditable，直接用它自己
    const box = (isHtml ? editHost(el) : el) as HTMLElement;
    const html = el as HTMLElement;
    if (taken.has(box)) continue;
    const role = roleHint(html);
    const target: LabelTarget = { kind: "text", id: textKey(text, html) };

    const found = textSpans.filter((s) => s.text === text && (!s.domHint || s.domHint === role));
    if (found.length === 1) {
      out.push({ box, hit: html, target, span: found[0], viaOverlay });
      taken.add(box);
      continue;
    }
    if (found.length > 1) {
      out.push({ box, hit: html, target, span: null, reason: "这段文字在源码里出现多次，改哪一处不确定。" });
      continue;
    }
    /*
     * 127：类型专属的解析没命中（`scanXxx` 只写了 flowchart / ER / state），
     * 退到**通用倒查** —— 屏幕上这行字在源码里**只出现一次**就认，多次或零次都拒绝。
     * 这一条兜底让 sequence / class / pie / gantt / journey / mindmap / timeline
     * 这些没专门写解析器的图也能改字，代价是不再区分「这是标签」还是「这是个数字」。
     * 所以拒绝理由必须说清是哪一种（多次 = 有歧义；零次 = 被 mermaid 加工过，比如 pie 的百分比）。
     */
    const generic = findTextSpans(source, text);
    if (generic.length === 1) {
      out.push({ box, hit: html, target, span: generic[0], viaOverlay });
      taken.add(box);
      continue;
    }
    if (idSpans.some((s) => s.text === text)) {
      out.push({
        box,
        hit: html,
        target,
        span: null,
        reason: "这是实体名 / 状态名，关系行里还引用着它，只改这一处会让图对不上。请在源码里整段改。",
      });
      continue;
    }
    if (generic.length > 1) {
      out.push({ box, hit: html, target, span: null, reason: "这段文字在源码里出现多次，改哪一处不确定。" });
    } else {
      // 屏幕上这行字在源码里一个字都找不到：多半是 mermaid 自己算出来的（饼图的百分比、
      // 甘特图的刻度）。这些**本来就不是用户写的**，改它没有意义，必须拒绝并说清为什么。
      out.push({
        box,
        hit: html,
        target,
        span: null,
        reason: `「${text}」是 mermaid 自己算出来或转义过的文字，源码里没有这一段，改不动。请在下面源码里改。`,
      });
    }
  }
  return out;
}

/**
 * 重绘后给「能双击改」的文字挂 `data-hp-label="1"`，给「看得见但不能改」的（实体名 / 状态名、
 * 位置不唯一的那些）挂 `data-hp-label="no"`。
 *
 * 两种都要挂：mousedown 里靠 `[data-hp-label]` 判断「用户点在字上，别把视图滚走」——
 * 不给拒绝的那些挂标记，点它们时就会先滚一下（`scrollIntoView` 实测一次滚掉 185px），
 * 第二个 click 落在别处，**连拒绝提示都弹不出来**。
 * 挂的是命中元素（挂着字的那个 p），不是外层 div —— 标记与命中必须是同一个东西。
 */
function markEditableLabels(svg: SVGSVGElement | null, source: string): void {
  if (!svg) return;
  for (const { hit, span, reason } of editableLabels(svg, source)) {
    hit.setAttribute("data-hp-label", span ? "1" : "no");
    hit.setAttribute("title", span ? "双击修改这段文字" : reason ?? "这一处不能直接改");
  }
}

/**
 * 109：围栏代码块的就地编辑 + 语言下拉。
 *
 * 编辑能力本身 PM 的 `code_block` 就有（`code: true`、`marks: ""`），
 * 所以这颗真正新增的是**语言标注的入口**。
 *
 * 两个容易踩的点：
 * - 工具条必须 `contenteditable="false"`，否则光标会跳进去打字；
 * - 下拉上的事件要被 PM 放行（见 `EditView` 的 `stopEvent`），
 *   否则点下拉会被当成选区移动，菜单打不开。
 *
 * 代码块内容里的 `#` / `-` / 反引号**不会**被当 Markdown 解析：
 * 一是 PM 的 `code: true` 让这块不走输入规则，二是反向映射直接产出 `code` 节点。
 * 113 实现输入规则时必须显式跳过 `code_block`，别依赖这里的默认。
 */

/** 语言候选：与 M1 020 的「常见 25 种」口径对齐，未知语言原样保留并回退纯文本高亮 */
export const CODE_LANGS: { value: string; label: string }[] = [
  { value: "", label: "纯文本" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "toml", label: "TOML" },
  { value: "markdown", label: "Markdown" },
  { value: "mermaid", label: "Mermaid" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "sql", label: "SQL" },
  { value: "bash", label: "Bash" },
  { value: "shell", label: "Shell" },
  { value: "powershell", label: "PowerShell" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
];

/**
 * 110：`code_block` 的 NodeView 同时承载普通代码与 Mermaid 两种形态。
 *
 * 为什么不做成两个 NodeView：PM 按**节点类型**建视图，语言从 `sql` 改成 `mermaid`
 * 不会重建视图 —— 分成两个就会切换后不生效。所以用一个视图 + `sync()` 里切可见性。
 *
 * Mermaid 的「点开即改 + 原地出图」（D2 的验收点）：
 * 预览区在源码上方，点预览即把光标送进源码，改完 250ms 内原地重绘。
 */
export function codeBlockNodeView(
  view: EditorView,
  node: PMNode,
  getPos: () => number | undefined,
  theme: () => ThemeName = () => "light"
): NodeView {
  const box = document.createElement("div");
  box.className = "hp-codebox";
  box.dataset.testid = "pm-codebox";

  const bar = document.createElement("div");
  bar.className = "hp-codebox__bar";
  bar.contentEditable = "false";

  const select = document.createElement("select");
  select.className = "hp-codebox__lang";
  select.dataset.testid = "pm-codelang";
  for (const l of CODE_LANGS) {
    const opt = document.createElement("option");
    opt.value = l.value;
    opt.textContent = l.label;
    select.appendChild(opt);
  }

  const hint = document.createElement("span");
  hint.className = "hp-codebox__hint";

  bar.append(select, hint);

  const pre = document.createElement("pre");
  // 保留 102 那两个属性：tabs-modes.spec.ts 靠它们断言代码块渲染出来了
  pre.dataset.testid = "pm-code-block";
  const code = document.createElement("code");
  pre.appendChild(code);

  /** 110：Mermaid 预览区。只在 language === "mermaid" 时出现 */
  const preview = document.createElement("div");
  preview.className = "hp-mermaidbox";
  preview.dataset.testid = "pm-mermaid-preview";
  preview.dataset.state = "pending";
  preview.contentEditable = "false";

  const previewHint = document.createElement("p");
  previewHint.className = "hp-mermaidbox__hint";
  previewHint.dataset.testid = "pm-mermaid-hint";
  previewHint.textContent = MERMAID_HINT;

  const previewSvg = document.createElement("div");
  previewSvg.className = "hp-mermaidbox__svg";

  const previewError = document.createElement("pre");
  previewError.className = "hp-mermaidbox__error";

  preview.append(previewHint, previewSvg, previewError);
  box.append(bar, preview, pre);

  const current = (n: PMNode) => (n.attrs.language == null ? "" : String(n.attrs.language));

  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSource = "";
  /** 已经排进防抖队列的那份源码（126：不去重就会**连渲两次**，见 scheduleRender 的注释） */
  let queuedSource = "";

  /** 原地重绘：失败时保留错误信息且源码仍可编辑（004 定下的降级口径） */
  async function renderDiagram(source: string) {
    queuedSource = "";
    lastSource = source;
    preview.dataset.state = "pending";
    const result = await renderMermaid(source, theme());
    // 期间用户又改了 → 丢弃这次结果，避免旧图盖住新图
    if (lastSource !== source) return;
    if (result.svg) {
      previewSvg.innerHTML = result.svg;
      previewError.textContent = "";
      preview.dataset.state = "done";
      markEditableLabels(previewSvg.querySelector("svg"), source);
    } else {
      previewSvg.innerHTML = "";
      previewError.textContent = "Mermaid 语法错误，图未渲染：" + (result.error ?? "");
      preview.dataset.state = "error";
      // 127：编辑模式的原地预览里，错误也要能自己关掉。
      // 关掉用的是行内 style（见 addDismiss），所以这次报错必须把它清掉，
      // 否则「关过一次 → 改坏了 → 第二次报错」会看不见。
      previewError.hidden = false;
      previewError.style.display = "";
      addDismiss(previewError, "关闭这个错误提示");
    }
  }

  function scheduleRender(n: PMNode) {
    if (current(n) !== "mermaid") {
      preview.remove();
      box.append(bar, pre);
      return;
    }
    if (!preview.isConnected) box.append(bar, preview, pre);
    /*
     * **同一份源码只渲一次**（126 修的真缺陷，两条各挡一半）：
     * ① 已经渲过这份内容了就不再排 —— 否则「点一下图、光标进源码」这种没改内容的
     *    选区事务也会在 250ms 后把整张图换掉，用户正在双击的第二个 click 打在孤儿上；
     * ② 正在排队 / 正在 await 的也是同一份就不再排 —— 首帧 `sync()` 会被调到两次，
     *    第二次赶到时第一发还没落地（`lastSource` 仍是空），去重不做就会**连渲两次**，
     *    两次 `innerHTML = svg` 之间正好被 Playwright（或用户的手）点到，
     *    事件目标就变成新的 `<svg>` 根 —— 表现成「ER / 状态图双击没反应」。
     */
    if (n.textContent === lastSource || n.textContent === queuedSource) return;
    if (renderTimer) clearTimeout(renderTimer);
    queuedSource = n.textContent;
    renderTimer = setTimeout(() => void renderDiagram(n.textContent), MERMAID_DEBOUNCE_MS);
  }

  // 点预览 → 光标进源码开头（D2 的「点开即改」）。
  // code_block 的内容起点就是 pos + 1（pos 是节点自身位置，+1 跨过它的开标签）。
  preview.addEventListener("mousedown", (e) => {
    /*
     * 两种情况不抢焦点、不动选区（126）：
     * ① 正在改字时 —— 抢了字就打不进去；
     * ② 点的就是「可改的那段字」上 —— 下面那句 `scrollIntoView()` 会把视图滚到代码块开头，
     *    探针实测一次滚掉 185px，于是 dblclick 的第二个 click 落在别处、
     *    事件目标变成 `<svg>` 根，表现成「ER / 状态图双击完全没反应」。
     *    用户点的是图上的字，视图就该待在那儿；
     * ③ 点的是错误提示右上角的关闭叉（127）—— 只想把提示关掉，
     *    不该被顺手把光标和视图送到源码开头；
     * ④ 正开着 SVG 文字的覆盖输入框（127）—— 点输入框里选字，视图一跳字就没了。
     */
    const t = e.target as Element | null;
    if (
      editing ||
      overlay ||
      t?.closest?.("[data-hp-label]") ||
      t?.closest?.(".hp-dismiss") ||
      t?.closest?.(".hp-mermaid-edit")
    ) {
      return;
    }
    e.preventDefault();
    const pos = getPos();
    if (pos == null) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)).scrollIntoView());
    view.focus();
  });

  /* ---------------- 125：双击图上的文字，就地改，只改文字 ---------------- */

  let editing: HTMLElement | null = null;
  /** 进入编辑态之前的渲染 HTML（取消或被拒绝时原样还回去） */
  let editOriginalHtml = "";
  /** 双击时锁定的区间，以及那一刻的源码原文（提交时核对源码没被别处动过） */
  let lastSpan: LabelSpan | null = null;
  let lastSourceText = "";

  /**
   * 提交时找回要替换的源码区间。
   *
   * **不能靠「按文字重新找一遍」**：用户已经把那段字改掉了，
   * 按文字算出来的定位键当场就变了，找不回来 ——
   * 126 第一版就是这么把每一次正常提交都判成「位置不唯一」的。
   * 正解：双击时就把区间与源码一起存住，提交时先核对源码没动过，再直接用那个区间。
   */
  function resolveSpan(): LabelSpan | null {
    if (!lastSpan) return null;
    const pos = getPos();
    const block = pos == null ? null : view.state.doc.nodeAt(pos);
    if (!block || block.textContent !== lastSourceText) return null; // 中间被别处改过，位置不可信
    return lastSpan;
  }

  /** 把提示条临时借用来报错（拒绝写入时必须说清为什么，不能默默不理会） */
  function flashHint(text: string, ms = 5000): void {
    previewHint.textContent = text;
    previewHint.classList.add("is-warn");
    setTimeout(() => {
      previewHint.textContent = MERMAID_HINT;
      previewHint.classList.remove("is-warn");
    }, ms);
  }

  function stopEditing(box: HTMLElement): void {
    // **顺序不能反**：先把监听摘掉，再把 contenteditable 关掉。
    // 关掉 contenteditable 会**当场**触发 blur —— 如果 blur 还在，
    // 「Esc 取消」会变成「Esc 然后提交一次」，把编辑区里那些 `<br>` 当作用户换行写回源码
    // （实测：取消一次，源码里凭空多出 `<br/>`）。
    box.removeEventListener("keydown", onEditKey);
    box.removeEventListener("blur", onEditBlur);
    box.contentEditable = "false";
    box.classList.remove("is-editing");
    editing = null;
  }

  /**
   * 把编辑结果写回源码。**内容可编辑的（HTML 标签）与覆盖输入框（SVG 文字）两条路共用这一份**，
   * 因为「能不能写、为什么不能写」跟用哪种控件编辑毫无关系 —— 分两份早晚写岔。
   *
   * 三种结果：写成了 / 被拒（带具体理由）/ 什么都没改（不许把文档弄脏）。
   */
  function writeBack(text: string): { state: "written" } | { state: "noop" } | { state: "rejected"; reason: string } {
    const pos = getPos();
    if (pos == null) return { state: "noop" };
    const targetNode = view.state.doc.nodeAt(pos);
    if (!targetNode || targetNode.type.name !== "code_block") return { state: "noop" };
    const source = targetNode.textContent;
    const span = resolveSpan();
    if (!span) {
      // 双击到提交之间源码被别处改过（查找替换、手动编辑），位置不可信 —— 不动源码
      return { state: "rejected", reason: "这段源码在双击之后又被别处改过，位置不可信，没有写入。请在下面源码里改。" };
    }
    const result = applyLabelEdit(source, span, text);
    if (!result.ok) return { state: "rejected", reason: result.reason };
    if (result.src === source) return { state: "noop" }; // 一个字都没改，别脏
    // 整块代码内容一次替换：这是「结构操作」不是打字，
    // 打 hpStep 让它自成一步（Ctrl+Z 一次回到改字前，不会一个字一个字退）
    const tr = view.state.tr;
    // code_block 是 text 容器：内容区间 = [pos+1, pos+nodeSize-1]
    tr.insertText(result.src, pos + 1, pos + targetNode.nodeSize - 1).setMeta(HP_STEP_META, true);
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return { state: "written" };
  }

  function commitEdit(): void {
    const box = editing;
    if (!box) return;
    const text = box.innerText;
    stopEditing(box);
    const r = writeBack(text);
    // 没写成时把原来的渲染文字还回去 —— 屏幕上留着一个编辑了一半的空盒子最吓人
    if (r.state === "rejected") {
      box.innerHTML = editOriginalHtml;
      flashHint(r.reason);
    }
  }

  function onEditKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      commitEdit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const box = editing;
      if (box) {
        box.innerHTML = editOriginalHtml;
        stopEditing(box);
      }
      view.focus();
    }
  }

  function onEditBlur(): void {
    // 她 125 明确要的：**失焦也算提交**（回车与点别处两条路都得留下改动）
    commitEdit();
  }

  /* ---------------- 127：SVG `<text>` 走覆盖输入框 ---------------- */

  let overlay: HTMLInputElement | null = null;

  function closeOverlay(): void {
    const input = overlay;
    if (!input) return;
    // **先置空再摘除**：从 DOM 里移走一个有焦点的输入框会当场发一次 blur，
    // 而 blur 的处理器就是「提交」 —— 顺序反了会变成取消也提交一次（125 在 contenteditable 上踩过同样的坑）。
    overlay = null;
    input.removeEventListener("keydown", onOverlayKey);
    input.remove();
  }

  function commitOverlay(): void {
    const input = overlay;
    if (!input) return;
    const text = input.value;
    closeOverlay();
    const r = writeBack(text);
    if (r.state === "rejected") flashHint(r.reason);
  }

  function onOverlayKey(e: KeyboardEvent): void {
    // 输入框上的按键不能漏给 PM —— 否则打字的同时编辑器的撤销栈也在动，Ctrl+Z 会退两段
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitOverlay();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
      view.focus();
    }
  }

  /**
   * 双击哪行字，输入框就**盖在那行字上面**（不是插在图上方做一条编辑栏 —— 那样用户得自己对是第几行）。
   * 位置用两个 rect 的差算，尺寸沿用那段字自己的框，字号按渲染出来的高度折算
   * （SVG 会被 viewBox 缩放，直接拿 CSS 字号会一大一小）。
   */
  function startOverlayEdit(anchor: Element, span: LabelSpan): void {
    closeOverlay();
    const r = anchor.getBoundingClientRect();
    const base = preview.getBoundingClientRect();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "hp-mermaid-edit";
    input.dataset.testid = "pm-mermaid-label-input";
    input.value = span.text;
    input.spellcheck = false;
    input.style.left = Math.max(0, r.left - base.left - 4) + "px";
    input.style.top = Math.max(0, r.top - base.top - 2) + "px";
    input.style.width = Math.max(90, r.width + 26) + "px";
    input.style.height = Math.max(20, r.height + 6) + "px";
    input.style.fontSize = Math.max(12, Math.min(22, Math.round(r.height * 0.8))) + "px";
    preview.append(input);
    overlay = input;
    input.addEventListener("keydown", onOverlayKey);
    // 失焦即提交，与 contenteditable 那条路同一口径（她 125 点名的就是这条）
    input.addEventListener("blur", commitOverlay);
    input.focus();
    input.select();
  }

  preview.addEventListener("dblclick", (e) => {
    const svg = previewSvg.querySelector("svg");
    const el = e.target as Element | null;
    if (!svg || !el) return;
    const pos = getPos();
    const block = pos == null ? null : view.state.doc.nodeAt(pos);
    if (!block) return;
    // 命中判定与「哪些能改」用的是同一份清单（editableLabels），
    // 不会出现「标了可改、双击却说找不到」
    const list = editableLabels(svg, block.textContent);
    /*
     * 命中判定分三层，缺一层就会「看着标了可改、双击却没反应」：
     * ① 事件目标就是那段字（或它的祖先）—— 常规情况；
     * ② 事件目标被别的图形挡住了（ER 的行底、圆角矩形的 path 盖在文字上面，
     *    探针实测 `e.target` 会变成 `<svg>` 根或某个 rect）→ **按点击坐标落在哪个字的框里**来认，
     *    多个框套在一起时取**面积最小**的那个（取第一个会把字写进别的标签，实测就写进过关系标签）；
     * ③ 目标是某个已标记元素的后代（hover 提示挂在谁身上就认谁）。
     *
     * **不许写 `el.contains(l.hit)`**：`el` 是 svg 根时它对每一条都成立，
     * 于是永远命中清单里的第一条 —— 表现是「我改 A 格，结果 B 格的文字被换掉了」，
     * 比不响应更糟（它会静默写坏别处的内容）。
     */
    const x = e.clientX;
    const y = e.clientY;
    const marked = (el as Element).closest?.("[data-hp-label]") as HTMLElement | null;
    const 在字上 = list.find((l) => l.hit === el || l.hit.contains(el));
    const 最小 = list
      .map((l) => ({ l, r: l.hit.getBoundingClientRect() }))
      .filter(({ r }) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
      .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0]?.l;
    const 标记祖先 = marked ? list.find((l) => l.hit === marked || l.hit.contains(marked)) : undefined;
    const 同容器 = list.find((l) => l.box.contains(el));
    const hit = 在字上 ?? 最小 ?? 标记祖先 ?? 同容器;
    if (!hit) return;
    if (!hit.span) {
      flashHint(hit.reason ?? "这一处在源码里定位不唯一，为了不改坏图没有开启就地编辑。请在下面源码里改。");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (editing) stopEditing(editing);
    lastSpan = hit.span;
    lastSourceText = block.textContent;
    /*
     * 127：SVG 文字（sequence / pie / gantt / timeline）不能挂 contenteditable，
     * 盖一个输入框上去。清单里那位 `viaOverlay` 是**探针测出来的**，不是我猜的：
     * `contentEditable` 在 SVG 元素上连属性都不存在，focus 也进不去。
     */
    if (hit.viaOverlay) {
      startOverlayEdit(hit.hit, hit.span);
      return;
    }
    editOriginalHtml = hit.box.innerHTML;
    // 编辑的是**源码里那段文字**，不是屏幕上的渲染产物 ——
    // 渲染时我们为了折行插过 `<br/>`，拿渲染结果当编辑内容就会把它当成用户换行写回源码
    hit.box.innerHTML = labelToEditableHtml(hit.span.text);
    editing = hit.box;
    hit.box.contentEditable = "true";
    hit.box.spellcheck = false;
    hit.box.classList.add("is-editing");
    // 监听必须在进入编辑态时挂上：`stopEditing` 里负责摘。
    // 第一版只在 stopEditing 里 removeEventListener、这里忘了 add，
    // 表现成「能打字、能全选，回车与失焦却什么都不做」
    hit.box.addEventListener("keydown", onEditKey);
    hit.box.addEventListener("blur", onEditBlur);
    hit.box.focus();
    // 全选：双击进来就是要换整段文字，不是接在后面追加
    const r = document.createRange();
    r.selectNodeContents(hit.box);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  });

  function sync(n: PMNode) {
    const lang = current(n);
    // 未知语言（如 `klingon`）不在候选里：保留原值并显式提示，而不是悄悄丢掉标注
    const known = CODE_LANGS.some((l) => l.value === lang);
    select.value = known ? lang : "";
    hint.textContent = known ? "" : `未识别的语言标注：${lang}（按纯文本高亮，标注会原样保存）`;
    pre.dataset.language = lang;
    if (!known && lang) {
      // 把未知语言临时挂进去，保证下拉里能看到当前真实值
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = `${lang}（未识别）`;
      select.appendChild(opt);
      select.value = lang;
    }
    box.dataset.mermaid = lang === "mermaid" ? "1" : "0";
    scheduleRender(n);
  }

  select.addEventListener("change", () => {
    // 位置必须问 PM 要（`getPos()`），不能自己拿 posAtDOM 猜偏移。
    const pos = getPos();
    if (pos == null) return;
    const target = view.state.doc.nodeAt(pos);
    if (!target || target.type.name !== "code_block") return;
    const next = select.value === "" ? null : select.value;
    if (next === (target.attrs.language ?? null)) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...target.attrs, language: next }));
  });

  sync(node);

  return {
    dom: box,
    contentDOM: code,
    // 预览区里 Mermaid 注入的 SVG 不是 PM 的内容，DOM 变更与事件都不能交给 PM，
    // 否则 PM 会试图把它同步回文档模型（表现为图一闪即消或整块被清空）。
    ignoreMutation: (m) => bar.contains(m.target as Node) || preview.contains(m.target as Node),
    /**
     * 工具条（语言下拉）与 Mermaid 预览上的事件不交给 PM。
     *
     * `stopEvent` 是 **`NodeView` 的成员**，不是编辑器 props 的
     * （`prosemirror-view/dist/index.d.ts` 里它在 `interface NodeView` 下，
     * `DirectEditorProps` 与 `Plugin.props` 上都没有）。放错位置 `vue-tsc` 报 TS2353，
     * 而运行时表现为「下拉点不开 / 点了没反应」。
     */
    stopEvent: (event) => bar.contains(event.target as Node) || preview.contains(event.target as Node),
    update: (updated) => {
      if (updated.type.name !== "code_block") return false;
      // 清掉上一次为未知语言临时加的选项
      for (const opt of Array.from(select.options)) {
        if (!CODE_LANGS.some((l) => l.value === opt.value)) select.removeChild(opt);
      }
      sync(updated);
      return true;
    },
    destroy: () => {
      if (renderTimer) clearTimeout(renderTimer);
      // 正在改字时切走模式（组件被卸载）：把 contenteditable 收掉，
      // 否则那张临时网口留在文档里，PM 的 DOM 与模型就对不上了
      if (editing) {
        stopEditing(editing);
      }
    },
    selectNode: () => box.classList.add("is-selected"),
    deselectNode: () => box.classList.remove("is-selected"),
  };
}

/**
 * 138-B：块级公式的 NodeView —— **上面是排版结果，下面是能改的源码**。
 *
 * 抄的是 109/110 代码块 + Mermaid 那套（她 2026-10-17 的原话就是"复用 Mermaid 那套就地编辑"），
 * 三件要紧的事一并抄过来：
 * ① **防抖 250ms**：每按一个键渲一次会明显卡；
 * ② **同一份源码只渲一次**（`lastSource`/`queuedSource` 两道去重）：
 *    不去重时"点一下预览把光标送进源码"这种没改内容的选区事务也会重渲整块，
 *    用户正在双击的那一下会打在孤儿节点上（126 的真缺陷）；
 * ③ **渲不出来不许把源码藏起来**：预览区退回原文 + 提示行报错（004 的降级口径）。
 *
 * 定界符 `$$` **不在 DOM 里**（schema 的 toDOM 也不放）—— 136-B 实测过：
 * 装饰文字进了 DOM 就会被 PM 的 `domAtPos` 认成内容区，打字落进标记里。
 */
export function mathBlockNodeView(
  view: EditorView,
  node: PMNode,
  getPos: () => number | undefined
): NodeView {
  const box = document.createElement("div");
  box.className = "hp-mathblock";
  box.setAttribute("data-hp-mathblock", "1");
  box.dataset.testid = "pm-math-block";

  const bar = document.createElement("div");
  bar.className = "hp-mathblock__bar";
  bar.contentEditable = "false";
  const hint = document.createElement("span");
  hint.className = "hp-mathblock__hint";
  hint.dataset.testid = "pm-math-hint";
  hint.textContent = t("math.editHint");
  bar.append(hint);

  const preview = document.createElement("div");
  preview.className = "hp-mathblock__preview";
  preview.dataset.testid = "pm-math-preview";
  preview.dataset.state = "pending";
  preview.contentEditable = "false";

  const pre = document.createElement("pre");
  pre.className = "hp-mathblock__src";
  const code = document.createElement("code");
  code.dataset.testid = "pm-math-src";
  pre.append(code);

  box.append(bar, preview, pre);

  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSource = "";
  let queuedSource = "";

  async function renderSource(source: string) {
    queuedSource = "";
    lastSource = source;
    preview.dataset.state = "pending";
    const result = await paintMath(preview, source, true);
    // 期间用户又改了 → 丢弃这次结果，别让旧图盖住新图
    if (lastSource !== source) return;
    if (result.state === "done") {
      preview.dataset.state = "done";
      hint.textContent = t("math.editHint");
      hint.classList.remove("is-warn");
    } else {
      preview.dataset.state = "error";
      hint.textContent = t("math.errorTip") + result.error.split("\n")[0].trim();
      hint.classList.add("is-warn");
    }
  }

  function schedule(source: string) {
    if (source === lastSource || source === queuedSource) return;
    if (renderTimer) clearTimeout(renderTimer);
    queuedSource = source;
    renderTimer = setTimeout(() => void renderSource(source), MERMAID_DEBOUNCE_MS);
  }

  // 点预览 → 光标进源码开头（与 110 的「点开即改」同一个动作）。
  // math_block 的内容起点就是 pos + 1（pos 是节点自身位置，+1 跨过它的开标签）。
  preview.addEventListener("mousedown", (e) => {
    const pos = getPos();
    if (pos == null) return;
    e.preventDefault();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)).scrollIntoView());
    view.focus();
  });

  const sync = (n: PMNode) => schedule(n.textContent);
  sync(node);

  return {
    dom: box,
    contentDOM: code,
    // 预览与提示条都不是 PM 的内容：DOM 变更与事件都不许交给 PM
    //（`stopEvent` 是 NodeView 的成员，不是编辑器 props 的，放错位置运行时就点不动）
    ignoreMutation: (m) => bar.contains(m.target as Node) || preview.contains(m.target as Node),
    stopEvent: (e) => bar.contains(e.target as Node) || preview.contains(e.target as Node),
    update: (updated) => {
      if (updated.type.name !== "math_block") return false;
      sync(updated);
      return true;
    },
    destroy: () => {
      if (renderTimer) clearTimeout(renderTimer);
    },
    selectNode: () => box.classList.add("is-selected"),
    deselectNode: () => box.classList.remove("is-selected"),
  };
}
