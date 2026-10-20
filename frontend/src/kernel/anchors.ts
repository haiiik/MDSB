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

/**
 * 140（她：「切换模式时定位到相同位置」）：三档的内容高度天生不同
 * （渲染 DOM / PM 文档 / 源码行），**同一个 scrollTop 数值不是同一个位置**。
 * 所以跨模式对齐不传像素，传「内容顶到视口顶占可滚范围的比例」：
 * 在 A 档量出来，到 B 档再乘回去。
 *
 * 可滚范围为 0（内容不超高）时一律算 0，不出现除零；越界的输入夹到 [0,1]。
 */
export function ratioOf(scrollTop: number, contentHeight: number, viewportHeight: number): number {
  const max = contentHeight - viewportHeight;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, scrollTop / max));
}

/** ratioOf 的逆运算；往返应当回到原值（单测钉的就是这条） */
export function scrollTopFor(ratio: number, contentHeight: number, viewportHeight: number): number {
  const max = Math.max(0, contentHeight - viewportHeight);
  return Math.round(Math.min(1, Math.max(0, ratio)) * max);
}

/**
 * 140：跨模式定位用的**内容键**（anchor = 锚点）。
 *
 * 三档看到的同一段文字，形状是不一样的：
 * 源码档带着 `#`、`**`、`[文字](地址)`；阅读/编辑档渲染完只剩文字。
 * 归一化必须**三个方向都落到同一个串**，否则「源码 → 阅读」这一路配不上，
 * 只能静默退回比例换算（真壳里实测偏 3 段）。所以这里做三件事：
 * ① 链接/图片先折成纯文字：`[文字](地址)` → `文字`，`![说明](地址)` → 整个丢掉
 *    （阅读档的 `<img>` 没有 textContent，两边都得没有它）；
 * ② 压掉空白与控制字符；
 * ③ 压掉 Markdown 标记字符。
 *
 * 全程手写扫描，**不用带反斜杠的正则**（这类字面量经工具链写入时反斜杠被吞过一次），
 * 也不用字符区间（区间上界被吞过第二次）。
 */
const MARKS = "#*`>~|-_()[]!";

function stripOne(s: string): string {
  let out = "";
  for (const c of s) {
    if (c.charCodeAt(0) <= 32) continue; // 空白与控制字符
    if (MARKS.includes(c)) continue; // Markdown 标记
    out += c;
  }
  return out;
}

export function anchorText(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const 是图 = c === "!" && s[i + 1] === "[";
    const 是链 = c === "[";
    if (!是图 && !是链) {
      out += stripOne(c);
      i++;
      continue;
    }
    // 方括号里的文字留着（图片不留，渲染出来它就是没有字的一张图）
    let j = i + (是图 ? 2 : 1);
    let label = "";
    while (j < s.length && s[j] !== "]") {
      label += s[j];
      j++;
    }
    if (j >= s.length) {
      out += stripOne(c); // 没有闭合的方括号：当普通字符处理，别把余下的一口吞掉
      i++;
      continue;
    }
    // 紧跟的 `(地址)` 或 `[引用名]` 一并丢掉
    let k = j + 1;
    const 闭 = s[k] === "(" ? ")" : s[k] === "[" ? "]" : "";
    if (闭) {
      let m = k + 1;
      while (m < s.length && s[m] !== 闭) m++;
      k = m < s.length ? m + 1 : k;
    }
    if (!是图) out += anchorText(label);
    i = k;
  }
  return out;
}

/** 存下来的键有多长；全长配不到时退到这个长度 */
export const ANCHOR_KEY = 24;
export const ANCHOR_KEY_SHORT = 12;
/** 落点上沿留 12px，别把那一行顶死在容器边上（和 jumpToHeading 用的是同一条线） */
export const ANCHOR_PAD = 12;

/**
 * 候选块里挑**离预测位置最近**的那一个，返回它该滚到的 scrollTop；没配上返回 -1。
 *
 * 为什么不是「文档里第一个配得上的」：键短的时候（比如标题只有「概述」两个字），
 * 文档里更早出现的「概述…」会先命中，于是换档换到别处去了 ——
 * 认错段比落回原像素更糟（review 抓的就是这条）。
 * `near < 0`（没有预测值，例如首帧还没几何）才退回「按文档顺序取第一个」。
 */
export function pickAnchorPos(
  cands: Array<{ text: string; top: number }>,
  needle: string,
  near: number
): number {
  if (!needle) return -1;
  const 键长 = [Math.min(needle.length, ANCHOR_KEY), Math.min(needle.length, ANCHOR_KEY_SHORT)];
  for (const n of 键长) {
    const 键 = needle.slice(0, n);
    if (!键) continue;
    let 选中的: number | null = null;
    let 最小差 = Infinity;
    cands.forEach((c, i) => {
      if (!c.text.startsWith(键)) return;
      const 差 = near < 0 ? i : Math.abs(c.top - near); // 没预测值时按文档顺序比
      if (差 < 最小差) {
        最小差 = 差;
        选中的 = i;
      }
    });
    if (选中的 !== null) return Math.max(0, cands[选中的].top - ANCHOR_PAD);
  }
  return -1;
}

/**
 * 140：DOM 版的「取顶端锚点 / 按锚点滚过去」。
 *
 * 为什么在 kernel 而不在 EditorPane：选择器（`.ProseMirror > *`、`.cm-line`）
 * 是各档自己的内部形状，让外壳去持有它们，就把这些字符串烘进了**主入口 chunk** ——
 * 冷启动分包那条守门判据（主入口里不许出现 PM/CM 的痕迹）正是按内容查的，
 * 一次字符串泄漏就红（实测红的就是它）。
 * 所以：通用逻辑在这里，选择器由各档组件自己传，EditorPane 只调档位组件暴露的方法。
 */
export function domTopAnchor(scroller: HTMLElement | null, blockSel: string): string {
  if (!scroller) return "";
  const 线 = scroller.getBoundingClientRect().top + ANCHOR_PAD;
  for (const el of Array.from(scroller.querySelectorAll(blockSel))) {
    if (el.getBoundingClientRect().bottom <= 线) continue;
    const t = anchorText(el.textContent ?? "");
    if (t) return t.slice(0, ANCHOR_KEY);
  }
  return "";
}

/** 把配得上的那块滚到上沿；`near` 是预测位置（用来在同名块里挑最近的一个） */
export function scrollDomToAnchor(
  scroller: HTMLElement | null,
  blockSel: string,
  needle: string,
  near = -1
): boolean {
  if (!scroller || !needle) return false;
  const 内容顶 = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const cands: Array<{ text: string; top: number }> = [];
  for (const el of Array.from(scroller.querySelectorAll(blockSel))) {
    cands.push({
      text: anchorText(el.textContent ?? ""),
      top: el.getBoundingClientRect().top - 内容顶,
    });
  }
  const v = pickAnchorPos(cands, needle, near);
  if (v < 0) return false;
  scroller.scrollTop = v;
  return true;
}
