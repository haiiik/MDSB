import type { Mark, Node as PMNode } from "prosemirror-model";
import { joinFootnoteDef } from "./footnoteBlock";

/**
 * 103：ProseMirror 文档 → mdast（`mdastToDoc` 的反向）。
 *
 * 只用于**被改动的块**：未改的块根本不进这里，由 101 的 `patch` 从原文逐字节拷回。
 * 这是 D23 的全部要点 —— 反向映射不需要覆盖「原文所有写法」，
 * 只需要保证「PM 里能表达的东西序列化出来是合法 Markdown」。
 *
 * 产出的 mdast 不带 `position`：remark-stringify 不需要它，
 * 而且此时「原文位置」已经不存在（内容被用户改过了）。
 */

type Md = Record<string, unknown>;

const blocks = (node: PMNode): Md[] => {
  const out: Md[] = [];
  node.forEach((child) => out.push(blockToMdast(child)));
  return out;
};

function inlines(node: PMNode): Md[] {
  const out: Md[] = [];
  node.forEach((child) => out.push(inlineToMdast(child)));
  return mergeRuns(out);
}

/**
 * 合并同 mark 的相邻行内节点。
 *
 * 为什么必须合：PM 把带 mark 的文字存成**一串独立文本节点**，
 * `**粗里带 \`码\` 和 [链](url)**` 在 PM 里是四个 text 节点（各自带 strong）。
 * 逐个还原会得到四个并列的 `strong`，序列化出来就是把粗体打断的写法 ——
 * 内容没丢，但结构被拆坏了。
 *
 * 只合并「有 children 的包裹型节点且属性一致」；`inlineCode` 不参与合并，
 * 两个相邻代码 span 合成一个会改变语义。
 */
const MERGEABLE = new Set(["strong", "emphasis", "delete", "link"]);

function mergeKey(n: Md): string | null {
  const type = n.type as string;
  if (!MERGEABLE.has(type)) return null;
  // link 只有 url + title 都相同才算同一段
  return type === "link" ? `link|${n.url}|${n.title ?? ""}` : type;
}

function mergeRuns(list: Md[]): Md[] {
  const out: Md[] = [];
  for (const item of list) {
    const key = mergeKey(item);
    const prev = out[out.length - 1];
    if (key && prev && mergeKey(prev) === key) {
      (prev.children as Md[]).push(...(((item.children as Md[]) ?? [])));
      continue;
    }
    out.push({ ...item });
  }
  // 合并后内层可能又出现可合并的相邻对（例如 strong 里并排两个 emphasis）
  for (const n of out) {
    if (Array.isArray(n.children)) n.children = mergeRuns(n.children as Md[]);
  }
  return out;
}

/**
 * 把 PM 的一个文本节点（带 mark 集合）还原成 mdast 行内结构。
 *
 * **`code` 必须先落在最内层**：mdast 的 `inlineCode` 只能包含纯文本，不能套 strong/em。
 * 早先的实现按 marks 顺序逐个裹，遇到「strong + code」时先裹出 strong 节点、
 * 再让 code 分支去读它的 `value`（strong 没有 value）→ 读成空串 →
 * 结果是把 `**粗里带 \`码\`**` 写成 `**粗里带 ``**`，**「码」字直接丢了**。
 * 106 的边界夹具（`tests/fixtures/11-inline-edge.md`）抓出来的，属真丢内容而非外观漂移。
 */
function wrapMarks(value: string, marks: readonly Mark[]): Md {
  const hasCode = marks.some((m) => m.type.name === "code");
  let node: Md = hasCode ? { type: "inlineCode", value } : { type: "text", value };

  for (const m of marks) {
    switch (m.type.name) {
      case "strong":
        node = { type: "strong", children: [node] };
        break;
      case "em":
        node = { type: "emphasis", children: [node] };
        break;
      case "strikeThrough":
        node = { type: "delete", children: [node] };
        break;
      case "link":
        node = {
          type: "link",
          url: String(m.attrs.href ?? ""),
          title: (m.attrs.title as string) ?? null,
          children: [node],
        };
        break;
      default:
        break; // code 已作为最内层处理
    }
  }
  return node;
}

function inlineToMdast(node: PMNode): Md {
  if (node.type.name === "text") {
    return wrapMarks(node.text ?? "", node.marks);
  }
  if (node.type.name === "image") {
    return { type: "image", url: String(node.attrs.src ?? ""), alt: String(node.attrs.alt ?? ""), title: node.attrs.title ?? null };
  }
  if (node.type.name === "hard_break") {
    return { type: "break" };
  }
  if (node.type.name === "opaque_inline") {
    // 占位原子的原文存在 raw 上，按原始 HTML 节点写回即可逐字节还原
    return { type: "html", value: String(node.attrs.raw ?? node.attrs.label ?? "") };
  }
  if (node.type.name === "footnote_ref") {
    // 136-B：引用还是"原文说了算" —— raw 在就按 raw 落地（她没法在编辑模式改引用文字，
    // 改了 label 也只会让引用和定义接不上），拿不到 raw 才按 label 现拼一个。
    return { type: "html", value: String(node.attrs.raw || `[^${String(node.attrs.label ?? "")}]`) };
  }
  return { type: "text", value: node.textContent };
}

export function blockToMdast(node: PMNode): Md {
  switch (node.type.name) {
    case "paragraph":
      return { type: "paragraph", children: inlines(node) };

    case "heading":
      return { type: "heading", depth: Number(node.attrs.level) || 1, children: inlines(node) };

    case "blockquote":
      return { type: "blockquote", children: blocks(node) };

    case "code_block": {
      const lang = node.attrs.language == null ? null : String(node.attrs.language);
      return { type: "code", lang, meta: null, value: node.textContent };
    }

    case "horizontal_rule":
      return { type: "thematicBreak" };

    case "bullet_list":
      return { type: "list", ordered: false, start: null, spread: false, children: blocks(node) };

    case "ordered_list":
      return { type: "list", ordered: true, start: Number(node.attrs.order) || 1, spread: false, children: blocks(node) };

    case "list_item": {
      const children = blocks(node);
      // **空列表项不带 checked**：实测 remark 序列化「checked=false 且内容为空」的项时
      // 会丢掉 `[ ]` 标记，在某些文档形态下（拆任务项到行首）直接写出坏片段
      // `-\n[ ] \n  正文…`。空项本来就没有可勾的东西，置 null 后输出变成合法的 `-`。
      const isEmpty = node.textContent.trim() === "";
      return {
        type: "listItem",
        checked: isEmpty ? null : (node.attrs.checked ?? null),
        spread: false,
        children,
      };
    }

    case "table": {
      const rows = blocks(node);
      const cols = node.childCount ? node.child(0).childCount : 0;
      // 对齐标记由 103 存在 table.attrs.align 上；拿不到时才是「全默认」
      const stored = Array.isArray(node.attrs.align) ? (node.attrs.align as (string | null)[]) : null;
      const align = stored && stored.length === cols ? stored : Array.from({ length: cols }, () => null);
      return { type: "table", align, children: rows };
    }

    case "table_row":
      return { type: "tableRow", children: blocks(node) };

    case "table_cell":
    case "table_header": {
      // 单元格是行内内容（见 mdastToDoc 的同名注释）。
      // 这里不能再 `flatMap(b => b.children)`：那样 opaque_block 没有 children，
      // 里面的原文会被直接抹掉。逐个孩子分派，块级占位走 raw 回填。
      const children: Md[] = [];
      node.forEach((p) => {
        if (p.type.name === "opaque_block") {
          children.push({ type: "html", value: String(p.attrs.raw ?? "") });
          return;
        }
        p.forEach((x) => children.push(inlineToMdast(x)));
      });
      return { type: "tableCell", children };
    }

    case "opaque_block":
      // 不透明保留的落点：原文逐字节存在 raw 上，写回 html 节点即可原样落地
      return { type: "html", value: String(node.attrs.raw ?? "") };

    case "footnote_def": {
      // 136-B：定义块 = 标记 + 冒号后空白 + 正文（按原文缩进重排续行）。
      // 走 joinFootnoteDef 而不是让 remark 的序列化器重排 —— 后者会把两格续行缩进改成四格，
      // 那是她没做过的改动（实测见工单 136 §一）。
      return {
        type: "html",
        value: joinFootnoteDef({
          label: String(node.attrs.label ?? ""),
          gap: String(node.attrs.gap ?? " "),
          indent: String(node.attrs.indent ?? "  "),
          body: node.textContent,
        }),
      };
    }

    default:
      return { type: "html", value: node.textContent };
  }
}

/** 整篇文档 → mdast Root（一般不用，改动块请直接用 `blockToMdast`） */
export function docToMdast(doc: PMNode): Md {
  return { type: "root", children: blocks(doc) };
}
