/**
 * 146-A / 161：**每张 Mermaid 图自己的缩放倍率**（编辑档与阅读档共用这一份表）。
 *
 * 要求（146-A）：「mermaid 图新增支持单独缩放，缩放功能放编辑功能右侧」；
 * 要求（161）：「阅读模式的 mermaid 加上缩放功能」—— 补的是同一个功能的另一档，不是第二套缩放。
 *
 * 四条口径：
 * 1. **倍率不进文档**：它是"怎么看"，写进 .md 就是污染原文（保真口径）。
 *    存在这张视图侧的表里，Ctrl+S 之后文件逐字节等于原文（E2E 与桌面判据都钉这一条）。
 * 2. **两档同一张图认同一个键**（161 新加这条）。不然「阅读档把这张图放大 → 切去编辑档又变回原样」，
 *    同一个功能两份状态，正是本项目反复躲的"两处真相"。
 *    146 那版按**源区间**存：编辑档自己换档能认回来，可阅读档根本拿不到区间
 *    （103 的源区间只贯穿到 ProseMirror 的块节点上，`render()` 那道接缝只吃 markdown 文本），
 *    两边凑不出同一个键。所以这里换成两边都算得出来的键：**标签页 + 这是文中第几张图**。
 * 3. **改源码不许把倍率打回 100%**：这一条是"为什么不用源码文本当键"的理由 ——
 *    159 的主流程就是"放大那张图，然后就地改一个字"，文本一换键就换，图会当场缩回去。
 *    序号在打字、改标题、增删别的块时都不变。
 *    代价如实写在这：**在上方新增或删除一张图，后面几张的倍率会跟着挪一格**。
 *    这是视图态本来就该有的代价（不做成文档内容），且认错的后果只是"某张图大小不对"，
 *    不是 159 那种"把名字改到没点的那一处"。
 * 4. **到顶 / 到底那一侧的键 disable**：「不可用的选项干脆不摆」在 146 落地的形式
 *    就是键还在原地、点不动（146 的判据钉的就是 `disabled`，不是 `hidden`）。
 *
 * 缩放作用在**渲染出来的那个图容器**（`.hp-mermaidbox__svg`）上，用 CSS `zoom` 而不是
 * `transform: scale`（146 实测：transform 不改布局盒，下面的正文不会被顶开，
 * 于是"缩放了却什么都没让开"，两档的观感也对不上）。
 */
import { t } from "../i18n";

/** 146-A 定的档位表；两档共用，别再在各处写一遍数字 */
export const 缩放档 = [0.3, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const 默认倍 = 1;

/** 键 = 标签页 + "#" + 第几张图（0 起）。序号为负 = 连"排第几"都没定下来 → 空键，从 100% 起。 */
export function 缩放键(标签页: string, 序号: number): string {
  return 序号 < 0 ? "" : 标签页 + "#" + 序号;
}

const 表 = new Map<string, number>();

export function 读倍率(键: string): number {
  if (!键) return 默认倍;
  const v = 表.get(键);
  return typeof v === "number" && 缩放档.includes(v) ? v : 默认倍;
}

export function 写倍率(键: string, 倍: number): void {
  if (键) 表.set(键, 倍);
}

/** 关标签页时把这篇的倍率清掉（键前缀 = 标签页 + 分隔符），别让上一个文件的倍率跟到下一个同名位置 */
export function 清倍率(标签页: string): void {
  if (!标签页) return;
  const 前 = 标签页 + "#";
  for (const k of Array.from(表.keys())) if (k.startsWith(前)) 表.delete(k);
}

/** 往某一侧走一档：取最近的一档；到头就返回原值（调用方据此 disable 那颗键） */
export function 下一档(倍: number, delta: 1 | -1): number {
  return delta > 0
    ? 缩放档.find((v) => v > 倍 + 1e-6) ?? 倍
    : [...缩放档].reverse().find((v) => v < 倍 - 1e-6) ?? 倍;
}

export interface 缩放控件 {
  /** 挂在功能栏上的那一组：`−  100%  +`，点倍率那格回 100% */
  dom: HTMLSpanElement;
  缩小: HTMLButtonElement;
  倍率: HTMLButtonElement;
  放大: HTMLButtonElement;
  /** 当前倍率（判据读这个，别去 parse 那格按钮的文字） */
  当前(): number;
  /** 从表里读回这张图的倍率，写到 `图()` 那个容器上，并刷新三颗键的读数 */
  刷新(): void;
}

/**
 * 造那一组键。文案走 i18n 现成的 `code.zoom*`（146 已有，161 不另造一份字）。
 *
 * `键` 是个函数不是字符串：增删图、换标签页之后要重新算一次，
 * 拿旧串当键就是把倍率挂到别张图上（159 定过的纪律：认错比改不动严重）。
 *
 * `testid` 由调用方给：编辑档沿用 146 那三颗的名字（`pm-mermaid-zoom*` —— E2E 与桌面判据钉的就是这串，
 * 改名会让一片判据红在"找不到元素"上），阅读档是新的 `rd-mermaid-zoom*`。
 */
export function 建缩放控件(o: {
  键: () => string;
  图: () => HTMLElement | null;
  testid: { 组: string; 缩小: string; 倍率: string; 放大: string };
}): 缩放控件 {
  const 组 = document.createElement("span");
  组.className = "hp-codebox__zoom";
  组.dataset.testid = o.testid.组;
  // 这一组不是正文：编辑档它是 NodeView 里内容区之外的东西，阅读档那条栏原本还标着 aria-hidden。
  组.setAttribute("contenteditable", "false");

  const 缩小 = document.createElement("button");
  const 倍率 = document.createElement("button");
  const 放大 = document.createElement("button");
  for (const b of [缩小, 倍率, 放大]) b.type = "button";
  缩小.textContent = "\u2212"; // 减号（U+2212），不是连字符
  缩小.dataset.testid = o.testid.缩小;
  缩小.title = t("code.zoomOut");
  放大.textContent = "+";
  放大.dataset.testid = o.testid.放大;
  放大.title = t("code.zoomIn");
  倍率.dataset.testid = o.testid.倍率;
  倍率.title = t("code.zoomReset");
  组.append(缩小, 倍率, 放大);

  let 倍 = 默认倍;

  function 画(): void {
    const 图 = o.图();
    if (图) 图.style.zoom = String(倍);
    倍率.textContent = Math.round(倍 * 100) + "%";
    缩小.disabled = 倍 <= 缩放档[0];
    放大.disabled = 倍 >= 缩放档[缩放档.length - 1];
  }

  function 走(delta: 1 | -1): void {
    const 目标 = 下一档(倍, delta);
    if (目标 === 倍) return;
    倍 = 目标;
    写倍率(o.键(), 倍);
    画();
  }

  /*
   * `mousedown` 挡默认行为（159 片 2 踩过的那条）：这组键在编辑档挨着"双击改字"那块，
   * 按下键会把焦点送出编辑区，而本项目的口径是**失焦即提交** —— 不挡的话点一次键先写盘一次。
   * 阅读档没有编辑区，同一条挡住也不亏。
   */
  组.addEventListener("mousedown", (e) => e.preventDefault());
  缩小.addEventListener("click", (e) => {
    e.preventDefault();
    走(-1);
  });
  放大.addEventListener("click", (e) => {
    e.preventDefault();
    走(1);
  });
  倍率.addEventListener("click", (e) => {
    e.preventDefault();
    倍 = 默认倍;
    写倍率(o.键(), 倍);
    画();
  });

  return {
    dom: 组,
    缩小,
    倍率,
    放大,
    当前: () => 倍,
    刷新() {
      倍 = 读倍率(o.键());
      画();
    },
  };
}
