import { Node as PMNode, type Mark, type Schema } from "prosemirror-model";
import { t, tf } from "../../i18n";
import { parseMd } from "../md";
import { splitFootnoteDef } from "./footnoteBlock";
import { splitInlineMath, splitMathBlock } from "./mathBlock";
import { hpSchema } from "./schema";

/**
 * 102：mdast → ProseMirror 文档。
 * 103：顶层块携带源区间 `srcFrom` / `srcTo`；无法表示的节点把**原文逐字节**存进 `raw`。
 *
 * 原则只有一条：**不许静默丢内容**。
 * 能表示的映射成对应节点；不能表示的一律落成占位原子（块级 `opaque_block` /
 * 行内 `opaque_inline`），带上可读标签 + 原文。占位节点在编辑模式不可改，
 * 用户编辑别处时由 101 按源区间逐字节拷回；即使它落在被改动的区间内，
 * `raw` 也足以把它原样写回去。
 *
 * `[TOC]` 不需要特殊处理：remark 把它解析成普通段落，M1 022 是**渲染期**增强的，
 * 所以它在 mdast 里本来就是 paragraph，天然保真。
 */

/**
 * mdast 的节点联合类型很宽，逐分支窄化会让这份文件一半篇幅在写类型守卫。
 * 这里统一按「type + 索引签名」处理，取值时显式断言 —— 结构正确性由
 * `tests/unit/mdast-to-doc.spec.ts` 与 `tests/unit/pm-patches.spec.ts` 的夹具断言保证。
 */
type Src = { start?: { offset?: number }; end?: { offset?: number } };
type AnyNode = { type: string; position?: Src; [key: string]: unknown };

const asList = (v: unknown): AnyNode[] => (Array.isArray(v) ? (v as AnyNode[]) : []);
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** 该节点在原文里的字节区间（拿不到就返回 null，表示「新内容，无源」） */
function rangeOf(node: AnyNode): { from: number; to: number } | null {
  const from = node.position?.start?.offset;
  const to = node.position?.end?.offset;
  return typeof from === "number" && typeof to === "number" ? { from, to } : null;
}

/**
 * 占位原子的原文。
 *
 * 有源区间 → 从原文逐字节切；**没有源区间**（粘贴来的块，114 把 position 抹掉了）
 * → 退回节点自带的 `value`。少了这半边 fallback 是会**静默丢内容**的：
 * Word 单元格里的多段落被 `htmlToMdast` 表达成行内 HTML `<br>`，
 * 粘贴路径上 `raw` 取成空串，落盘就变成「第一行第二行」挤成一格
 * （文件路径同样的内容却有 `<br>`，两条路不一致 —— 桌面实测跑出来的）。
 */
function rawOf(source: string, node: AnyNode): string {
  const r = rangeOf(node);
  if (r) return source.slice(r.from, r.to);
  // 源区间拿不到时的兜底。**math 绝不能兜成 `node.value`** ——
  // 那是不带定界符的 LaTeX 正文，写回去就把 `$…$` / `$$…$$` 弄丢了，
  // 而这个节点接下来会被 remark 当普通文字（甚至当斜体）解析。
  // 其它类型的 value 就是原文本身，照旧。
  if (node.type === "math") return "$$\n" + String(node.value ?? "") + "\n$$";
  if (node.type === "inlineMath") return "$" + String(node.value ?? "") + "$";
  return typeof node.value === "string" ? node.value : "";
}

/** 编辑模式无法表示的块，给用户的说明文案 */
function opaqueLabelFor(node: AnyNode): string {
  switch (node.type) {
    case "yaml":
      return t("opaque.yaml");
    case "html":
      return t("opaque.html");
    case "footnoteDefinition":
      return tf("opaque.footnoteDef", { label: String(node.label ?? node.identifier ?? "?") });
    /**
     * 138-A：公式此刻在编辑模式还是占位（138-B 才做成「预览 + 就地改源码」）。
     * 占位里**必须带上她的原文**：只写「暂不支持的内容（math）」等于让编辑模式
     * 比做这个功能之前更难读 —— 以前 `$…$` 就是普通文字，看得见也改得动。
     * 这条是桌面实测第 17 段第一条抓出来的（E2E 当时没覆盖编辑模式的公式夹具）。
     */
    case "math":
      return tf("math.opaqueBlock", { src: "$$" + String(node.value ?? "") + "$$" });
    default:
      return tf("opaque.unsupported", { type: node.type });
  }
}

function textNodes(schema: Schema, text: string, marks: readonly Mark[]): PMNode[] {
  if (!text) return [];
  // PM 会合并同 mark 的相邻文本节点，因此不能假设「一个 mdast text = 一个 PM text」
  return [schema.text(text, marks)];
}

function convertInline(node: AnyNode, schema: Schema, marks: readonly Mark[], source: string): PMNode[] {
  const markOf = (name: string, attrs?: Record<string, unknown>) => schema.mark(name, attrs ?? {});

  switch (node.type) {
    case "text":
      return textNodes(schema, asStr(node.value) ?? "", marks);

    case "inlineCode":
      return textNodes(schema, asStr(node.value) ?? "", [...marks, markOf("code")]);

    case "strong":
      return asList(node.children).flatMap((c) => convertInline(c, schema, [...marks, markOf("strong")], source));

    case "emphasis":
      return asList(node.children).flatMap((c) => convertInline(c, schema, [...marks, markOf("em")], source));

    case "delete":
      return asList(node.children).flatMap((c) => convertInline(c, schema, [...marks, markOf("strikeThrough")], source));

    case "link":
      return asList(node.children).flatMap((c) =>
        convertInline(
          c,
          schema,
          [...marks, markOf("link", { href: asStr(node.url) ?? "", title: asStr(node.title) })],
          source
        )
      );

    case "image":
      return [
        schema.nodes.image.create(
          { src: asStr(node.url) ?? "", alt: asStr(node.alt) ?? "", title: asStr(node.title) },
          undefined
        ),
      ];

    case "break":
      return [schema.nodes.hard_break.create()];

    /**
     * 136-B：引用还是"原文说了算" —— raw 在就按 raw 落地（她没法在编辑模式改引用文字，
     * 改了 label 也只会让引用和定义接不上），拿不到 raw 才按 label 现拼一个。
     */
    case "footnoteReference": {
      // 136-B：不再是"看得到动不了的占位"，而是带 label、可点跳转的行内原子。
      // raw 仍然留着 —— 回写时按原文落地，label 只用于跳转与识别。
      const label = String(node.label ?? node.identifier ?? "");
      return [schema.nodes.footnote_ref.create({ label, raw: rawOf(source, node) })];
    }

    /**
     * 138-B：行内公式 `$…$` 从占位升级成**可就地编辑**的节点。
     * 定界符不进 DOM（伪元素画），拆出来的 `before/after` 存属性，回写时由
     * `joinInlineMath` 拼回原串 —— 她能改的只有正文。
     * 拆不开的形状（手写得很怪、或粘贴来根本没有源区间又缺 value）回落成占位：
     * **宁可不能改，也不能改坏她的文件。**
     */
    case "inlineMath": {
      const raw = rawOf(source, node);
      const parts = splitInlineMath(raw);
      if (!parts) {
        return [
          schema.nodes.opaque_inline.create({
            label: tf("math.opaqueInline", { src: "$" + String(node.value ?? "") + "$" }),
            raw,
          }),
        ];
      }
      return [
        schema.nodes.math_inline.create(
          { before: parts.before, after: parts.after },
          parts.value ? schema.text(parts.value) : undefined
        ),
      ];
    }

    case "html":
      return [schema.nodes.opaque_inline.create({ label: "（HTML）", raw: rawOf(source, node) })];

    default:
      return [schema.nodes.opaque_inline.create({ label: `（${node.type}）`, raw: rawOf(source, node) })];
  }
}

/** 单元格 / 列表项这类「内容必须是块」的位置：把行内子节点包进段落 */
function blocksFromChildren(children: AnyNode[], schema: Schema, source: string): PMNode[] {
  const out: PMNode[] = [];
  let inlineRun: AnyNode[] = [];

  const flushInline = () => {
    if (!inlineRun.length) return;
    const content = inlineRun.flatMap((c) => convertInline(c, schema, [], source));
    out.push(content.length ? schema.nodes.paragraph.create(null, content) : schema.nodes.paragraph.create());
    inlineRun = [];
  };

  for (const child of children) {
    if (isBlock(child.type)) {
      flushInline();
      out.push(...convertBlock(child, schema, source));
    } else {
      inlineRun.push(child);
    }
  }
  flushInline();
  return out.length ? out : [schema.nodes.paragraph.create()];
}

function isBlock(type: string): boolean {
  return (
    type === "paragraph" ||
    type === "heading" ||
    type === "blockquote" ||
    type === "list" ||
    type === "listItem" ||
    type === "code" ||
    type === "thematicBreak" ||
    type === "table" ||
    type === "html" ||
    type === "yaml" ||
    type === "footnoteDefinition"
  );
}

function convertRow(row: AnyNode, schema: Schema, header: boolean, source: string): PMNode {
  const cells = asList(row.children).map((cell) => {
    const type = header ? schema.nodes.table_header : schema.nodes.table_cell;
    // GFM 表格单元格里**只可能是行内内容**（不能有块级子节点）。
    // 早先复用 blocksFromChildren 会按 isBlock("html") 把单元格里的 `<br>`
    // 当成块级裸 HTML 处理，反向映射时 opaque_block 没有 children，
    // 于是 `<br>` 被静默抹掉 —— 实测 09-table-edge 就是这个丢的。
    const inlines = asList(cell.children).flatMap((c) => convertInline(c, schema, [], source));
    const content = inlines.length ? [schema.nodes.paragraph.create(null, inlines)] : [schema.nodes.paragraph.create()];
    return type.create(null, content);
  });
  return schema.nodes.table_row.create(null, cells);
}

function convertBlock(node: AnyNode, schema: Schema, source: string): PMNode[] {
  switch (node.type) {
    case "paragraph":
      return [schema.nodes.paragraph.create(null, node.children ? blocksInline(node, schema, source) : null)];

    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.depth) || 1));
      return [schema.nodes.heading.create({ level }, blocksInline(node, schema, source))];
    }

    case "blockquote":
      return [schema.nodes.blockquote.create(null, blocksFromChildren(asList(node.children), schema, source))];

    case "code":
      // **不能给 code_block 的内容挂 code mark**：code_block 的 spec 是 `marks: ""`，
      // 而 PM 的 `node.create()` 不校验子内容，所以这个非法结构能安静地活着，
      // 直到某次 `setNodeMarkup`（109 的语言下拉）触发重新校验才抛
      // "Invalid content for node type code_block"。
      // 单测 `pm-doc-validity.spec.ts` 用 doc.check() 全夹具守住这条。
      return [
        schema.nodes.code_block.create(
          { language: asStr(node.lang) },
          asStr(node.value) ? schema.text(asStr(node.value)!) : undefined
        ),
      ];

    case "thematicBreak":
      return [schema.nodes.horizontal_rule.create()];

    case "list": {
      const items = asList(node.children).map((li) => convertBlock(li, schema, source)[0]);
      if (node.ordered) {
        const order = Number(node.start) || 1;
        return [schema.nodes.ordered_list.create({ order }, items)];
      }
      return [schema.nodes.bullet_list.create(null, items)];
    }

    case "listItem": {
      const checked = typeof node.checked === "boolean" ? node.checked : null;
      return [
        schema.nodes.list_item.create({ checked }, blocksFromChildren(asList(node.children), schema, source)),
      ];
    }

    case "table": {
      // 实测（见 102 完成记录）：mdast-util-gfm-table **不给表头打任何标记**，
      // 表头是由「第一行」这个位置决定的（GFM 表格必有表头）。
      const rows = asList(node.children);
      const align = Array.isArray(node.align) ? (node.align as unknown[]) : null;
      return [
        schema.nodes.table.create(
          { align: align ? align.map((a) => (typeof a === "string" ? a : null)) : null },
          rows.map((row, i) => convertRow(row, schema, i === 0 || row.header === true, source))
        ),
      ];
    }

    case "tableRow":
      // 单独走到这里时（非表格内的手工构造）无从判断表头，按数据行处理
      return [convertRow(node, schema, node.header === true, source)];

    /**
     * 138-B：块级公式 `$$…$$` 升级成**可就地编辑**的节点（此前是不透明块）。
     *
     * 拆出来的 `before`（缩进 + 开定界符 + 其后空白）与 `after`（其前空白 + 闭定界符 + 行尾）
     * 存属性，正文进内容 —— 她能改的只有正文，骨架由 `joinMathBlock` 原样带回去。
     * **拆不开就回落成不透明块**：宁可不能改，也不能改坏她的文件（与 136-B 同一条纪律）。
     */
    case "math": {
      const raw = rawOf(source, node);
      const parts = splitMathBlock(raw);
      if (!parts) {
        return [schema.nodes.opaque_block.create({ label: opaqueLabelFor(node), raw })];
      }
      return [
        schema.nodes.math_block.create(
          { before: parts.before, after: parts.after },
          parts.value ? schema.text(parts.value) : undefined
        ),
      ];
    }

    case "footnoteDefinition": {
      // 136-B：定义块**可以就地改正文**了（此前是不透明块）。
      // 拆成「标记 / 冒号后空白 / 续行缩进 / 正文」，前三个存属性、正文进内容；
      // 回写走 joinFootnoteDef 拼回原文（往返性质由 footnote-block.spec.ts 钉住）。
      const raw = rawOf(source, node);
      const parts = splitFootnoteDef(raw);
      // 拆不动的形态（源区间缺失、手写得很怪）回落成不透明块 —— 宁可不能改，也不能改坏
      if (!parts) {
        return [schema.nodes.opaque_block.create({ label: opaqueLabelFor(node), raw })];
      }
      return [
        schema.nodes.footnote_def.create(
          { label: parts.label, gap: parts.gap, indent: parts.indent },
          parts.body ? schema.text(parts.body) : undefined
        ),
      ];
    }

    default:
      // 含 yaml / html / 未知类型：占位 + 原文，绝不丢弃
      return [
        schema.nodes.opaque_block.create({
          label: opaqueLabelFor(node),
          raw: rawOf(source, node),
        }),
      ];
  }
}

function blocksInline(node: AnyNode, schema: Schema, source: string): PMNode[] {
  return asList(node.children).flatMap((c) => convertInline(c, schema, [], source));
}

/** 给顶层块盖上源区间（嵌套块不需要，见 schema 的 TOP_LEVEL_BLOCKS 注释） */
function stampRange(node: PMNode, range: { from: number; to: number } | null): PMNode {
  if (!range || !node.type.spec.attrs?.srcFrom) return node;
  // 注意：`setMarkup` 只有 Text 节点有，普通节点要回到 type.create(attrs, content, marks)
  return node.type.create({ ...node.attrs, srcFrom: range.from, srcTo: range.to }, node.content, node.marks);
}

/**
 * mdast 根的孩子 → PM 块节点数组（114 粘贴走这条：只要节点，不要整篇 doc）。
 *
 * `source` 是这些节点**来自的那份文本**，用于占位节点存原文（103）。
 * 粘贴来的 mdast 没有源文本、也没有 `position`，传空串即可 ——
 * `rangeOf` 拿不到区间就不会盖 `srcFrom/srcTo`，节点天然是「无源区间新块」。
 */
export function mdastRootToNodes(
  children: readonly unknown[],
  schema: Schema = hpSchema,
  source = ""
): PMNode[] {
  return (children as unknown as AnyNode[]).flatMap((child) => {
    const nodes = convertBlock(child, schema, source);
    return nodes.map((n) => stampRange(n, rangeOf(child)));
  });
}

/** md 文本 → ProseMirror 文档（102 只做渲染，回写在 104） */
export function mdastToDoc(md: string, schema: Schema = hpSchema): PMNode {
  const ast = parseMd(md);
  const children = mdastRootToNodes(ast.children, schema, md);
  return schema.nodes.doc.create(null, children.length ? children : [schema.nodes.paragraph.create()]);
}

/**
 * 单元格里的换行 —— 行内 HTML `<br>`（口径 Q2）。
 *
 * 走的是「文件里本来就写着 `<br>`」那条同一个表示：`opaque_inline` 存原文，
 * 反向映射逐字节写回。不用 `hard_break`：它序列化回单元格里会变成一个空格（换行丢失），
 * 见 `docToMdast.inlineToMdast`。粘贴路径（115）需要造这个分隔时调这里，别另发明一套。
 */
export function cellBreak(schema: Schema): PMNode | null {
  const type = schema.nodes.opaque_inline;
  return type ? type.create({ label: "（HTML）", raw: "<br>" }) : null;
}
