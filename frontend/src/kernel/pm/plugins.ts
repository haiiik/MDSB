import { liftListItem, splitListItem } from "prosemirror-schema-list";
import { goToNextCell } from "prosemirror-tables";
import { chainCommands } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Plugin, type EditorState, type Transaction } from "prosemirror-state";
import type { NodeType } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/**
 * 107：列表与任务清单的编辑行为。
 *
 * 1. **复选框可点**（US-37）：点一下只改 `list_item` 的 `checked` 属性。
 *    按 101 的粒度整个列表是一个块，所以落盘时整块会被重排 ——
 *    「只改三个字符」这条验收只对**扁平列表**成立，嵌套列表还会连带改缩进，
 *    这是既定代价，写在完成记录里而不是假装没有。
 * 2. **空列表项按回车退出列表**；非空时仍是普通的拆项。
 */

/** 找到包含该 DOM 元素的 list_item，返回它在文档里的起始位置 */
function listItemAt(view: EditorView, dom: HTMLElement): number | null {
  const $pos = view.state.doc.resolve(view.posAtDOM(dom, 0));
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === "list_item") return $pos.before(d);
  }
  return null;
}

export function taskListPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null;
          if (!target || target.tagName !== "INPUT") return false;
          const pos = listItemAt(view, target);
          if (pos === null) return false;
          const node = view.state.doc.nodeAt(pos);
          if (!node || node.type.name !== "list_item") return false;

          event.preventDefault();
          // null（普通列表项）与 false（未勾）都视为「勾上」，true 则取消
          const next = node.attrs.checked !== true;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: next }));
          return true;
        },
      },
      /**
       * 这里**不设 `stopEvent`**：那个属性在这个版本只挂在编辑器的 direct props 上
       * （`EditorView` 实例），不在 `Plugin.props` 的 `EditorProps` 类型里，
       * 写进来 `vue-tsc` 会报 TS2353。上面的 `mousedown` 已经 preventDefault
       * 并返回 true，点击不会被 PM 再解释成选区移动 —— 已由
       * `edit-list.spec.ts`「勾选不被弹回去」那条用例覆盖。
       */
    },
  });
}

/**
 * 光标在**空**列表项上按回车 → 抬出列表（`liftListItem`）；否则不处理。
 *
 * API 名字别凭记忆写：`prosemirror-schema-list@1.5.1` 导出的是
 * `addListNodes / wrapInList / sinkListItem / liftListItem / splitListItem / …`，
 * **没有 `exitList`**（那是别的封装库的名字）。写错会在 vite build 阶段
 * 以 `MISSING_EXPORT` 失败，vitest 单测反而测不到（单测不引本文件）。
 */
function emptyListItemExit(itemType: NodeType) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView): boolean => {
    if (!state.selection.empty) return false;
    const $from = state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "list_item") {
        if ($from.node(d).textContent.trim() !== "") return false;
        return liftListItem(itemType)(state, dispatch, view);
      }
    }
    return false;
  };
}

/**
 * 列表项里按回车 → 拆成**新的一项**（`splitListItem`），而不是 `splitBlock`。
 *
 * 这是 107 那个「写坏 Markdown」缺陷的真正根因。
 * `list_item` 的内容是 `paragraph+`（为了能吃下 Markdown 的 loose 列表），
 * 而 `baseKeymap` 的 `splitBlock` 拆的是**最内层块** —— 段落还能再加一个段落，
 * 于是回车在项内拆出第二个段落。实测拆完列表仍是 2 项，
 * 只是第一项里变成「指」「标口径已对齐」两段，列表整体转成 loose，
 * remark 便在项中间吐空行，写出 `-\n[ ] \n  正文…` 这种坏片段。
 *
 * 结论：**「能输入」不等于「能编辑」，而「拆块」也不等于「拆项」**。
 * 列表项的语义是「一项一条」，回车必须走 `splitListItem`。
 */
function splitListItemInPlace(itemType: NodeType) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView): boolean => {
    const $from = state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "list_item") {
        return splitListItem(itemType)(state, dispatch, view);
      }
    }
    return false;
  };
}

/**
 * 列表键位。
 *
 * 必须在 `baseKeymap` **之前**注册：PM 的 keymap 取第一个返回 true 的命令，
 * 放后面就永远轮不到（Enter 会先被 baseKeymap 的 splitBlock 吃掉）。
 *
 * 但**链尾不能再兜底 `splitBlock`** —— 110 抓到的正是这个回归：
 * 我的键位先命中 Enter，链尾的 splitBlock 对 code_block 会把节点**劈成两个围栏**，
 * 而 baseKeymap 里排在 splitBlock 之前的 `newlineInCode`（代码块内回车应插入换行）
 * 永远轮不到。非列表项时这里返回 false，把 Enter 让回 baseKeymap。
 */
export function listKeymap(itemType: NodeType) {
  return keymap({
    Enter: chainCommands(emptyListItemExit(itemType), splitListItemInPlace(itemType)),
  });
}

/**
 * 111：表格内的 Tab / Shift-Tab 在单元格间移动。
 *
 * `baseKeymap` 不含表格导航，必须由 `prosemirror-tables` 的 `goToNextCell` 提供；
 * 不在表格里时它返回 false，所以放在列表键位之后不会抢走别的 Tab。
 */
export function tableTabKeymap() {
  return keymap({
    Tab: goToNextCell(1),
    "Shift-Tab": goToNextCell(-1),
  });
}
