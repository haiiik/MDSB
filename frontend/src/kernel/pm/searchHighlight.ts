import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Match } from "../search";
import type { SearchAdapter } from "../../state/search";
import { HP_STEP_META } from "./history";

/**
 * 118：编辑模式（ProseMirror）的查找适配器。
 *
 * PM 文档不是字符串，所以这里做两件事：
 * 1. **文本映射**：把文档里的文字节点按顺序拼成一个字符串，并保留「字符偏移 ↔ PM 位置」
 *    的双向映射。查找判据在字符串上跑（与阅读 / 源码共用 `kernel/search.ts` 那一份语义），
 *    命中位置再翻译回 PM 位置画高亮、做替换。
 * 2. **高亮走 decorations，不进文档模型**：查找是临时视图状态，
 *    一旦进了模型就会被回写进 .md 文件 —— 那是灾难，不是 bug。
 */

const key = new PluginKey<DecorationSet>("hp-search");

type Run = { from: number; to: number; pos: number };

export type DocText = {
  text: string;
  /** 字符偏移 → PM 位置；落在两个文字节点之间时给前一个节点的末尾 */
  posAt: (offset: number) => number;
};

/**
 * 文档文字 + 偏移↔位置映射。
 *
 * **块与块之间补一个 `\n` 分隔符**，这不是为了好看：
 * 不补的话，上一块的最后一个文字节点与下一块的第一个文字节点在拼接串里是**连着**的，
 * 于是「偏移正好等于块边界」时无法判断属于哪一边 —— 实测的后果很硬：
 * 替换最后一段的开头几个字，位置被判给了前一个块（表格单元格），
 * 整段被并进表格里，文件当场写坏。
 * 补了分隔符之后，跨块命中必须包含 `\n`，而查找条是单行输入框，打不出 `\n` ——
 * 跨块命中在构造上就不可能出现，不需要额外的守卫代码。
 */
export function docTextOf(doc: PMNode): DocText {
  let text = "";
  const runs: Run[] = [];
  doc.forEach((block, blockStart) => {
    const base = blockStart + 1; // 进块一层才是内容起点
    block.descendants((node, inner) => {
      if (!node.isText || !node.text) return;
      const from = text.length;
      text += node.text;
      runs.push({ from, to: text.length, pos: base + inner });
    });
    text += "\n"; // 块分隔符（不属于任何 run，因此不可能成为命中的一部分）
  });

  const posAt = (offset: number): number => {
    // 1) 恰好是某个文字节点的起点 → 就用这个节点（块边界归后一块）
    for (const run of runs) if (offset === run.from) return run.pos;
    // 2) 落在节点内部
    for (const run of runs) if (offset > run.from && offset < run.to) return run.pos + (offset - run.from);
    // 3) 恰好是某个节点的末尾
    for (const run of runs) if (offset === run.to) return run.pos + (offset - run.from);
    // 4) 落在分隔符上（不该发生）：贴到最近的合法位置
    return offset <= 0 ? 1 : doc.nodeSize - 2;
  };
  return { text, posAt };
}

/** 高亮插件。文档一变就清空（宿主紧接着会重算补上），避免留下错位的高亮 */
export function searchHighlightPlugin(): Plugin {
  return new Plugin({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta("hpSearch") as { matches: Match[]; current: number; posAt: (o: number) => number } | null;
        if (meta) {
          return DecorationSet.create(
            tr.doc,
            meta.matches.map((m, i) =>
              Decoration.inline(meta.posAt(m.from), meta.posAt(m.to), {
                class: i === meta.current ? "hp-search hp-search--current" : "hp-search",
                "data-hp-current": i === meta.current ? "1" : undefined,
              })
            )
          );
        }
        return tr.docChanged ? DecorationSet.empty : set;
      },
    },
    props: { decorations: (state) => key.getState(state) ?? DecorationSet.empty },
  });
}

function paint(view: EditorView, matches: Match[], current: number, posAt: (o: number) => number, reveal: boolean): void {
  view.dispatch(view.state.tr.setMeta("hpSearch", { matches, current, posAt }));
  // 打字途中只画不高亮跳转：滚动与选区留给 Enter / ↑↓（见 SearchAdapter.apply 的注释）
  if (reveal && current >= 0) {
    view.dom.querySelector<HTMLElement>("[data-hp-current]")?.scrollIntoView({ block: "center" });
  }
}

/** 从后往前替换：位置不会因为前面已经改过而失效 */
function replaceMatches(view: EditorView, matches: Match[], replacement: string): number {
  const { posAt } = docTextOf(view.state.doc);
  let tr = view.state.tr;
  let n = 0;
  for (const m of [...matches].reverse()) {
    const from = posAt(m.from);
    const to = posAt(m.to);
    if (to <= from) continue;
    tr = tr.replaceWith(from, to, replacement ? view.state.schema.text(replacement) : []);
    n++;
  }
  if (!n) return 0;
  // 117 口径：一次「替换全部」是**一步撤销** —— 一个事务里做完，
  // 并显式标 hpStep，免得被当成打字合并进上一次输入。
  view.dispatch(tr.setMeta(HP_STEP_META, true).scrollIntoView());
  return n;
}

export function makePmAdapter(view: EditorView): SearchAdapter {
  // 命中列表由 `apply` 每次刷新，只在这里存一份；
  // 反过来从 decorations 里「抠」回来要把 PM 位置再翻译回偏移，多一次映射就多一份过期风险
  let last: Match[] = [];
  let lastCurrent = -1;

  return {
    text: () => docTextOf(view.state.doc).text,
    canReplace: true,
    apply(matches, current, reveal) {
      last = matches;
      lastCurrent = current;
      const { posAt } = docTextOf(view.state.doc);
      paint(view, matches, current, posAt, reveal);
      // 当前项同时是**选区**：继续打字、复制、撤销都以选区为准。
      // 但**只在 reveal 时落** —— 查找框每敲一个字就 dispatch 一次选区事务，
      // PM 会把 DOM 选区同步进正文，输入法组合当场被打断（140：中文打不出来、第二个字母没反应）
      if (reveal && current >= 0 && matches[current]) {
        const m = matches[current];
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, posAt(m.from), posAt(m.to)))
        );
      }
    },
    replaceOne(replacement) {
      const m = last[lastCurrent];
      if (!m) return false;
      replaceMatches(view, [m], replacement);
      return true;
    },
    replaceAll(replacement) {
      return replaceMatches(view, last, replacement);
    },
    focus: () => view.focus(),
  };
}
