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
 * 140（要求：「切换模式时定位到相同位置」）：三档的内容高度天生不同
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
 * 150（要求：「编辑模式的位置，切换到阅读模式后仍对应不上」）：锚点从「哪一块」补成
 * **「哪一块 + 这一块内部已经滚过去多少」**。
 *
 * 140 那套只有**块级**精度：键取的是这一块 textContent 的开头，落点是「把这块顶边贴到视口上沿」。
 * 停在普通段落里没问题（一段就一两行），可一旦停在**比屏幕还高的一块**里 ——
 * 60 行的表格、长引用、大代码块 —— 整块就被当成一个坐标，切过去只能回到块首。
 * 实测（同一篇文档、两档内容高都是 3732）：编辑档停在表格第 28 行（scrollTop 1757），
 * 切到阅读档落到 648，**差 1109px**，落回表头。PRD 全是长表格，所以天天撞。
 *
 * `内偏` 就是那一截被丢掉的距离：视口上沿那条线在块顶**之下**多少 px。
 * 搬过去时按块高比例缩放 —— 两档同一块的字号/行高在 143 / 149-A 之后已经对齐，
 * 比例几乎就是 1，所以偏移能直接落回原来那一带。
 * 按构造 `内偏 < 块高`（顶端块定义为「底边还在视口上沿之下」的那一块），
 * 所以缩放后的偏移必定还在目标块之内，不会翻到下一块去。
 */
export interface 锚 {
  /** 归一化后的顶端文字（前 ANCHOR_KEY 字） */
  键: string;
  /** 块顶在视口上沿之上多少 px = 在这块里已经滚过去的那一截 */
  内偏: number;
  /** 这一块在**来源档**里多高，用来把 `内偏` 按比例搬到目标档 */
  块高: number;
}

/**
 * 候选块里挑**离预测位置最近**的那一个，返回它的下标；没配上返回 -1。
 *
 * 为什么不是「文档里第一个配得上的」：键短的时候（比如标题只有「概述」两个字），
 * 文档里更早出现的「概述…」会先命中，于是换档换到别处去了 ——
 * 认错段比落回原像素更糟（review 抓的就是这条）。
 * `near < 0`（没有预测值，例如首帧还没几何）才退回「按文档顺序取第一个」。
 *
 * `允许反向`（150）：候选文字**是键的开头**也算命中 —— 给「块级键 → 行级候选」那条路用。
 * 阅读档整张表的键是「编号名称说明1名称1要要…」，而源码档的候选是**一行**，
 * 表头那行只有「编号名称说明」六个字，正向 `startsWith` 永远配不上，只能退回比例（实测差 511px）。
 * 反向匹配要设**最短 4 字**：不然一行空文字或「1」就能把整篇都"命中"。
 */
export function pickAnchorIndex(
  cands: Array<{ text: string; top: number; h?: number }>,
  needle: string,
  near: number,
  允许反向 = false
): number {
  if (!needle) return -1;
  const 键长 = [Math.min(needle.length, ANCHOR_KEY), Math.min(needle.length, ANCHOR_KEY_SHORT)];
  for (const n of 键长) {
    const 键 = needle.slice(0, n);
    if (!键) continue;
    let 选中的 = -1;
    let 最小差 = Infinity;
    cands.forEach((c, i) => {
      const 中 =
        c.text.startsWith(键) || (允许反向 && c.text.length >= 4 && 键.startsWith(c.text));
      if (!中) return;
      const 差 = near < 0 ? i : Math.abs(c.top - near); // 没预测值时按文档顺序比
      if (差 < 最小差) {
        最小差 = 差;
        选中的 = i;
      }
    });
    if (选中的 >= 0) return 选中的;
  }
  return -1;
}

/** 选中的那一块该滚到多少（150：块顶 + 按块高比例搬过来的块内偏移） */
export function anchorScrollTop(c: { top: number; h?: number }, a: 锚): number {
  const 搬 = a.块高 > 0 && c.h && c.h > 0 ? (a.内偏 * c.h) / a.块高 : a.内偏;
  return Math.max(0, Math.round(c.top + 搬 - ANCHOR_PAD));
}

/** 旧口径的薄壳：只按块顶落（单测与「没有块内信息」的调用方走这条） */
export function pickAnchorPos(
  cands: Array<{ text: string; top: number; h?: number }>,
  needle: string,
  near: number
): number {
  const i = pickAnchorIndex(cands, needle, near);
  return i < 0 ? -1 : Math.max(0, cands[i].top - ANCHOR_PAD);
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
/**
 * 判「哪一条压在视口上沿线上」时的容差。
 *
 * 行与行的 rect 是**相邻**的：上一行的 bottom 就是下一行的 top，而这两个数在浏览器里
 * 常常差不到半个像素（缩放 175% 下每行高 39.4px 这类）。用 `bottom <= 线` 一刀切，
 * 停在"某一行的开头"时就会翻到**上一行**去 —— 实测正好差一行（39px），
 * 而且换档会把这一行的键当成起点，第二跳再差一行（78px）。
 * 所以边界一律**归下面那一行**：bottom 只比线多出半个像素以内，仍算"已经过去了"。
 */
const 边界容差 = 0.5;

/**
 * 取锚点时往块**里面**再钻一层：顶端落在表格行 / 列表项里就用那一行做键。
 *
 * 为什么要钻：整张表的 textContent 开头永远是表头，"块级键 + 块内偏移"能带回那张表，
 * 但带不回原来那一行 —— 而源码档的"一块"本来就是一行，两边键根本对不上，
 * 只能退回比例换算（实测差 511px ≈ 13 行）。钻一层之后：
 * 阅读/编辑档的键 = 「41 名称41 …」，源码档那一行的键 = 同一个串，直接对上。
 *
 * 代价只落在**当前这一块**的子元素上（一次查询 + 几个 rect），不是整篇遍历 ——
 * 这条是每次滚动都要跑的（140 记过不能拿 rAF 合并），整篇遍历付不起。
 */
const 可钻 = "tr, li";

function 取锚(el: Element, 线: number): 锚 | null {
  let 源 = el;
  for (const 内 of Array.from(el.querySelectorAll(可钻))) {
    const r = 内.getBoundingClientRect();
    if (r.bottom <= 线 + 边界容差) continue;
    if (anchorText(内.textContent ?? "")) {
      源 = 内;
      break;
    }
  }
  const r = 源.getBoundingClientRect();
  const t = anchorText(源.textContent ?? "");
  if (!t) return null;
  return { 键: t.slice(0, ANCHOR_KEY), 内偏: Math.max(0, 线 - r.top), 块高: r.height };
}

export function domTopAnchor(scroller: HTMLElement | null, blockSel: string): 锚 | null {
  if (!scroller) return null;
  const 线 = scroller.getBoundingClientRect().top + ANCHOR_PAD;
  for (const el of Array.from(scroller.querySelectorAll(blockSel))) {
    if (el.getBoundingClientRect().bottom <= 线 + 边界容差) continue;
    const a = 取锚(el, 线);
    if (a) return a;
  }
  return null;
}

/**
 * 把配得上的那块滚到上沿（带上块内偏移）；`near` 是预测位置，用来在同名块里挑最近的一个。
 *
 * `兜底Sel`（150 补的第二级）：**只有顶层块配不上时才再扫一遍细粒度元素**。
 * 为什么需要：源码档的"一块"是**一行**，从那里带出来的键是「41 名称41 …」，
 * 而阅读/编辑档的顶层块是**整张表**，键开头永远是表头 —— 两边对不上，只能退回比例，
 * 实测差 78px（约两行）。补一次 `tr` / `li` 的扫描就落回那一行。
 * 放在兜底路径而不是并进主候选集：主路径每次滚动都要跑（`noteGeom` 是同步的），
 * 把候选集放大几倍是为了一条少见的路数给常态付费。
 */
export function scrollDomToAnchor(
  scroller: HTMLElement | null,
  blockSel: string,
  a: 锚 | null,
  near = -1,
  兜底Sel = ""
): boolean {
  if (!scroller || !a || !a.键) return false;
  const 扫 = (sel: string): Array<{ text: string; top: number; h: number }> => {
    const 内容顶 = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const out: Array<{ text: string; top: number; h: number }> = [];
    for (const el of Array.from(scroller.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      out.push({ text: anchorText(el.textContent ?? ""), top: r.top - 内容顶, h: r.height });
    }
    return out;
  };
  const cands = 扫(blockSel);
  const i = pickAnchorIndex(cands, a.键, near);
  if (i >= 0) {
    scroller.scrollTop = anchorScrollTop(cands[i], a);
    return true;
  }
  if (!兜底Sel) return false;
  const 细 = 扫(兜底Sel);
  const j = pickAnchorIndex(细, a.键, near);
  if (j < 0) return false;
  // 命中的就是那一行本身：偏移属于"块内部"，行级候选不需要再叠一层
  scroller.scrollTop = anchorScrollTop(细[j], { 键: a.键, 内偏: 0, 块高: a.块高 });
  return true;
}
