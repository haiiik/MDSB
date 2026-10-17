import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { Fragment } from "prosemirror-model";
import type { Plugin } from "prosemirror-state";
import { hpSchema } from "./schema";

/**
 * 113：Markdown 输入规则（US-38 的前半 —— 打字就变块类型）。
 *
 * 用官方的 `prosemirror-inputrules` 插件本体，规则**自己写**。
 * 不引 `prosemirror-markdown`：它把 md 解析与序列化一起绑死，而我们的保真路线（D23）
 * 恰恰是「不整篇序列化」。
 *
 * 三条来自插件本身的性质，别在规则里重复实现（`prosemirror-inputrules/dist/index.cjs:68`）：
 * - `view.composing` 期间不跑规则 —— 中文输入法组合态里打 `#` 不会误转块；
 * - 光标在 **code 节点**（我们的 `code_block`，含 Mermaid 块）里时，除非规则显式
 *   声明 `inCode`，一律不触发 —— 这就是「围栏里输入 `# ` 不变标题」的落点；
 * - 光标落在**行内代码**这段文字里时同样不触发（`inCodeMark` 默认关）。
 */

const n = hpSchema.nodes;

/**
 * 给规则打开「行内代码里不触发」这道闸。
 *
 * 插件的默认值是 `inCodeMark: true`（`index.cjs:19` 的 `!== false`），
 * 含义是**不检查**行内代码 —— 于是在 `` `#` `` 这种行内代码里打空格，
 * 整段会被规则变成标题，代码段跟着没了。对编辑器这是净伤害，逐条关掉。
 * （`inCode` 默认 false，即 code 节点里本来就不触发，那条正是 113 要的「围栏里不触发」。）
 */
function guarded<T extends InputRule>(rule: T): T {
  rule.inCodeMark = false;
  return rule;
}

/** 标题：`# ` 到 `###### `，井号个数即层级 */
const heading = guarded(textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (m) => ({ level: m[1].length })));

/** 无序列表：`- ` / `* ` / `+ `（三种 Markdown 都算合法标记） */
const bullet = guarded(wrappingInputRule(/^[-*+]\s$/, n.bullet_list));

/** 有序列表：`1. ` / `3. ` —— 起始序号照用户打的走，所以要把 attrs.order 传进去 */
const ordered = guarded(
  wrappingInputRule(
    /^(\d+)\.\s$/,
    n.ordered_list,
    (m) => ({ order: +m[1] }),
    // 已经在有序列表里接着打「下一项的序号」时，不该再套一层新列表
    (m, node) => node.childCount + node.attrs.order === +m[1]
  )
);

/** 引用：`> ` */
const quote = guarded(wrappingInputRule(/^>\s$/, n.blockquote));

/**
 * 代码围栏：```（第三个反引号一落下就转块）。
 *
 * 语言**不在这里给**：规则只能在「输入一个字符」时触发，而第三个反引号落下时
 * 后面还没有语言名 —— 等用户接着打 `js`，那两个字符会进围栏正文而不是属性。
 * 所以围栏的 `language` 走 109 的语言下拉，这里只保证「``` 变代码块」。
 * （`(\w*)` 那组留着：万一以后改成「空格触发」就能直接吃到语言。）
 */
const fence = guarded(
  new InputRule(/^```(\w*)$/, (state, m, start, end) => {
    const tr = state.tr.delete(start, end);
    const pos = tr.mapping.map(start);
    // 插件层面已经不会在 code 节点里跑规则，这里是双保险
    if (tr.doc.resolve(pos).parent.type.spec.code) return null;
    return tr.setBlockType(pos, pos, n.code_block, { language: m[1] || null });
  })
);

/**
 * 任务项：`[ ] ` / `[] ` / `[x] `。
 *
 * 107 的口径：任务项就是 `checked` 属性不为 null 的 `list_item`，
 * 所以这里只负责「把 checked 弄上」，序列化那条路一行都不改。
 * 已经在列表项里 → 只改本项 checked；在普通段落里 → 整块变成一个任务项。
 */
function taskItem(checked: boolean): InputRule {
  return guarded(new InputRule(checked ? /^\[[xX]\]\s$/ : /^\[\s?\]\s$/, (state, _m, start, end) => {
    const $start = state.doc.resolve(start);
    const tr = state.tr.delete(start, end);

    // 情况 A：光标所在段落在某个 list_item 里 —— 只给那一项打勾
    let itemDepth = -1;
    for (let d = $start.depth; d > 0; d--) {
      if ($start.node(d).type === n.list_item) {
        itemDepth = d;
        break;
      }
    }
    if (itemDepth > 0) {
      const pos = tr.mapping.map($start.before(itemDepth));
      const item = tr.doc.nodeAt(pos);
      if (!item) return null;
      return tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked });
    }

    // 情况 B：普通段落 → 包成 bullet_list > list_item(checked) > paragraph
    // 标题 / 引用 / 代码里不打钩：这些块类型不是 Markdown 任务项的合法宿主
    if ($start.parent.type !== n.paragraph) return null;
    const paraPos = tr.mapping.map($start.before());
    const para = tr.doc.nodeAt(paraPos);
    if (!para || para.type !== n.paragraph) return null;
    const item = n.list_item.create({ checked }, Fragment.from(para));
    const list = n.bullet_list.create(null, Fragment.from(item));
    return tr.replaceWith(paraPos, paraPos + para.nodeSize, list);
  }));
}

/** 规则集合导出给单测：断言「哪些前缀会触发、触发成什么」不必起浏览器 */
export const HP_INPUT_RULES: InputRule[] = [
  heading,
  bullet,
  ordered,
  quote,
  fence,
  taskItem(false),
  taskItem(true),
];

export function hpInputRules(): Plugin {
  return inputRules({ rules: HP_INPUT_RULES });
}
