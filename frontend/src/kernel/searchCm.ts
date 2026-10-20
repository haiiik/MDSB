import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { Match } from "./search";
import type { SearchAdapter } from "../state/search";

/**
 * 118：源码模式（CodeMirror 6）的查找适配器。
 *
 * **没有**用 `@codemirror/search` 的现成搜索：它自带一套匹配语义（尤其全词对中文的判定），
 * 而验收第一条要求「三种模式的计数与高亮项数始终一致」。
 * 判据只有 `kernel/search.ts` 那一份，这里负责把它给出的命中画成 CM 的 decoration。
 *
 * 一个方便之处：CodeMirror 的文档位置就是「整篇文本的字符偏移」（换行算一个 `\n`），
 * 所以命中区间可以原样喂给它，不需要像 PM 那样做位置映射。
 */

const setSearchMatches = StateEffect.define<{ matches: Match[]; current: number }>();

const searchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setSearchMatches)) continue;
      const { matches, current } = effect.value;
      const kids = matches
        .filter((m) => m.to > m.from)
        .map((m, i) =>
          Decoration.mark({
            class: i === current ? "hp-search hp-search--current" : "hp-search",
          }).range(m.from, m.to)
        );
      // 命中本来就是按位置从左到右生成的，省掉一次排序
      return Decoration.set(kids, false);
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 挂在 SourceView 的 extensions 里 */
export function searchHighlightExtension(): Extension {
  return searchField;
}

function replaceWith(view: EditorView, matches: Match[], replacement: string): number {
  const changes = [...matches]
    .reverse()
    .filter((m) => m.to > m.from)
    .map((m) => ({ from: m.from, to: m.to, insert: replacement }));
  if (!changes.length) return 0;
  // 一个事务改完 = CM history 里的一步（117 口径：替换全部是独立一步）
  view.dispatch({ changes, scrollIntoView: true });
  return changes.length;
}

export function makeCmAdapter(getView: () => EditorView | null): SearchAdapter {
  let last: Match[] = [];
  let lastCurrent = -1;

  return {
    text: () => getView()?.state.doc.toString() ?? "",
    canReplace: true,
    apply(matches, current, reveal) {
      last = matches;
      lastCurrent = current;
      const view = getView();
      if (!view) return;
      view.dispatch({ effects: setSearchMatches.of({ matches, current }) });
      // 选区 + 滚动留给「按 Enter / 点下一个」：打字途中抢选区会打断输入法组合（140）
      if (reveal && current >= 0 && matches[current]) {
        const m = matches[current];
        view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
      }
    },
    replaceOne(replacement) {
      const view = getView();
      const m = last[lastCurrent];
      if (!view || !m) return false;
      replaceWith(view, [m], replacement);
      return true;
    },
    replaceAll(replacement) {
      const view = getView();
      if (!view) return 0;
      return replaceWith(view, last, replacement);
    },
    focus: () => getView()?.focus(),
  };
}
