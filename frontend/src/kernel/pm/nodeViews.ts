import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { Plugin, TextSelection, type EditorState } from "prosemirror-state";
import { t, tf } from "../../i18n";
import { paintMath } from "../math";
import { renderMermaid, 装入图 } from "../mermaid";
import { addDismiss } from "../enhance";
import { attachRightButtonPan } from "../panDrag";
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

/**
 * 145：编辑档里**「源码 + 另有渲染产物」那种块**默认收起源码。
 *
 * 2026-10-22 两句把口径钉死（我第一版理解反了）：
 * > 代码块不收，收的是既展示源码又通过其他方式展示的内容
 * > 编辑模式源码隐藏的再彻底一点，点了编辑源码再展开
 * 所以参与折叠的只有 **Mermaid 块**（图就是它的另一种展示）和**块级公式**（排版结果是另一种展示），
 * 而「收起」= **整段源码不显示**，要源码就点「编辑源码」。
 * 普通代码块摊开显示、不给按钮 —— 源码是它唯一的内容，收起来等于把代码藏了。
 *
 * **收起不能用 `display: none`**：那块 `pre` 里挂着 PM 的 `contentDOM`，
 * 子树整个从渲染树里摘掉之后，PM 的坐标与光标无处可放
 * （143「改 CSS 也能把编辑功能弄坏」的同族）。走 `max-height: 0` + 内边距归零：盒子还在，只是高 0。
 */

/**
 * 在册代码块的折叠重算函数（145）。
 *
 * 为什么要有这张表：`NodeView` 上没有「选区变了」的回调 ——
 * `update()` 只在**这个节点的内容/属性变了**时才被调，光标走进一个没变过的块，
 * 视图这里一次都不会被叫到。而「光标进块就必须展开」正是这条功能唯一的真陷阱
 * （光标落在一个被 clipping 掉的 `pre` 里打字 = 看不见自己打的什么）。
 * 所以由 `codeFoldWatchPlugin` 在每次状态更新时集体问一遍。
 */
const 折叠重算 = new Set<(state: EditorState) => void>();

/** 145：选区一变就通知所有在册块重算折叠状态；挂在编辑模式的插件列表里 */
export function codeFoldWatchPlugin(): Plugin {
  return new Plugin({
    view: () => ({
      update: (v) => {
        // 快照再遍历：重算里可能销毁/新建视图，直接遍历 Set 会被自己改坏
        for (const f of Array.from(折叠重算)) f(v.state);
      },
    }),
  });
}

/**
 * 145：把「收起 / 编辑源码 / 光标进块就展开」这套接到一个 NodeView 上。
 *
 * Mermaid 代码块与块级公式**共用这一份**：两边要守的规矩一条不差
 * （光标在块里时不给「收起」、先展开再派发再滚、按钮三态），
 * 抄两遍早晚改岔 —— 本项目已经吃过「预览与插入各拼一次」的同类亏。
 */
function 挂折叠(a: {
  /** 写 `data-folded` 的外框 */
  box: HTMLElement;
  /** 工具条：按钮挂在它右端 */
  bar: HTMLElement;
  /** 被 max-height 裁掉的那块源码区 */
  源区: HTMLElement;
  /** 这块该不该参与折叠（由调用方按「有没有另一种展示」判） */
  可折: () => boolean;
  view: EditorView;
  getPos: () => number | undefined;
}): { 重算: (state: EditorState) => void; 销毁: () => void } {
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "hp-codebox__fold";
  fold.dataset.testid = "pm-code-fold";
  fold.hidden = true;
  a.bar.append(fold);

  /** 点过「编辑源码」= 这块是展开的，之后不再自动收回去 */
  let 用户展开 = false;

  /**
   * 光标（或整块的选中）是否落在这块的区间里。
   * 用「选区与节点区间有任何重叠」判，不用 `$from.parent === 节点`：
   * NodeSelection 选中整块时 `from === pos`、`parent` 是文档根，那条判据会漏掉它，
   * 于是「整块被选中着、源码却收着」。
   */
  function 光标在块内(state: EditorState): boolean {
    const pos = a.getPos();
    if (pos == null) return false;
    const n = state.doc.nodeAt(pos);
    if (!n) return false;
    return state.selection.from < pos + n.nodeSize && state.selection.to > pos;
  }

  function 重算(state: EditorState): void {
    const 收 = a.可折() && !用户展开 && !光标在块内(state);
    a.box.dataset.folded = 收 ? "1" : "0";
    /*
     * 按钮两态，**只要这块可折就一直挂着**（149-B）：
     * - 收着 → 「编辑源码」（要求的入口）；
     * - 展开着 → 「收起」，**光标还在块里也给**。
     *
     * 145/146 那一版是「光标在块里就不给按钮」，理由是"正在打字时别把纸抽走"。
     * 实测这条把回路堵死了：点「编辑源码」的第一件事就是把光标送进源码，
     * 于是刚展开的那一块**恰好是唯一不给「收起」的那一块**，
     * 10-22 的原话就是「编辑源码如何关闭？」。
     * 不抽纸的办法不是藏键，是**点下去先把光标挪出块**（见下面的 click）。
     */
    if (!a.可折()) {
      fold.hidden = true;
      return;
    }
    fold.hidden = false;
    const 文 = 收 ? t("code.editSource") : t("code.collapse");
    fold.textContent = 文;
    fold.title = 文;
  }

  fold.addEventListener("click", (e) => {
    e.preventDefault();
    const pos = a.getPos();
    if (pos == null) return;
    if (a.box.dataset.folded === "1") {
      用户展开 = true;
      重算(a.view.state);
      /*
       * 「点击后显示源码并把滚动条定位到源码位置」= 光标进源码开头 + 滚过去。
       * 顺序要紧：**先展开再派发**。收起时源码区被 max-height 裁着，
       * 先派发的话 PM 量到的是收起后的框。
       */
      a.view.dispatch(
        a.view.state.tr
          .setSelection(TextSelection.create(a.view.state.doc, pos + 1))
          .scrollIntoView()
      );
      /*
       * PM 的 `scrollIntoView` 只保证**光标那一寸**在视口里，实测：工具条卡在视口下沿时点这颗键，
       * `scrollTop` 一格没动，展开的源码整段还在屏幕外。原始诉求是「显示源码**并把滚动条定位到
       * 源码位置**」，所以补一次「把整块源码滚进来」：`nearest` = 放得下就整块进视口，
       * 放不下就把顶边对齐视口上沿，不会把已经在看的块硬甩到最上面。
       */
      a.源区.scrollIntoView({ block: "nearest" });
      a.view.focus();
      return;
    }
    用户展开 = false;
    /*
     * 149-B：收起时**光标可能正泡在这块源码里**（点「编辑源码」就是把光标送进去的那一下）。
     * 直接把 `data-folded` 拨回去 = 源码区被 max-height 裁成 0，光标还在里面、
     * 看不见却还在吃输入，接着打字就打进了一段隐形的文字里。
     * 所以先把光标挪到**这一块之后**（142 之后文档永远以普通段落收尾，
     * 最后一块后面必定还有一段可以落脚），再重算 —— 重算时 `光标在块内` 已经为假，收得下去。
     */
    if (pos != null && 光标在块内(a.view.state)) {
      const n = a.view.state.doc.nodeAt(pos);
      if (n) {
        const 外 = Math.min(pos + n.nodeSize, a.view.state.doc.content.size);
        a.view.dispatch(
          a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 外)).scrollIntoView()
        );
      }
    }
    重算(a.view.state);
  });

  折叠重算.add(重算);
  return { 重算, 销毁: () => 折叠重算.delete(重算) };
}

/**
 * 146-A：**每张 Mermaid 图自己的缩放倍率**。
 *
 * 要求的是"这一张图放大一点"，不是整篇文档的缩放（025 那颗管的是后者）。
 * 倍率**不进文档**：它是视图属性，写进 .md 就是污染原文（保真口径）。
 * 键 = 标签页 + 该块的源区间，所以换模式、换标签回来还是调过的那一档；
 * 没有源区间的块（刚粘贴进来的）不认，从 100% 起。
 */
const 图缩放 = new Map<string, number>();
const 缩放档 = [0.3, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** 145：有源码可看才收（空源码那块没东西可藏，别摆一颗点不动的键） */
function 源码可折(n: PMNode): boolean {
  return n.textContent !== "";
}

/** 预览区上面那行提示（125 起把「双击改字」也写进去，功能要看得见） */
/** 139：改成函数 —— 模块级常量等于在 import 那一刻就把语言烘死了，切成 English 也不会变 */
const mermaidHint = () => t("mermaid.editHint");

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
      reason: hits.length === 1 ? undefined : t("mermaid.duplicateDefinition"),
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
      out.push({ box, hit: html, target, span: null, reason: t("mermaid.ambiguousMatch") });
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
        reason: t("mermaid.identifierLocked"),
      });
      continue;
    }
    if (generic.length > 1) {
      out.push({ box, hit: html, target, span: null, reason: t("mermaid.ambiguousMatch") });
    } else {
      // 屏幕上这行字在源码里一个字都找不到：多半是 mermaid 自己算出来的（饼图的百分比、
      // 甘特图的刻度）。这些**本来就不是用户写的**，改它没有意义，必须拒绝并说清为什么。
      out.push({
        box,
        hit: html,
        target,
        span: null,
        reason: tf("mermaid.notInSource", { text }),
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
    hit.setAttribute("title", span ? t("mermaid.dblClickToEdit") : reason ?? t("mermaid.cannotEditHere"));
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
  // 空值 = 纯文本；标签在建 option 时按当前语言取（常量里烘中文 = 语言在 import 时定死）
  { value: "", label: "" },
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
  theme: () => ThemeName = () => "light",
  /** 146-A：缩放倍率存在哪张表里（按标签页分开，不同文件之间不串） */
  tabKey: () => string = () => ""
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
    // 139：语言候选表是模块级常量，只有「纯文本」这一条是要翻译的界面文案，
    // 所以它在使用点取字典，不在常量里烘死。
    opt.textContent = l.value === "" ? t("code.plainText") : l.label;
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
  previewHint.textContent = mermaidHint();

  const previewSvg = document.createElement("div");
  previewSvg.className = "hp-mermaidbox__svg";
  /** 151：图比正文宽时按住右键拖出那段溢出（与阅读档共用 `kernel/panDrag`，两处不各写一份） */
  const 解除拖动 = attachRightButtonPan(previewSvg);

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
      /*
       * 152：`markEditableLabels` 会**重写标签里的内容**来挂"双击改字"，
       * 所以它必须作为「收尾」传进 `装入图`，排在对比度兜底**之前**跑完 ——
       * 先前写成"先兜底再标记"，标记把翻好的行内颜色连同旧元素一起换掉，
       * 结果阅读档好了、编辑档还是浅灰字（判据按真正画字的那个叶子量才抓到）。
       */
      装入图(previewSvg, result.svg, () => {
        markEditableLabels(previewSvg.querySelector("svg"), source);
      });
      previewError.textContent = "";
      preview.dataset.state = "done";
    } else {
      previewSvg.innerHTML = "";
      previewError.textContent = t("mermaid.errorPrefix") + (result.error ?? "");
      preview.dataset.state = "error";
      // 127：编辑模式的原地预览里，错误也要能自己关掉。
      // 关掉用的是行内 style（见 addDismiss），所以这次报错必须把它清掉，
      // 否则「关过一次 → 改坏了 → 第二次报错」会看不见。
      previewError.hidden = false;
      previewError.style.display = "";
      addDismiss(previewError, t("mermaid.dismissErrorTip"));
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
      previewHint.textContent = mermaidHint();
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
      return { state: "rejected", reason: t("mermaid.sourceMoved") };
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
    // 125 明确要的：**失焦也算提交**（回车与点别处两条路都得留下改动）
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
    // 失焦即提交，与 contenteditable 那条路同一口径（125 点名的就是这条）
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
      flashHint(hit.reason ?? t("mermaid.ambiguousNoEdit"));
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

  /* ---------------- 145：Mermaid 块的源码默认收起（普通代码块不收） ---------------- */

  /** `update()` 之后要跟着的当前节点（`node` 是建视图时那份，改过语言/内容就是旧的） */
  let 当前节点 = node;

  const 折叠 = 挂折叠({
    box,
    bar,
    源区: pre,
    /*
     * 2026-10-22 把口径钉死：「代码块不收，收的是既展示源码又通过其他方式展示的内容」。
     * 所以这里只认 `mermaid` —— 图就是它"另一种展示"，源码是次要的那一份。
     * 语言从 `sql` 改成 `mermaid` 不会重建视图（110 为此把两种形态收在一个视图里），
     * 所以这一句是**每次重算时现读**：改语言，收起/展开自己跟着变。
     */
    可折: () => current(当前节点) === "mermaid" && 源码可折(当前节点),
    view,
    getPos,
  });

  /* ---------------- 146-A：这一张图自己的缩放 ---------------- */
  /*
   * ：「mermaid 图新增支持单独缩放，缩放功能放编辑功能右侧」。
   * 三颗键：`−` 倍率 `+`，点倍率回 100%。只作用在**渲染出来的那张图**上，
   * 倍率存在视图侧的表里（键 = 标签页 + 该块源区间），**一个字节都不进文档** ——
   * 缩放是"怎么看"，不是"文档里有什么"。
   */
  const 缩放组 = document.createElement("span");
  缩放组.className = "hp-codebox__zoom";
  缩放组.dataset.testid = "pm-mermaid-zoom";
  const 缩小 = document.createElement("button");
  缩小.type = "button";
  const 倍率 = document.createElement("button");
  倍率.type = "button";
  倍率.dataset.testid = "pm-mermaid-zoom-reset";
  const 放大 = document.createElement("button");
  放大.type = "button";
  for (const [b, 文, 键] of [
    [缩小, "−", "code.zoomOut"],
    [放大, "+", "code.zoomIn"],
  ] as const) {
    b.textContent = 文;
    b.dataset.testid = 键 === "code.zoomIn" ? "pm-mermaid-zoom-in" : "pm-mermaid-zoom-out";
    b.title = t(键);
  }
  倍率.title = t("code.zoomReset");
  缩放组.append(缩小, 倍率, 放大);
  bar.append(缩放组);

  /** 当前倍率存在哪一格：没有源区间的块（刚粘贴进来的）不认，从 100% 起 */
  const 缩放键 = (): string => {
    const pos = getPos();
    const n = pos == null ? null : view.state.doc.nodeAt(pos);
    const 起 = n ? (n.attrs.srcFrom ?? null) : null;
    const 止 = n ? (n.attrs.srcTo ?? null) : null;
    return 起 == null ? "" : tabKey() + ":" + 起 + "-" + 止;
  };
  let 倍 = 1;

  function 画缩放(): void {
    缩放组.hidden = current(当前节点) !== "mermaid";
    previewSvg.style.zoom = String(倍);
    倍率.textContent = Math.round(倍 * 100) + "%";
    缩小.disabled = 倍 <= 缩放档[0];
    放大.disabled = 倍 >= 缩放档[缩放档.length - 1];
  }

  /** 往某一侧走一档：跳过表里没有的值，取最近的那一档 */
  function 调倍率(delta: 1 | -1): void {
    const 目标 =
      delta > 0
        ? 缩放档.find((v) => v > 倍 + 1e-6)
        : [...缩放档].reverse().find((v) => v < 倍 - 1e-6);
    if (!目标 || 目标 === 倍) return;
    倍 = 目标;
    const k = 缩放键();
    if (k) 图缩放.set(k, 倍);
    画缩放();
  }

  缩小.addEventListener("click", (e) => {
    e.preventDefault();
    调倍率(-1);
  });
  放大.addEventListener("click", (e) => {
    e.preventDefault();
    调倍率(1);
  });
  倍率.addEventListener("click", (e) => {
    e.preventDefault();
    倍 = 1;
    const k = 缩放键();
    if (k) 图缩放.set(k, 1);
    画缩放();
  });


  function sync(n: PMNode) {
    当前节点 = n;
    const lang = current(n);
    // 未知语言（如 `klingon`）不在候选里：保留原值并显式提示，而不是悄悄丢掉标注
    const known = CODE_LANGS.some((l) => l.value === lang);
    select.value = known ? lang : "";
    hint.textContent = known ? "" : tf("code.unknownLang", { lang });
    pre.dataset.language = lang;
    if (!known && lang) {
      // 把未知语言临时挂进去，保证下拉里能看到当前真实值
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = tf("code.unknownLangOption", { lang });
      select.appendChild(opt);
      select.value = lang;
    }
    box.dataset.mermaid = lang === "mermaid" ? "1" : "0";
    // 146-A：换档 / 换标签回来时认回这张图自己的倍率（键认不到就回 100%）
    const k = 缩放键();
    倍 = k && 图缩放.has(k) ? (图缩放.get(k) as number) : 1;
    画缩放();
    scheduleRender(n);
    // 内容变了（删了几行、或从 30 行粘成 2 行）→ 折叠状态与按钮要跟着重判
    折叠.重算(view.state);
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
    /*
     * 只有**内容区**（`code`）里的变更才是 PM 的事，其余一律不许它管。
     *
     * 145 踩出来的：折叠状态写在 `box` 自己的 `data-folded` 上，
     * 而旧写法只挡了 `bar` 与 `preview` 两棵子树 —— `box` 上的属性变更漏了出去，
     * PM 的 DOMObserver 把它当成「有人从外面改了这个节点」→ 销毁重建 NodeView →
     * 新视图建好又写一次 `data-folded`（新节点上这个属性本来不存在，是真变更）→ 再重建……
     * **死循环，整个编辑模式当场卡住**（7 条用例全红在 `.hp-codebox` 等不到可见）。
     * PM 自己应用 DOM 变更时会先 `observer.stop()`，所以这里放行内容区不会吞掉它自己的编辑。
     */
    ignoreMutation: (m) => !code.contains(m.target as Node),
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
      // 145：视图没了就要从折叠名册里摘掉，否则插件每次选区变动都在给孤儿算状态
      折叠.销毁();
      // 151：右键拖图的监听跟着视图一起摘（NodeView 的 DOM 会被复用/丢弃，留着就是泄漏）
      解除拖动();
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
 * 抄的是 109/110 代码块 + Mermaid 那套（2026-10-17 的原话就是"复用 Mermaid 那套就地编辑"），
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

  /*
   * 145：公式块是「源码 + 排版结果」两份同屏 —— 正是 2026-10-22 定的那条口径里
   * 「既展示源码又通过其他方式展示的内容」，所以这一类收；普通代码块不收。
   * 与 Mermaid 共用同一套 `挂折叠`（光标进块就展开、光标在块里不给「收起」、
   * 点开后把整块源码滚进视口），两边规矩一条不差，抄两遍早晚改岔。
   */
  let 当前节点 = node;
  const 折叠 = 挂折叠({
    box,
    bar,
    源区: pre,
    可折: () => 源码可折(当前节点),
    view,
    getPos,
  });

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

  const sync = (n: PMNode) => {
    当前节点 = n;
    schedule(n.textContent);
    折叠.重算(view.state);
  };
  sync(node);

  return {
    dom: box,
    contentDOM: code,
    // 预览与提示条都不是 PM 的内容：DOM 变更与事件都不许交给 PM
    //（`stopEvent` 是 NodeView 的成员，不是编辑器 props 的，放错位置运行时就点不动）
    /*
     * 145：口径换成「只有内容区（`code`）里的变更才交给 PM」。
     * 往 NodeView 自己的 `dom` 上写 `data-folded` 时若这条不挡，
     * PM 会当成"外部改了节点"→ 销毁重建视图 → 新节点上这个属性本来不存在 → 再重建 → **死循环**。
     */
    ignoreMutation: (m) => !code.contains(m.target as Node),
    stopEvent: (e) => bar.contains(e.target as Node) || preview.contains(e.target as Node),
    update: (updated) => {
      if (updated.type.name !== "math_block") return false;
      sync(updated);
      return true;
    },
    destroy: () => {
      if (renderTimer) clearTimeout(renderTimer);
      // 145：视图没了就要从折叠名册里摘掉，否则插件每次选区变动都在给孤儿算状态
      折叠.销毁();
    },
    selectNode: () => box.classList.add("is-selected"),
    deselectNode: () => box.classList.remove("is-selected"),
  };
}
