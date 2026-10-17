import { parseMd } from "./md";
import { uniqueSlug } from "./anchors";

export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
}

function textOf(node: unknown): string {
  if (node && typeof node === "object") {
    const n = node as { type?: string; value?: string; children?: unknown[] };
    if (n.type === "code") return "";
    if (typeof n.value === "string") return n.value;
    if (Array.isArray(n.children)) return n.children.map(textOf).join("");
  }
  return "";
}

/**
 * 从文档模型抽标题扁平列表。
 *
 * 与渲染侧 `assignHeadingIds` 用**同一个** slug 函数、同一套「按文档顺序去重」的
 * 计数逻辑，所以这里算出的 id 一定能在 DOM 里找到对应元素。
 */
export function outlineOf(md: string): OutlineHeading[] {
  const tree = parseMd(md);
  const out: OutlineHeading[] = [];
  const used = new Set<string>();
  for (const child of tree.children) {
    if (child.type !== "heading") continue;
    const h = child as { depth: number; children: unknown[] };
    const text = textOf(h).trim();
    out.push({ level: h.depth, text, id: uniqueSlug(text, used) });
  }
  return out;
}
