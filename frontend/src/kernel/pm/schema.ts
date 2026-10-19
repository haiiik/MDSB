import {
  Schema,
  type DOMOutputSpec,
  type Mark,
  type Node as PMNode,
  type NodeSpec,
} from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";

/**
 * 102：MDStar（项目内部名 mdsb，早期叫 HorseParty）所见即所得的正式 schema（从 025 的 spike 组合方式升级而来）。
 *
 * 组合顺序有坑，别改：
 * - 必须用 `basicSchema.spec.nodes`（NodeSpec 的**有序表**）再 `append`，
 *   不能展开 `basicSchema.nodes` —— 那是已实例化的 NodeType，
 *   交给 Schema 构造函数会得到一个「什么都解析不出来」的空文档
 *   （`doc.size = 0`、`posAtCoords` 一律 null，025 第一版就踩了，见 `src/spike/zoom.ts`）。
 * - `prosemirror-schema-basic` **不含列表**，列表要 `addListNodes` 显式加。
 * - 反过来，`horizontal_rule` 与 `image` basic 里**已经有了**，
 *   重复声明会造成两套同名节点。
 *
 * 任务清单：`prosemirror-schema-list` 的 `list_item` 没有 `checked` 属性（已核
 * `node_modules/prosemirror-schema-list/dist/index.cjs`），所以这里覆盖它的 spec。
 */

/** v1 编辑模式无法表示的块：渲染成不可编辑的占位原子，源区间由 103 负责保留 */
const opaqueBlock = {
  group: "block",
  atom: true,
  attrs: {
    label: { default: "" },
    /** 103：原文逐字节存在这里，用户编辑别处时靠它原样拷回（不透明保留的落点） */
    raw: { default: "" },
    srcFrom: { default: null },
    srcTo: { default: null },
  },
  parseDOM: [{ tag: "div[data-hp-opaque]" }],
  toDOM: (node: PMNode): DOMOutputSpec => [
    "div",
    { "data-hp-opaque": "1", "data-testid": "opaque-block", class: "hp-opaque" },
    String(node.attrs.label || "（此内容编辑模式不修改）"),
  ],
};

/** 同样理由的行内占位（脚注引用等） */
const opaqueInline = {
  inline: true,
  group: "inline",
  atom: true,
  selectable: false,
  attrs: { label: { default: "" }, raw: { default: "" } },
  parseDOM: [{ tag: "span[data-hp-opaque]" }],
  toDOM: (node: PMNode): DOMOutputSpec => [
    "span",
    { "data-hp-opaque": "1", class: "hp-opaque-inline" },
    String(node.attrs.label || "[?]"),
  ],
};

/**
 * 136-B：脚注定义块 —— **可编辑**，但只编辑正文。
 *
 * 为什么不是"整块原文塞一个 textarea"：那样她就得自己维护 `[^label]:` 与续行缩进，
 * 一个手滑就把语法弄坏；也不是"像段落一样富文本"：定义里的 `**粗体**` 要不要再拆一层
 * 行内节点，拆了就要处理"她把标记删一半"，代价远超这一颗的价值。
 *
 * 所以：**标记与缩进存在属性上、正文是纯文本内容**，回写时走 `joinFootnoteDef` 拼回原文
 * （往返性质由 `footnote-block.spec.ts` 钉住）。她看到能改的就是正文，
 * 语法骨架由我们维持 —— 与 109 代码块「就地改内容、围栏由我们补」同一条路子。
 */
const footnoteDef = {
  group: "block",
  content: "text*",
  /**
   * **`code: true` 不是"这是代码"，而是 PM 的「这个节点的内容保留空白」开关。**
   * 不加它：Schema 默认 `whitespace: "normal"`，她一打字 PM 就从 DOM 回读一次，
   * 续行那个 `\n` 当场被折叠成空格 —— 实测存出来的文件是
   * `[^a]: 改过：第一个定义 两格缩进的续行`（换行没了）。
   * CSS 的 `white-space: pre-wrap` 只管**显示**，管不了 PM 的 DOM↔doc 往返，两者都要。
   */
  code: true,
  attrs: {
    label: { default: "" },
    /** 冒号后的空白，原样保留；拼回时保证非空（见 joinFootnoteDef） */
    gap: { default: " " },
    /** 续行缩进，原样保留 */
    indent: { default: "  " },
    srcFrom: { default: null },
    srcTo: { default: null },
  },
  parseDOM: [{ tag: "div[data-hp-fndef]" }],
  /**
   * **标记 `[^label]:` 不放进 DOM**，交给 CSS `::before` + `attr()` 画。
   *
   * 一开始是手写一个 `<span class="hp-fndef__mark">[^a]:</span>` 再把内容洞放在第二个 span 里，
   * 实测直接把编辑弄坏：点引用后打字，`改过：` 落进了**标记那个 span**（`[^a]:改过：`），
   * 而正文里的换行被抹平成空格。根因是 PM 的 `domAtPos` 按 DOM 结构反推位置，
   * 一个"装饰 span + 内容 span"的组合它并不认得 —— 要用 NodeView 才管得住。
   * 伪元素没有 DOM 节点、不可能被选中、也不可能吃到输入，是这里最小且正确的解。
   */
  toDOM: (node: PMNode): DOMOutputSpec => [
    "div",
    {
      "data-hp-fndef": String(node.attrs.label ?? ""),
      class: "hp-fndef",
      "data-testid": "pm-footnote-def",
    },
    0,
  ],
};

/**
 * 138-B：块级公式 `$$…$$`。
 *
 * 与 136-B 的脚注定义同一套路：**定界符与两侧空白是语法骨架，存属性、不进 DOM**；
 * 她能改的只有正文。骨架由 `mathBlock.ts` 的 `splitMathBlock/joinMathBlock` 保证拼回去一字不差。
 *
 * 同样**不能把 `$$` 写进 `toDOM`**（136-B 实测：装饰文字进 DOM 会被 PM 的 `domAtPos`
 * 认成内容区，打字会落进标记里）。块级的预览由 NodeView（`nodeViews.ts` 的 `mathBlockNodeView`）
 * 补在上面那一条里 —— 那个盒子不是内容，`ignoreMutation` / `stopEvent` 要一并接住。
 */
const mathBlock = {
  group: "block",
  content: "text*",
  marks: "",
  /** 同 136-B 的教训：`code: true` 是「本节点保留空白」，不是"这是代码"。
   *  少了它，她一打字 PM 从 DOM 回读，`\n` 与 `\ ` 当场折掉。 */
  code: true,
  atom: false,
  attrs: {
    /** 缩进 + 开定界符 + 它后面的空白 */
    before: { default: "$$\n" },
    /** 定界符前的空白 + 闭定界符 + 行尾空白 */
    after: { default: "\n$$" },
  },
  parseDOM: [{ tag: "div[data-hp-mathblock]" }],
  toDOM: (node: PMNode): DOMOutputSpec => [
    "div",
    {
      "data-hp-mathblock": "1",
      class: "hp-mathblock",
      "data-testid": "pm-math-block",
    },
    ["pre", ["code", 0]],
  ],
};

/**
 * 138-B：行内公式 `$…$`。
 *
 * **不是原子**（与 footnote_ref 不同）：可编辑的正文在内容里，定界符交给 CSS 伪元素
 * 按 `data-hp-math-left/right` 画 —— 行内原子点进去改字要再造一套编辑态，
 * 而她要的本来就是"看得见、改得动"。Q29（行内显示源码还是排版结果）按源码做，理由见工单。
 */
const mathInline = {
  /**
   * **`inline: true` 不是装饰**：prosemirror-model 判一个节点是行内还是块，
   * 看的是这个标记（源码里 `this.isBlock = !(spec.inline || name == "text")`），
   * `group: "inline"` 只是"归到哪个组"。少了 `inline: true`，Schema 构造时就会抛
   * `Mixing inline and block content (in content expression 'inline*')` ——
   * 整份 schema 建不起来，症状离根因很远。
   */
  inline: true,
  group: "inline",
  content: "text*",
  code: true,
  marks: "",
  attrs: {
    before: { default: "$" },
    after: { default: "$" },
  },
  parseDOM: [{ tag: "span[data-hp-mathinline]" }],
  toDOM: (node: PMNode): DOMOutputSpec => [
    "span",
    {
      "data-hp-mathinline": "1",
      "data-hp-math-left": String(node.attrs.before ?? "$"),
      "data-hp-math-right": String(node.attrs.after ?? "$"),
      class: "hp-mathinline",
      "data-testid": "pm-math-inline",
    },
    0,
  ],
};

/**
 * 136-B：脚注引用 `[^label]`。行内原子（和 opaque_inline 一样的形态），
 * 但带 label 且**可点** —— 点了滚到对应定义并闪一下（见 footnoteJump 插件）。
 */
const footnoteRef = {
  inline: true,
  group: "inline",
  atom: true,
  selectable: false,
  attrs: { label: { default: "" }, raw: { default: "" } },
  parseDOM: [{ tag: "span[data-hp-fnref]" }],
  toDOM: (node: PMNode): DOMOutputSpec => [
    "span",
    {
      "data-hp-fnref": String(node.attrs.label || ""),
      class: "hp-fnref",
      "data-testid": "pm-footnote-ref",
      title: String(node.attrs.label || ""),
    },
    String(node.attrs.raw || `[^${String(node.attrs.label)}]`),
  ],
};

/**
 * 103：只有**顶层块**需要携带源区间（D23 的「块」= mdast 根节点的直接子节点）。
 * 嵌套的 list_item / table_cell 不需要，给它们加属性只会让 `node.eq` 变复杂。
 */
const TOP_LEVEL_BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "code_block",
  "horizontal_rule",
  "bullet_list",
  "ordered_list",
  "table",
  // 136-B：脚注定义是顶层块，也要带源区间 —— 回写按块拼接时靠它定位
  "footnote_def",
  // 138-B：块级公式同样是顶层块
  "math_block",
]);

/** 给一组 NodeSpec 统一加上 srcFrom / srcTo 属性 */
function withSrcRange(spec: NodeSpec, extra: Record<string, unknown> = {}): NodeSpec {
  return {
    ...spec,
    attrs: { ...(spec.attrs ?? {}), srcFrom: { default: null }, srcTo: { default: null }, ...extra },
  };
}

const baseNodes = addListNodes(
  basicSchema.spec.nodes.append(
    tableNodes({
      tableGroup: "block",
      cellContent: "paragraph+",
      cellAttributes: { background: { default: null } },
    })
  ),
  "paragraph+",
  "block"
).append({
  // 覆盖 schema-list 的 list_item，补上任务清单需要的 checked。
  // 内容必须是 `block+` 而不是 `paragraph+`：Markdown 的嵌套列表要求 list_item 里
  // 能直接放子列表，用 paragraph+ 会让整棵树**非法**（`doc.check()` 抛
  // "Invalid content for node list_item"）。因为 `node.create()` 不校验子内容，
  // 这个非法结构可以安静活很久，直到某次 setNodeMarkup 才炸 ——
  // 109 的语言下拉、107 的嵌套任务清单勾选都是这个坑。
  // 守门用例：tests/unit/pm-doc-validity.spec.ts。
  list_item: {
    content: "block+",
    defining: true,
    attrs: { checked: { default: null } },
    parseDOM: [{ tag: "li", getAttrs: () => ({ checked: null }) }],
    toDOM: (node: PMNode): DOMOutputSpec =>
      node.attrs.checked === null
        ? ["li", 0]
        : [
            "li",
            { "data-hp-task": "1" },
            ["input", { type: "checkbox", checked: node.attrs.checked ? "checked" : null }],
            ["div", 0],
          ],
  },
  // 围栏信息串要能带回来（109 的语言下拉、110 的 Mermaid 判定都依赖它）
  code_block: {
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    marks: "",
    attrs: { language: { default: null } },
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: (node: PMNode): DOMOutputSpec => [
      "pre",
      { "data-language": String(node.attrs.language ?? ""), "data-testid": "pm-code-block" },
      ["code", 0],
    ],
  },
  opaque_block: opaqueBlock,
  opaque_inline: opaqueInline,
  footnote_def: footnoteDef,
  footnote_ref: footnoteRef,
  math_block: mathBlock,
  math_inline: mathInline,
});

/** 103：把源区间属性统一挂到顶层块类型上，避免逐个手写 spec 时漏掉某个类型 */
const ranged: Record<string, NodeSpec> = {};
baseNodes.forEach((name, spec) => {
  if (!TOP_LEVEL_BLOCKS.has(name)) return;
  // 表格额外带 align：`:---:` / `---:` / `:-:` 的对齐信息在 mdast 的 table.align 上，
  // prosemirror-tables 的 cell 属性里没有对应位置，不在这里接住就会**真的丢**
  // （一个表格是一个块，改任一格子都会整块重排）。
  const extra = name === "table" ? { align: { default: null } } : {};
  ranged[name] = withSrcRange(spec, extra);
});

export const hpSchema = new Schema({
  nodes: baseNodes.append(ranged),
  marks: basicSchema.spec.marks.append({
    strikeThrough: {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
      toDOM: () => ["s", 0],
    },
  }),
});

/** 103：判断两个节点是否「内容相同」时要忽略源区间（区间是元数据，不是内容） */
export const SRC_ATTRS = ["srcFrom", "srcTo"] as const;

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((SRC_ATTRS as readonly string[]).includes(k)) continue;
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  const key = (ms: readonly Mark[]) =>
    ms.map((m) => m.type.name + JSON.stringify(m.attrs ?? {})).sort().join("|");
  return key(a) === key(b);
}

/**
 * 内容等价比较。
 *
 * 注意：`PMNode.eq()` 在这个版本只接受一个参数（`node_modules/prosemirror-model` 的
 * 类型签名如此），没法传「忽略某些属性」的比较器。而源区间属性必须被忽略 ——
 * 用户改过一个块之后它的 `srcFrom/srcTo` 还在，用 `eq` 会判成「不同」，
 * 反过来粘贴进来的新块又可能误判。所以这里自己递归比。
 */
export function contentEq(a: PMNode, b: PMNode): boolean {
  if (a === b) return true;
  if (a.type.name !== b.type.name) return false;
  if (!attrsEqual(a.attrs, b.attrs)) return false;
  if (!marksEqual(a.marks, b.marks)) return false;
  if (a.isText) return a.text === b.text;
  if (a.childCount !== b.childCount) return false;
  if (a.textContent !== b.textContent) return false; // 便宜的预筛
  for (let i = 0; i < a.childCount; i++) {
    if (!contentEq(a.child(i), b.child(i))) return false;
  }
  return true;
}

export type HpNode = PMNode;
