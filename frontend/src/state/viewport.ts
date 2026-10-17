import { ref } from "vue";

/**
 * 正文视口的共享句柄。
 *
 * 大纲（014）、TOC（022）、状态栏统计（023）都要读滚动位置或跳锚点，
 * 但它们和正文渲染分居两个组件 —— 用一对模块级引用打通，
 * 比把 DOM 元素层层 emit 上去干净。
 */

let scroller: HTMLElement | null = null;
let root: HTMLElement | null = null;

export function registerReadView(el: HTMLElement | null, docRoot: HTMLElement | null) {
  scroller = el;
  root = docRoot;
}

export function hasReadView(): boolean {
  return !!scroller && !!root;
}

/** 当前高亮的小节 id，由滚动监听维护 */
export const activeHeadingId = ref("");

/**
 * 标题在滚动内容里的绝对偏移。
 *
 * 不用 `offsetTop`：它相对 offsetParent，而 .hp-doc 没有定位，
 * offsetParent 会跳到外层元素上，量出来的数与滚动容器不同源，
 * 表现为「点了跳转但高亮算错小节」。改成用矩形差值算。
 */
function headingOffsets(): Array<{ id: string; top: number }> {
  if (!scroller || !root) return [];
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  return Array.from(root.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")).map(
    (el) => ({ id: el.id, top: el.getBoundingClientRect().top - base })
  );
}

export interface HeadingBox {
  id: string;
  top: number;
}

export function headingBoxes(): HeadingBox[] {
  return headingOffsets();
}

/** 跳到某个小节；返回是否找到目标 */
export function jumpToHeading(id: string): boolean {
  if (!scroller || !root) return false;
  const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!el) return false;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  scroller.scrollTop = Math.max(0, el.getBoundingClientRect().top - base - 12);
  activeHeadingId.value = id;
  // 滚动事件会立刻重算活动项，位置对齐后仍指向本节；这里不额外延时兜底
  return true;
}

/* ------------------------------------------------------------------ 导航跳转 */

/**
 * 导航条目：`index` 是**文档里第几个标题**（`buildHeadingTree` 给扁平列表编的号，
 * 与树怎么折叠无关）。
 */
export interface HeadingRef {
  id: string;
  index: number;
}

/**
 * 当前模式的跳转器，由 `EditorPane` 在切模式时注册。
 *
 * 为什么要有这一层（127）：原来侧栏点导航只认阅读模式那对 `scroller + root`，
 * 而编辑/源码模式会 `registerReadView(null, null)` —— 于是那两档点导航一律返回 false，
 * 她看到的就是「找不到小节」。三档的定位方式本来就不同：
 * 阅读按标题的 `id` 找 DOM；编辑按「第 n 个标题」找 PM 的 DOM；
 * 源码没有标题 DOM，按「第 n 个 `# ` 行」在 CodeMirror 里定位。
 * 用 `index` 而不是文字匹配，重复标题也不会跳错。
 */
let headingJumper: ((h: HeadingRef) => boolean) | null = null;

export function setHeadingJumper(fn: ((h: HeadingRef) => boolean) | null): void {
  headingJumper = fn;
}

/** 侧栏/TOC 的统一入口：由当前模式去定位；返回是否成功 */
export function jumpTo(h: HeadingRef): boolean {
  const ok = headingJumper ? headingJumper(h) : false;
  if (ok) activeHeadingId.value = h.id;
  return ok;
}

/** 根据当前滚动位置算活动小节 */
export function syncActiveHeading() {
  if (!scroller) return;
  const boxes = headingOffsets();
  if (boxes.length === 0) {
    activeHeadingId.value = "";
    return;
  }
  // 滚到底时最后一个小节永远到不了「贴着顶部」的位置，
  // 不兜底的话点它的高亮会退回上一节，看起来像点了没反应
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
  if (atBottom) {
    activeHeadingId.value = boxes[boxes.length - 1].id;
    return;
  }
  const y = scroller.scrollTop + 24;
  let current = boxes[0].id;
  for (const b of boxes) {
    if (b.top <= y) current = b.id;
    else break;
  }
  activeHeadingId.value = current;
}

export function readScrollTop(): number {
  return scroller?.scrollTop ?? 0;
}
