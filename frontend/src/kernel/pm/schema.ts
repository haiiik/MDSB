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
