import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import type { Comment, Doctype, Element, ElementContent, Root as HastRoot } from "hast";
import type { Root as MdRoot, RootContent } from "mdast";

/**
 * 114：富文本粘贴 → mdast（US-35 的纯函数接缝，spec §5 第 2 条）。
 *
 * 解析交给 `hast-util-from-html`（容错解析，浏览器级），标签→mdast 的映射交给
 * `hast-util-to-mdast`（remark 官方生态，知道 b/i/table/li 该怎么落）。
 * **这里只写「我们这条保真路线要求的那部分」**：
 *
 * 1. 丢样式：`style` / `class` / `id` / `face` / `color` / `size` / `width` / `height`
 *    等一律不进结果 —— Markdown 里没有这些概念，留着只会在写盘时变成裸 HTML。
 * 2. 丢 Word 垃圾：`<o:p>` `<w:*>` `<v:*>` `<xml>` 连**子树**一起删，
 *    `<span class=MsoNormal>` 这类容器脱壳成普通文本流。
 * 3. 丢跨格：GFM 表格没有 colspan/rowspan（112 已确认这是硬边界），
 *    带跨格的粘贴表格会被拍平 —— 拍平规则在 115 专项里定。
 *
 * 产出的 mdast **不带 `position`**，所以进 PM 后 `srcFrom/srcTo` 自然是 null ——
 * 这正是 103 说的「无源区间新块」：新块没有原文可拷，第一次保存时整块序列化。
 */

/** 整个子树丢弃（内容不属于「文档正文」） */
const DROP_SUBTREE = new Set([
  "script",
  "style",
  "noscript",
  "head",
  "title",
  "meta",
  "link",
  "iframe",
  "object",
  "embed",
  "template",
  "svg",
  "math",
  "button",
  "input",
  "select",
  "textarea",
  "form",
]);

/**
 * 只脱壳（保留孩子）的标签：**行内容器**，Markdown 里没有对应概念。
 *
 * 注意 `div` / `section` / `article` 这些**块级**容器不在这里 —— 它们要留给
 * `to-mdast` 自己判内容模型。实测把 div 也脱壳会把 `<div>一</div><div>二</div>`
 * 并成一个裸 text 节点（两块内容被并成一句），而 Markdown 里那是两个段落。
 */
const UNWRAP = new Set([
  "span",
  "font",
  "u",
  "big",
  "small",
  "center",
  "label",
  "abbr",
  "cite",
  "q",
  "time",
  "mark",
  "bdi",
  "bdo",
  "ruby",
]);

/** 属性白名单：只有这些能进结果 */
const KEEP_ATTR: Record<string, string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  ol: ["start"],
  td: ["align"],
  th: ["align"],
  // `class="language-sql"` 是**语义**不是样式：围栏的语言就靠它传（109 的下拉读的是它）。
  // 只留 code 标签的 class，且只认 language-* —— 别的 class 一律丢。
  code: ["className"],
};

/** 只保留 `language-xxx` 形式的 class，其余（mso-*、highlight、token…）全丢 */
function keepLanguageClass(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter((c) => /^language-[\w+#-]+$/i.test(c));
  if (Array.isArray(value)) return value.flatMap((v) => keepLanguageClass(String(v)));
  return [];
}

/** Word / Office 的私有命名空间前缀 */
const isOfficeTag = (tag: string): boolean => /^(o|w|v|xml|m):/.test(tag) || tag === "listdata";

const attrs = (el: Element): Record<string, unknown> =>
  (el.properties ?? {}) as unknown as Record<string, unknown>;

function cleanElement(el: Element): ElementContent | ElementContent[] | null {
  const tag = el.tagName.toLowerCase();

  if (DROP_SUBTREE.has(tag)) return null;
  if (isOfficeTag(tag)) return null;

  // 属性过滤：白名单之外全丢（style/class/id/face/color/width/height…）
  const allow = KEEP_ATTR[tag] ?? [];
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs(el))) {
    if (!allow.includes(k)) continue;
    if (v === null || v === undefined || v === false) continue;
    if (k === "className") {
      const only = keepLanguageClass(v);
      if (!only.length) continue;
      kept[k] = only;
      continue;
    }
    // 对齐只认 left/center/right 三个字面量，别的（含 mso 的怪值）丢掉
    if (k === "align" && !["left", "center", "right"].includes(String(v).toLowerCase())) continue;
    kept[k] = v;
  }
  // **唯一的例外**：`td/th` 的 `style` 里只捞 `text-align`，其余照样全丢。
  // Excel / Word 的表格对齐**只写在 style 里**（没有 align 属性），
  // 不捞这一条，「粘贴后对齐标记正确」就无从谈起 —— 对齐是语义，不是样式。
  if (tag === "td" || tag === "th") {
    const style = String(attrs(el).style ?? "");
    const m = /text-align:\s*(left|center|right)/i.exec(style);
    if (m && kept.align === undefined) kept.align = m[1].toLowerCase();
  }
  el.properties = kept as Element["properties"];

  const kids: ElementContent[] = [];
  for (const child of el.children) {
    const cleaned = cleanNode(child);
    if (cleaned === null) continue;
    if (Array.isArray(cleaned)) kids.push(...cleaned);
    else kids.push(cleaned);
  }
  el.children = kids as Element["children"];

  // 脱壳：Markdown 没有对应结构的容器，把孩子留在原位
  if (UNWRAP.has(tag)) return kids;
  return el;
}

function cleanNode(node: ElementContent | Comment | Doctype): ElementContent | ElementContent[] | null {
  if (node.type === "comment" || node.type === "doctype") return null;
  if (node.type === "text") {
    // Word 导出的正文里塞满 U+FEFF（BOM 被当缩进用）与成串的不间断空格
    node.value = node.value.replace(/[﻿]/g, "").replace(/[ \t\u00a0]{2,}/g, " ");
    return node.value.length ? node : null;
  }
  if (node.type === "element") return cleanElement(node);
  return node;
}

function cleanRoot(tree: HastRoot): HastRoot {
  const children: HastRoot["children"] = [];
  for (const node of tree.children as unknown as ElementContent[]) {
    const cleaned = cleanNode(node);
    if (cleaned === null) continue;
    if (Array.isArray(cleaned)) children.push(...(cleaned as unknown as HastRoot["children"]));
    else children.push(cleaned as unknown as HastRoot["children"][number]);
  }
  return { ...tree, children };
}

/**
 * 空段落没有信息量，掉到根层就删。
 *
 * 「空」包含**只有空白**的情况：Word 用 `<p><span lang=EN-US>&nbsp;</span></p>` 当行距，
 * 转出来就是一个空格，留着会在文档里凭空多出一段。
 */
function dropEmptyParagraphs(root: MdRoot): MdRoot {
  const children = root.children.filter((child: RootContent) => {
    if (child.type !== "paragraph") return true;
    return textOf(child.children).trim().length > 0;
  });
  return { ...root, children };
}

/** 取一串行内节点的纯文本（只看一层，够判断空白） */
function textOf(nodes: { type: string; value?: string; children?: unknown[] }[]): string {
  return nodes
    .map((n) => (typeof n.value === "string" ? n.value : n.children ? textOf(n.children as never) : ""))
    .join("");
}

/** mdast 根层允许的块类型；不在表里的都是行内节点 */
const FLOW_TYPES = new Set([
  "paragraph",
  "heading",
  "list",
  "listItem",
  "blockquote",
  "table",
  "code",
  "html",
  "thematicBreak",
  "definition",
  "footnoteDefinition",
  "yaml",
  "toml",
]);

/**
 * 根层归一：把裸行内内容攒成段落。
 *
 * `to-mdast` 对「整段只有文本」的输入会直接吐 `text` 节点，而 mdast 的 root 只收流内容
 * —— 这种树喂给 PM 会静默丢内容（109 的教训：非法结构藏到下一次操作才炸）。
 */
function normalizeRoot(root: MdRoot): MdRoot {
  const children: RootContent[] = [];
  let inline: RootContent[] = [];
  const flush = () => {
    if (inline.length) children.push({ type: "paragraph", children: inline } as RootContent);
    inline = [];
  };
  for (const child of root.children) {
    if (FLOW_TYPES.has((child as RootContent).type)) {
      flush();
      children.push(child as RootContent);
    } else {
      inline.push(child as RootContent);
    }
  }
  flush();
  return { ...root, children };
}

/**
 * 无 `thead` 的表格：`to-mdast` 会**合成一行空表头**，真内容整体下移一行。
 *
 * GFM 必须有表头行，所以正确做法不是留一行空白，而是把合成出来的空行去掉 ——
 * 第一行内容自然顶上去当表头（与 112「删除表头行后下一行顶上」同一口径）。
 */
function dropSyntheticEmptyHeader(root: MdRoot): MdRoot {
  for (const child of root.children) {
    if (child.type !== "table") continue;
    const table = child as unknown as { align: unknown[]; children: { children: { children: unknown[] }[] }[] };
    if (table.children.length < 2) continue;
    const first = table.children[0];
    if (first.children.length > 0 && first.children.every((cell) => cell.children.length === 0)) {
      table.children = table.children.slice(1);
      table.align = table.align.slice(0, first.children.length);
    }
  }
  return root;
}

/**
 * 抹掉所有 `position`。
 *
 * **必须抹**：`hast-util-to-mdast` 会把 hast 的位置一路带进 mdast，而那个位置是
 * 「剪贴板里那段 HTML 的字符偏移」。103 的 `stampRange` 读的就是 `position.offset`，
 * 留着它 = 给新块盖上**另一份文本的坐标**，回写时按这个坐标去切文档 → 静默写坏用户文件。
 * 这正是 109 那类「非法结构安静活着、下一次操作才炸」的坑，在入口处一次清干净。
 */
function stripPositions(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripPositions(item);
    return;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    delete record.position;
    for (const key of Object.keys(record)) stripPositions(record[key]);
  }
}

/**
 * 单元格只留行内结构。
 *
 * Word / 网页表格的单元格里几乎都套着 `<p>`，`to-mdast` 会忠实地产出
 * `tableCell > paragraph > text`。但 **GFM 的表格单元格只能放行内内容**，
 * 我们整条链路（111 的单元格双向映射）也按这个约定实现：
 * `mdastToDoc` 走「行内专用」路径、`docToMdast` 吐 `tableCell > inline*`。
 * 留着 paragraph 会让粘贴的表格在 PM 里形状不对（109 那类「非法结构安静活着」）。
 *
 * 降级规则：段落之间补一个**行内 HTML `<br>`**（不是 mdast 的 `break` 节点 —— 实测 `break`
 * 在单元格里会被序列化成空格，换行就丢了；`<br>` 正是 111 已有的单元格换行表示，往返一致）；
 * 单元格里的列表/代码块等**块级结构 GFM 表达不了**，只保留其中的文字。
 */
function inlineOf(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of nodes) {
    const node = raw as { type: string; children?: unknown[] };
    if (node.type === "paragraph") {
      if (out.length) out.push({ type: "html", value: "<br>" });
      out.push(...inlineOf(node.children ?? []));
      continue;
    }
    if (FLOW_TYPES.has(node.type)) {
      // 列表项、引用等：文字留下，容器丢掉
      out.push(...inlineOf(node.children ?? []));
      continue;
    }
    out.push(node);
  }
  return out;
}

function normalizeTableCells(root: MdRoot): MdRoot {
  // 递归整棵树：引用块 / 列表项里也可能嵌着表格，只处理根层会漏
  const walk = (node: unknown): void => {
    const n = node as { type?: string; children?: unknown[] };
    if (n?.type === "table") {
      for (const row of n.children ?? []) {
        for (const cell of (row as { children?: unknown[] }).children ?? []) {
          const c = cell as { children?: unknown[] };
          c.children = inlineOf(c.children ?? []);
        }
      }
      return; // 表格里不再往下走
    }
    for (const child of n?.children ?? []) walk(child);
  };
  walk(root);
  return root;
}

/** HTML 片段 → mdast Root（不带 position，见文件头注释） */
export function htmlToMdast(html: string): MdRoot {
  const tree = fromHtml(html, { fragment: true }) as HastRoot;
  const hast = cleanRoot(tree);
  const md = toMdast(hast as never) as MdRoot;
  const out = dropEmptyParagraphs(
    dropSyntheticEmptyHeader(normalizeRoot(md))
  );
  normalizeTableCells(out);
  stripPositions(out);
  return out;
}
