import { liftListItem, splitListItem } from "prosemirror-schema-list";
import { goToNextCell, isInTable } from "prosemirror-tables";
import { chainCommands } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment, type Node as PMNode, type NodeType } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { cellBreak } from "./mdastToDoc";
import { INPUT_RULE_META } from "./inputRules";

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
 * `baseKeymap` 不含表格导航，必须由 `prosemirror-tables` 的 `goToNextCell` 提供。
 *
 * 142：这一条键位顺手收住了三个「Tab 之后字没了」的口子（链式，前一个返回 false 才轮到后一个）：
 * - 最后一格按 Tab → 出表格、落到下面那一行（`exitTableBelow`）；
 * - 代码块 / 公式块里按 Tab → 插入一个制表符当缩进（`baseKeymap` 没绑 Tab，
 *   原来浏览器默认行为是**把焦点移走**，接着打的字全落在页面背景上）；
 * - 正文里按 Tab → 什么都不做，但**也不许把焦点弄丢**。
 *   「Tab 在正文里到底是缩进还是制表符」没对齐（记 Q33），没对齐就别猜着上线，
 *   接住事件比猜一个语义、比丢焦点都稳。
 */
export function tabKeymap() {
  return keymap({
    Tab: chainCommands(goToNextCell(1), exitTableBelow, insertTabInCode, swallowTab),
    "Shift-Tab": chainCommands(goToNextCell(-1), swallowTab),
  });
}

/**
 * 142：表格**结尾出不去**这一类问题的总修。
 *
 * 原始诉求是「新建文件时从别的文件复制来表格，然后想另起一行写正文或标题，无法从下一行开始」。
 * 拆成三个各自独立、缺一都还坏的动作：
 *
 * 1. `ensureTrailingParagraph`：**编辑模式的文档永远以普通段落收尾**
 *    （最后一块不是段落、或者一个块都不剩，就补一个空段落）。
 *    表格、分割线这类块**没有文本位置**，光标根本进不去「它们之后」；代码块 / 公式 / 脚注定义
 *    有文本位置但进去就出不来（唯一的出口是 `baseKeymap` 里 `Mod-Enter` 的 exitCode，不知道）；
 *    标题 / 列表 / 引用块结尾则是「点下方空白，光标落进最后一块里」——
 *    实测在引用块下面点一下，打的字变成引用块的第二段。
 *    与其按「哪些块后面没法输入」列一张表（一定会漏），判据换成一句白话：
 *    **末尾那一行必须是能直接写正文的一行**。补了这一行，↓、Tab、点下方空白三个自然手势全通。
 *    补在**建 state 时**而不是只靠 appendTransaction：后者只在事务后跑，
 *    「打开一篇以表格结尾的文件、什么也没做、直接点表格下面」这条路上它一次都没执行过。
 * 2. `exitTableBelow`：Tab 到最后一格时落到表格下面那一行（`goToNextCell` 到最后一格返回 false，
 *    Word/Excel 在这里都是「出表格」而不是「原地不动」）。
 * 3. `cellEnterBreak`：格子里的回车不再拆第二个段落。
 */

/** 末尾那一行不是普通段落 = 「另起一行」没有落点；一个块都不剩时同理 */
export function needsTrailingParagraph(doc: PMNode): boolean {
  const last = doc.lastChild;
  return !last || last.type.name !== "paragraph";
}

/**
 * 需要时在文档末尾补一个空段落；不需要就原样返回同一个节点。
 *
 * **补的那一段不带源区间**（`srcFrom/srcTo` 为 null），于是它走的是 103 已经有的
 * 「新块」分支：不碰原文。真在里面打字时，这一行是 `sourceDoc` 里那个**旧的无源块**，
 * 回写走的是 `changedBlocks` 的「边界往外退到最近有源邻居」那条分支
 * （**不是**纯插入分支 —— 别看错，`patches.ts` 的 pushRegion 里两种形状都有用例）。
 * 调用点在 `EditView.buildState`：必须在 `sourceDoc = state.doc` 之前补，
 * 否则「打开一篇以表格结尾的文件」会被算成改动、把脏点白白点亮（104 的恒等判据）。
 */
export function ensureTrailingParagraph(doc: PMNode): PMNode {
  if (!needsTrailingParagraph(doc)) return doc;
  const paragraph = doc.type.schema.nodes.paragraph;
  if (!paragraph) return doc;
  // `Node` 上没有 `append`，`Fragment.append` 又只收 Fragment，`Node.copy` 只一个参数
  return doc.copy(doc.content.append(Fragment.from(paragraph.create())));
}

/**
 * 运行期守住文档形状的两条不变式（同一条事务里一起守）：
 * ① PM 自动填空掉出来的**空占位块**换成段落；
 * ② 末尾永远留一行可以直接打字的普通段落（粘完一张表、或把末尾那行删掉之后都会用到）。
 *
 * 删不掉末尾那个空段落 —— 与「文档永远有一行可以写字」是同一件事的两面，
 * PM 自己也不允许文档一个块都不剩。
 */
export function documentShapePlugin(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      /*
       * 只在**这一次真的改了文档**之后守形状。光标移动、以及
       * `dispatchTransaction` 为结构操作补的那笔空 `closeHistory` 事务都不算 ——
       * 补行本身就是一次 docChanged，会把下面要说的暂存清掉。
       */
      if (!transactions.some((tr) => tr.docChanged)) return null;
      /*
       * **输入规则刚触发的那一轮什么都不加**：`prosemirror-inputrules` 的暂存在任何
       * 带 docChanged 的事务之后都会被清空，而我们这笔补行就是这样一个事务 ——
       * 结果「打 `# ` 变标题 → 退格撤回」整条失效（实测撤回后连 `#` 都没了，
       * 退格变成了普通的合并上一块）。让开这一轮，形状等到下一次真改文档再守。
       * 记账见 `inputRules.ts` 里 `INPUT_RULE_META` 那段。
       */
      if (transactions.some((tr) => tr.getMeta(INPUT_RULE_META))) return null;
      const 修占位 = replaceEmptyPlaceholders(newState);
      if (修占位) return 修占位;
      if (!needsTrailingParagraph(newState.doc)) return null;
      const paragraph = newState.schema.nodes.paragraph;
      if (!paragraph) return null;
      return newState.tr.insert(newState.doc.content.size, paragraph.create());
    },
  });
}

/**
 * 142：把 PM **自动填空**掉出来的空占位块换成段落。
 *
 * 根因不在我们写的代码里，在 schema 的匹配表上：`createAndFill` / 删到空这类补位用的是
 * `ContentMatch.defaultType`，它取的是「这个位置第一个不是文本、又没有必填属性的类型」，
 * 而我们这张 schema 的 block 组排到第一的是 `opaque_block`
 * （实测 `doc.contentMatch.defaultType.name === "opaque_block"`）。
 * 症状很难看也很难查：**Ctrl+A + Backspace 之后文档变成一个「此内容编辑模式不修改」的块**，
 * 打不了字、也删不掉，只能关标签重开。
 *
 * 判据用「label 与 raw 都是空、又没有源区间」—— 真从 Markdown 解析出来的占位块
 * 一定带着原文和标签（见 `mdastToDoc` 的 default 分支），三项全空的只可能是自动填出来的壳。
 */
function replaceEmptyPlaceholders(state: EditorState): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return null;
  const 空壳位置: number[] = [];
  state.doc.descendants((node, pos) => {
    if (
      node.type.name === "opaque_block" &&
      !String(node.attrs.label ?? "") &&
      !String(node.attrs.raw ?? "") &&
      node.attrs.srcFrom == null
    ) {
      空壳位置.push(pos);
    }
    return true;
  });
  if (!空壳位置.length) return null;
  const tr = state.tr;
  // 从后往前换，前面的位置才不会因为替换而漂移（占位块是叶子，尺寸恒为 1）
  for (const pos of 空壳位置.reverse()) tr.replaceRangeWith(pos, pos + 1, paragraph.create());
  return tr;
}

/** 从光标往上找表格 / 单元格所在深度；`tableRole` 是 prosemirror-tables 打在 spec 上的标记 */
function tableDepths($pos: { depth: number; node(d: number): PMNode }): {
  cell: number | null;
  table: number | null;
} {
  let cell: number | null = null;
  let table: number | null = null;
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") cell ??= d;
    else if (role === "table") table ??= d;
  }
  return { cell, table };
}

/**
 * Tab 在最后一格 → 把光标放到表格**下面那一行**。
 *
 * 判「是不是最后一格」用的是 `goToNextCell(1)(state)`：命令不传 `dispatch` 时
 * 只回答「能不能走到下一格」而不改动任何东西（源码里 `if (dispatch)` 包着事务），
 * 比自己算行列稳。
 */
export const exitTableBelow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state)) return false;
  const { table } = tableDepths(state.selection.$from);
  if (table === null) return false;
  const after = state.selection.$from.after(table);
  const paragraph = state.schema.nodes.paragraph;
  const $after = state.doc.resolve(after);

  // 表格下面已经有块（多数情况就是 `ensureTrailingParagraph` 补的那一行）：直接落过去
  if ($after.nodeAfter) {
    const sel = TextSelection.near($after);
    if (!sel) return false;
    if (dispatch) dispatch(state.tr.setSelection(sel).scrollIntoView());
    return true;
  }
  if (!paragraph) return false;
  if (dispatch) {
    // 表格是文档最后一块时（`nodeAfter` 为空才会走到这里），`after` 就是 `doc.content.size`，
    // 插进去的段落正好占 `[after, after+1]`，所以落点是 `after + 1`。
    // 这里不能用 `tr.mapping.map(after)`：`map` 默认 assocAfter，插入点上的位置会被推到新内容**之后**。
    const tr = state.tr.insert(after, paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
  }
  return true;
};

/**
 * 142：代码块 / 块级公式里按 Tab = 插入一个制表符（缩进）。
 *
 * 只认这两种「内容逐字保留」的块。`footnote_def` 也是 code:true，但它的续行缩进存在属性上、
 * 由 `joinFootnoteDef` 拼回，正文里再塞制表符会让缩进变成两处一起动，所以不放进来。
 *
 * **选区非空时一律不处理**：`tr.insertText("\t")` 不传区间走的是 `replaceSelection`，
 * 那会**把选中的那段字换成一个制表符** —— 从别处整段复制代码粘进来、顺手按个 Tab
 * 就静默吃掉选区，比"Tab 没反应"严重得多。让开之后链尾的 `swallowTab` 接住事件，
 * 焦点不丢、内容也不丢。
 */
const insertTabInCode: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const 类型 = state.selection.$from.parent.type.name;
  if (类型 !== "code_block" && 类型 !== "math_block") return false;
  if (state.selection.$from.parent.type.spec.code !== true) return false;
  if (dispatch) dispatch(state.tr.insertText("\t").scrollIntoView());
  return true;
};

/**
 * 142：正文里的 Tab **先接住，什么都不做**。
 *
 * 不接住的后果不是「Tab 没反应」，而是**焦点跑到工具栏/底栏上**（实测空档按 Tab，
 * `activeElement` 变成底栏那颗 `statusbar__mode` 按钮），接着打的字全落在页面背景上 ——
 * 静默丢输入，比一条没绑定的键严重得多。
 * Tab 在正文里的真语义（缩进？制表符？列表降格？）没对齐，记 **Q33** 等作者定，不猜着上线。
 */
const swallowTab: Command = () => true;

/**
 * 格子里按回车 → 插入单元格换行的既定表示（行内 `<br>`），**不拆第二个段落**。
 *
 * 拆段落不是「多一行」而是**丢字**：GFM 的单元格只有行内内容，`docToMdast` 把一个格子里
 * 的多个段落逐个摊平进行内序列，实测「甲」「乙」两段落盘成 `| 甲乙 |` —— 换行没了。
 * `cellBreak` 是 115 就定下的同一套表示（口径 Q2：单元格里的换行就是行内 HTML `<br>`），
 * 文件里本来就写着 `<br>` 的那条路读的也是它，往返性质已有用例守着。
 */
export const cellEnterBreak: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { cell } = tableDepths(state.selection.$from);
  if (cell === null) return false;
  /*
   * **选区不是一个插入符时接住回车、什么都不做**（review 抓的：原来只认 `$cursor`，
   * 非光标就返回 false 落回 `baseKeymap` 的 `splitBlock` —— 正是这条注释宣称消灭的拆段落，
   * 拖选一片格子、格子里选中一张图片、甚至只是用鼠标划选了一格里的几个字，都会走到那）。
   * 这里不猜意图：拆段落丢字，给选区每一格插一个换行也是猜。
   */
  const $cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
  if (!$cursor) return true;
  const br = cellBreak(state.schema);
  if (!br) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(br).scrollIntoView());
  return true;
};

/**
 * 142：表格内的回车。放在 `listKeymap` 之后、`baseKeymap` 之前，
 * 非表格时返回 false，Enter 照常落到 baseKeymap 的 `splitBlock`。
 */
export function tableEnterKeymap() {
  return keymap({ Enter: cellEnterBreak });
}

/** 找某个 label 的脚注定义块在文档里的位置；找不到返回 null */
function footnoteDefPos(state: EditorState, label: string): number | null {
  let found: number | null = null;
  state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === "footnote_def" && String(node.attrs.label) === label) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * 136-B：编辑模式里**点脚注引用 → 滚到对应定义并把光标放进去**。
 *
 * 已定的口径是「点引用跳到定义改文字」。为什么落点是"光标进正文"而不是只滚动：
 * 只滚过去还得再点一次才能改，那这一步就没省掉任何动作。
 *
 * 找不到定义时**不吞这次点击**（返回 false）—— 引用悬空是文档里本来写的状态，
 * 点了没反应比弹一句"没有这条定义"更不扰人，也不会把点击顺带变成选区清空。
 */
export function footnoteJumpPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click: (view, ev) => {
          const el = (ev.target as HTMLElement | null)?.closest?.("[data-hp-fnref]") as HTMLElement | null;
          if (!el) return false;
          const label = el.getAttribute("data-hp-fnref") ?? "";
          if (!label) return false;
          const pos = footnoteDefPos(view.state, label);
          if (pos == null) return false;
          ev.preventDefault();
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)).scrollIntoView()
          );
          view.focus();
          // 闪一下当作落点反馈（和阅读模式同一套 class / 同一时长）
          const dom = view.nodeDOM(pos) as HTMLElement | null;
          dom?.classList.add("is-fn-target");
          window.setTimeout(() => dom?.classList.remove("is-fn-target"), 1200);
          return true;
        },
      },
    },
  });
}
