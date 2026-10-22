import type { Match } from "../kernel/search";
import type { SearchAdapter } from "../state/search";

/**
 * 118：阅读模式的查找适配器（**只读**，不产生脏状态 —— 工单注记）。
 *
 * 用 CSS Custom Highlight API（`CSS.highlights`）而不是往 DOM 里塞 `<mark>`：
 * 阅读模式的 DOM 是 `render()` 一次性建出来的，改它就等于改渲染产物，
 * 下一次渲染或增强（021 的图片占位、020 的代码块）会与我们的改动打架；
 * Highlight API 只在绘制阶段加样式，DOM 一个节点都不动。
 *
 * 不支持该 API 的浏览器（很老的 WebView2 运行时）退化成「只把当前项选起来」，
 * 计数仍然对，只是没有满屏高亮 —— 退化路径也测过，不是没考虑。
 */

type Run = { from: number; to: number; node: Text };

/** 焦点是不是在「正在输入」的地方（输入框 / textarea / contenteditable） */
function isEditingField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

const HIGHLIGHT_ALL = "hp-search";
const HIGHLIGHT_CURRENT = "hp-search-current";

function supportsHighlightApi(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

function collect(root: HTMLElement): { text: string; runs: Run[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const runs: Run[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const value = node.data;
    if (!value) continue;
    runs.push({ from: text.length, to: text.length + value.length, node });
    text += value;
  }
  return { text, runs };
}

export function makeDomAdapter(root: () => HTMLElement | null, scroller: () => HTMLElement | null): SearchAdapter {
  let cached = { text: "", runs: [] as Run[] };
  /** 148：上一次画出来的那些 Range（下标 = 第几处命中），点击命中判定要用它撞矩形 */
  let 画的区间: Range[] = [];
  const refresh = () => {
    const el = root();
    cached = el ? collect(el) : { text: "", runs: [] };
  };

  const clear = () => {
    if (supportsHighlightApi()) {
      CSS.highlights.delete(HIGHLIGHT_ALL);
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    }
    // 焦点在输入框里时**别动文档选区**：Chromium 下 removeAllRanges() 会打断输入法组合，
    // 表现就是查找框里敲第二个字没反应（140 她的报告）
    if (!isEditingField()) window.getSelection()?.removeAllRanges();
  };

  return {
    text: () => {
      refresh();
      return cached.text;
    },
    canReplace: false, // 阅读模式只读
    /*
     * 148：阅读档的高亮是 CSS Custom Highlight 画的，**DOM 里没有元素可查**，
     * 只能拿上一次那些 Range 的矩形去撞点中的位置。
     */
    indexAtPoint: (x, y) => {
      for (let i = 0; i < 画的区间.length; i++) {
        for (const r of Array.from(画的区间[i].getClientRects())) {
          if (r.width <= 0) continue;
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
        }
      }
      return -1;
    },
    apply(matches, current, reveal) {
      refresh();
      clear();
      画的区间 = [];
      if (!matches.length) return;
      const ranges: Range[] = [];
      for (const m of matches) {
        const r = rangeFor(cached.runs, m);
        if (r) ranges.push(r);
      }
      画的区间 = ranges;
      if (supportsHighlightApi()) {
        CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges.filter((_, i) => i !== current)));
        if (current >= 0 && ranges[current]) {
          CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(ranges[current]));
          if (reveal) scrollToRange(scroller(), ranges[current]);
        }
        return;
      }
      // 退化路径（老 WebView2 没有 Highlight API）只能靠选区画当前项 —— 这条**会动 DOM 选区**，
      // 所以同样只在 reveal 时做，否则打字途中会把输入框的输入法组合期打断
      if (reveal && current >= 0 && ranges[current]) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(ranges[current]);
        scrollToRange(scroller(), ranges[current]);
      }
    },
  };
}

/**
 * 一个命中可以横跨多个文字节点（比如一段文字被 `<strong>` 切成三个文本节点）。
 * `Range` 本身就支持跨节点端点，所以只需要找到**首**、**末**两个落点。
 */
/**
 * 一个命中可以横跨多个文字节点（比如一段文字被 `<strong>` 切成三个文本节点）。
 * `Range` 本身就支持跨节点端点，所以只需要找到**首**、**末**两个落点。
 */
function rangeFor(runs: Run[], m: Match): Range | null {
  let start: { node: Text; offset: number } | null = null;
  let end: { node: Text; offset: number } | null = null;
  for (const run of runs) {
    if (run.to <= m.from && !(m.from === m.to && run.from === m.from)) continue;
    if (run.from >= m.to) break;
    const localFrom = Math.max(0, m.from - run.from);
    const localTo = Math.min(run.node.data.length, m.to - run.from);
    if (!start) start = { node: run.node, offset: localFrom };
    end = { node: run.node, offset: localTo };
  }
  if (!start || !end) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range;
}

function scrollToRange(scroller: HTMLElement | null, range: Range): void {
  if (!scroller) return;
  const rect = range.getBoundingClientRect();
  const host = scroller.getBoundingClientRect();
  if (rect.top < host.top || rect.bottom > host.bottom) {
    scroller.scrollTop += rect.top - host.top - host.height / 2;
  }
}
