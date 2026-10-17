/**
 * 锚点 id 生成（014 大纲与 022 TOC/脚注共用这一套，禁止两处各写一份）。
 *
 * 规则要**确定**：保存后重开、或滚动跟随重新计算时，同一个标题必须得到同一个 id，
 * 否则锚点会指错条目。
 */

/** 保留中日韩文字、字母数字与连字符，其余转/去连字符 */
export function slugify(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  // 数字开头的 id 在 CSS 选择器里必须转义，本项目统一走 CSS.escape，
  // 不再加前缀 —— 加了反而让「目录里的锚点」和「肉眼看到的标题」对不上。
  return s || "section";
}

/**
 * 同一篇里重复标题很常见（两个「说明」），第二个必须可区分。
 * 传入已用集合，返回唯一 id 并把结果写回集合。
 */
export function uniqueSlug(text: string, used: Set<string>): string {
  const root = slugify(text);
  let id = root;
  let n = 2;
  while (used.has(id)) {
    id = root + "-" + n;
    n++;
  }
  used.add(id);
  return id;
}

export interface HeadingItem {
  level: number;
  text: string;
  id: string;
  /** 在文档节点序列中的序号，用于折叠树与滚动定位 */
  index: number;
  children: HeadingItem[];
}

/**
 * 把扁平标题列表折成树。
 *
 * 层级跳跃（h1 直接到 h3）不补虚拟中间层，直接挂到最近的更浅一层下 ——
 * 补出来的假节点点不动，反而更奇怪。
 */
export function buildHeadingTree(flat: Array<{ level: number; text: string; id: string }>): HeadingItem[] {
  const roots: HeadingItem[] = [];
  const stack: HeadingItem[] = [];
  flat.forEach((h, i) => {
    const node: HeadingItem = { ...h, index: i, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}
