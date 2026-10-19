import { t, tf } from "../i18n";

/**
 * 136-A：阅读模式的脚注收尾。
 *
 * 解析与渲染本身 remark-gfm 已经做了（`[^a]` → 上标编号 + 文末 `<section data-footnotes>`，
 * 带 `↩` 回跳）。这一层只补三件它给不了的东西：
 *
 * 1. **标题本地化**：to-hast 写死的是英文 `Footnotes`，而且带 `sr-only`（视觉上不出现）。
 *    中文档里冒一个英文小标题、或者干脆看不见"下面这块是脚注"，都不合格。
 * 2. **回跳箭头的无障碍名**：同理，`aria-label="Back to reference 1"` 是英文写死的。
 * 3. **接管页内锚点点击**：浏览器默认行为会把 `#user-content-fn-a` 写进地址栏，
 *    阅读模式里点一下引用就把 URL 弄脏了（复制地址、前进后退都会中枪）。
 *    这里改成自己滚，并且指不到目标时**交回默认行为**，不吞外链、不吞未渲染的锚点。
 *
 * 编号口径：脚注的显示编号由 remark 按**定义出现顺序**算（`[^b]` 先引用、`[^a]` 后定义，
 * 编号仍按定义顺序）。本期不改这个映射，也不做"重新编号"（跨块重排会动到用户没碰的段落，
 * 与保真硬约束冲突，见工单 136 与 Q27）。
 */
export function decorateFootnotes(root: HTMLElement): void {
  const section = root.querySelector<HTMLElement>("section[data-footnotes], section.footnotes");
  if (!section) return;
  if (section.dataset.hpFn === "1") return; // 幂等：同一棵树重复收尾不叠加监听
  section.dataset.hpFn = "1";
  section.setAttribute("data-testid", "footnotes");

  const title = section.querySelector<HTMLElement>("h2");
  if (title) {
    // id 要留着 —— 每个引用的 aria-describedby 都指向它
    title.textContent = t("footnotes.title");
    title.classList.remove("sr-only");
    title.classList.add("hp-fn__title");
    title.setAttribute("data-testid", "footnotes-title");
  }

  for (const a of Array.from(root.querySelectorAll<HTMLElement>("a[data-footnote-ref]"))) {
    a.classList.add("hp-fn__ref");
    a.setAttribute("data-testid", "footnote-ref");
  }
  // 一条定义可能被多处引用，回跳箭头就有多个（`↩`、`↩²`）；按出现顺序编号进文案
  for (const [i, a] of Array.from(root.querySelectorAll<HTMLElement>("a[data-footnote-backref]")).entries()) {
    const label = tf("footnotes.backTo", { n: String(i + 1) });
    a.classList.add("hp-fn__back");
    a.setAttribute("data-testid", "footnote-backref");
    a.setAttribute("aria-label", label);
    a.setAttribute("title", label);
  }

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const a = target?.closest?.("a[href^='#']") as HTMLAnchorElement | null;
    if (!a || !root.contains(a)) return;
    const id = a.getAttribute("href")?.slice(1) ?? "";
    if (!id) return;
    const el = root.querySelector<HTMLElement>("#" + CSS.escape(decodeURIComponent(id)));
    if (!el) return; // 指不到就交回默认行为，别把链接点成"没反应"
    ev.preventDefault();
    // 不用 smooth：滚动动画会让"点完之后的 scrollTop"变成时序问题，断言和手感都不稳定
    el.scrollIntoView({ block: "start" });
    el.classList.add("is-fn-target");
    window.setTimeout(() => el.classList.remove("is-fn-target"), 1200);
  });
}
