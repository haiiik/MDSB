import type { Element, Root } from "hast";
import { t } from "../i18n";

/**
 * 138-A：公式（KaTeX）。
 *
 * **架构上跟 Mermaid 同一条路子，不是随手加的**：
 * `render()` 必须保持同步（spec §5.4 的接缝形状，`hydrate.ts` 顶部也钉着这条），
 * 而 KaTeX 是 250KB 级的运行时 —— 静态 import 会把它拖进主入口，
 * 每篇**没有公式的文档**都要为它付解析成本，这正好撞在 121/123 那条冷启动纪律上。
 * 所以分两步：
 * ① `md.ts` 的 handler 只产出**占位元素**，里面就是原文 `$x^2$`（未水合时用户看得见源码，
 *    不是空白，也不影响查找/统计那几条押正文文本的判据）；
 * ② `hydrate()` 里 `hydrateMath()` 动态 import KaTeX 后原地替换。
 *
 * 安全边界：**不许为了 KaTeX 打开 `allowDangerousHtml`**（004 收紧的闸）。
 * 做法是把 KaTeX 生成的 HTML 用 `hast-util-from-html` 解析成**真 hast 元素**再交给
 * `hast-util-to-html`，全程没有 raw 节点进树 —— 用户文档里的裸 HTML 依旧被丢弃。
 */

/** KaTeX 的模块形状（只写我们用的那一个方法，省得 `typeof import` 在两种加载态下打架） */
interface KatexLike {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

/** 惰性加载到的三件东西一起缓存；CSS 由 Vite 随 chunk 注入 */
type MathRuntime = {
  katex: KatexLike;
  fromHtml: (html: string, opts: { fragment: true }) => Root;
};

let runtime: MathRuntime | null = null;
let loading: Promise<MathRuntime | null> | null = null;

/**
 * 动态取 KaTeX（JS + CSS + HTML 解析器）；幂等，多次调用只取一次。
 *
 * **为什么连样式与 `hast-util-from-html` 也走这里**：
 * ① 静态 import 会把 KaTeX 的 CSS 与字体映射钉进主样式表，而 JS 却是懒的 —— 半套加载更难受；
 * ② `hast-util-from-html` 背后是 parse5，**静态引一次就把约 180KB 塞进主入口**
 * （实测主入口从 328KB 涨到 509KB，第一版就是这么胖的，`@perf 冷启动分包` 只查 PM/CM 的串，
 * 这类"没人会想到"的依赖它看不见），
 * 每篇没有公式的文档都得为它付冷启动成本 —— 与 KaTeX 本体同一个理由。
 *
 * **注入顺序的连带后果**（必须知道）：动态 chunk 的 CSS 排在 `reading.css` **之后**，
 * 同权重的选择器会反过来压我们。所以覆盖 KaTeX 一律靠**更高权重**而不是靠顺序 ——
 * 例如压掉块级外边距那条写的是 `.hp-doc .hp-math--block .katex-display`（三个类），
 * 不是 `.katex-display`（一个类）。哪天有人把前缀删了，公式上下会突然多出一大截空白，
 * 症状离根因很远，所以在这里先写明白。
 */
async function getRuntime(): Promise<MathRuntime | null> {
  if (runtime) return runtime;
  if (!loading) {
    loading = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
      import("hast-util-from-html"),
    ])
      .then(([k, , f]) => {
        const rt: MathRuntime = {
          katex: (k as { default?: KatexLike }).default ?? (k as unknown as KatexLike),
          fromHtml: f.fromHtml as MathRuntime["fromHtml"],
        };
        runtime = rt;
        return rt;
      })
      // 加载失败（磁盘上 chunk 缺失、WebView2 抽风）不能把整页渲染拖崩：
      // 占位本来就显示原文，返回 null 就等于"停在原文态"，下一次再试。
      .catch(() => {
        loading = null;
        return null;
      });
  }
  return loading;
}

/** 预热并拿到运行时；调用方不关心句柄时用它（e2e / 需要 await 落地的地方） */
export async function ensureMath(): Promise<void> {
  await getRuntime();
}

/**
 * 测试入口：拿运行时句柄给 `renderMath` 用。
 * （`renderMath` 刻意不从模块全局"顺便"取运行时 —— 那样测试里会出现
 * 「还没加载所以每条都返回 ok:false」这种假绿/假红，句柄显式传进去才看得见前提。）
 */
export const loadMathRuntime = getRuntime;

/** 已经加载好（测试与调用方用它判断"现在能不能同步渲"） */
export function mathReady(): boolean {
  return runtime !== null;
}

export type MathResult = { ok: true; html: string } | { ok: false; error: string };

/**
 * 纯字符串进 / 出（`rt` 由调用方从 `getRuntime()` 拿，模块内不留可全局变的"已加载"状态）。
 *
 * 坏公式**报得出错**，不是 `throwOnError:false` 那片看不清的红字 ——
 * 与 004 给 Mermaid 定的「失败时保留原文且仍可读」同一条口径，所以这里要 `throwOnError:true` 逼它抛。
 *
 * `output` 用 KaTeX 默认的 `htmlAndMathml`：那层 MathML 是给读屏用的，
 * 只留 html 会「看着漂亮、听不见内容」，无障碍上算退化。
 */
export function renderMath(rt: MathRuntime | null, src: string, display = false): MathResult {
  if (!rt) return { ok: false, error: "KaTeX 尚未加载" };
  try {
    return {
      ok: true,
      html: rt.katex.renderToString(src, { displayMode: display, throwOnError: true, strict: "ignore" }),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `md.ts` 用的占位节点（同步、不碰 KaTeX）。
 *
 * 原文（带定界符）直接当文字内容放进去，`data-math-src` 存给水合那一步；
 * 类名里的 `hp-math--pending` 是「还没渲出来」的状态标记，
 * 判据与样式都押我们自己的钩子，不押 KaTeX 内部类名（那是它的实现细节）。
 *
 * **属性值走 `encodeURIComponent`，不是随手加的保险**：
 * `hast-util-to-html` 在 `characterReferences:{useNamedReferences:true}` 下
 * 会转义属性值里的 `"`（出不了属性，所以原本也不算 XSS），
 * 但 `<` 与 `>` 是**原样留在值里**的 —— 于是渲染产物里会出现
 * `data-math-src="<script>alert(1)</script>"` 这种串，
 * 任何人拿「输出里不许有 `<script`」当安全判据都会在这里误判（我第一次就误判了）。
 * 编码一次之后：值里只剩字母数字与 `%`，判据能写成干净的、并且
 * **将来若有人把阅读模式的 HTML 原样导出/嵌进别的模板，也不用重新论证一次转义**。
 * 代价只是水合时多一次 `decodeURIComponent`，而这份源码从不落盘、不进她文件。
 */
export function mathPlaceholder(src: string, display: boolean): Element {
  const fence = display ? "$$" : "$";
  return {
    type: "element",
    tagName: display ? "div" : "span",
    properties: {
      className: ["hp-math", display ? "hp-math--block" : "hp-math--inline", "hp-math--pending"],
      "data-testid": "hp-math-src",
      "data-math-src": encodeURIComponent(src),
      "data-math-display": display ? "1" : "0",
    },
    children: [{ type: "text", value: fence + src + fence }],
  };
}

/**
 * 水合失败时的降级节点：**原文仍然可见**，只是标成错误态。
 * 与占位的区别只在类名与 title —— 她至少能看见自己写了什么、并知道为什么没渲出来。
 */
function mathErrorPlaceholder(src: string, display: boolean, error: string): Element {
  const p = mathPlaceholder(src, display);
  p.properties = {
    ...p.properties,
    className: [...(p.properties?.className as string[]).filter((c) => c !== "hp-math--pending"), "hp-math--error", "hp-math-error"],
    "data-testid": "hp-math-error",
    title: t("math.errorTip") + firstLine(error),
  };
  return p;
}

/** 属性里的百分号编码解回来；坏编码（手改过的 HTML）不抛，退回原文 */
function decodeSource(el: HTMLElement): string {
  const raw = el.getAttribute("data-math-src") ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 错误消息可能多行（KaTeX 会把「出错位置」再铺一段），提示里只要第一句 */
function firstLine(s: string): string {
  return s.split("\n")[0].trim();
}

/*
 * **块级不要"顺手把 KaTeX 的 `.katex-display` 那层拆掉"。**
 * 第一版写了这样一个 unwrap，理由是"外面已经包了一层 div，少叠一份外边距" ——
 * 测试当场红了：`.katex-display` 不只是外边距，KaTeX 的居中与
 * `.katex-display > .katex { white-space: nowrap }` 全部押在这个类名上，
 * 拆掉等于把排版交给我们没读过的规则表。
 * 正确做法：外层 div 只当**我们自己的样式钩子**（`.hp-math--block`），
 * 里层结构保持 KaTeX 原样；间距嫌大就在我们的 CSS 里写 `.hp-math--block .katex-display { margin: … }`，
 * 别动树。（这条是 138-A 实测踩出来的，见工单 138。）
 */

/**
 * 把渲染树里所有 `.hp-math--pending` 换成 KaTeX 产出。
 *
 * 幂等：只处理带 `hp-math--pending` 的节点，成功就摘掉这个类名，
 * 所以同一棵树反复水合不会叠加，也不会重渲已经好的公式。
 * 返回处理了几个（调用方的判据与日志都要这个数）。
 */
export async function hydrateMath(root: HTMLElement): Promise<number> {
  const pending = Array.from(root.querySelectorAll<HTMLElement>(".hp-math--pending"));
  if (!pending.length) return 0; // **没公式的文档一行 JS 都不多跑**，这是整条链路的本意
  const rt = await getRuntime();
  if (!rt) return 0; // 动态 chunk 取不到（磁盘缺文件 / WebView2 抽风）时**停在原文态**，不炸整页
  let done = 0;
  for (const el of pending) {
    const src = decodeSource(el);
    const display = el.getAttribute("data-math-display") === "1";
    const r = renderMath(rt, src, display);
    if (!r.ok) {
      const node = mathErrorPlaceholder(src, display, r.error);
      const dom = hastToDom(node);
      if (dom) el.replaceWith(dom);
      done++;
      continue;
    }
    // KaTeX 的产出解析成真 DOM 再插入：与 md.ts 那侧同一个理由（不开 allowDangerousHtml，
    // 也全项目不在用户可见内容上写 innerHTML）
    const frag: Root = rt.fromHtml(r.html, { fragment: true });
    el.classList.remove("hp-math--pending");
    // testid 从「占位待水合」换成「已渲出来」：判据要能区分这两态，
    // 否则"水合根本没跑"与"水合跑了"在 DOM 上长得一样（第一次跑 e2e 就是这么静默过去的）。
    el.setAttribute("data-testid", "hp-math");
    el.textContent = "";
    for (const child of frag.children) {
      const dom = hastToDom(child);
      if (dom) el.append(dom);
    }
    done++;
  }
  return done;
}

/**
 * hast（元素 / 文本）→ DOM。不写 innerHTML，逐个节点建。
 *
 * **`raw` / `comment` / `doctype` 一律返回 null 不进 DOM**：
 * KaTeX 的产出里本来就没有这几类（`fromHtml(..., {fragment:true})` 只给元素与文本），
 * 但如果哪天有，`raw` 就是"绕过 allowDangerousHtml 的后门"，这里宁可直接丢掉。
 */
function hastToDom(node: Root["children"][number]): Node | null {
  if (node.type === "text") return document.createTextNode(node.value);
  if (node.type !== "element") return null;
  const el = document.createElement(node.tagName);
  for (const [k, v] of Object.entries(node.properties ?? {})) {
    if (k === "className") el.className = (v as string[]).join(" ");
    else el.setAttribute(k, String(v));
  }
  for (const c of node.children) {
    const child = hastToDom(c);
    if (child) el.append(child);
  }
  return el;
}
