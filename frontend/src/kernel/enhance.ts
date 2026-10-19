import type { Host } from "../host/types";
import { t, tf } from "../i18n";
import { settings } from "../state/settings";

/**
 * 阅读模式的「块级增强」：代码块工具条、图片失效占位与灯箱、`[TOC]` 目录。
 *
 * 都放在渲染之后的 DOM 层做，不去改 mdast —— 文档内容一个字节都不该因为
 * 只是「看」而被改动（保真优先）。
 */

const FOLD_THRESHOLD = 20;

export function enhanceCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll<HTMLPreElement>("pre"))) {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code || pre.parentElement?.classList.contains("hp-code")) continue;
    if (code.classList.contains("language-mermaid")) continue;

    const langClass = Array.from(code.classList).find((c) => c.startsWith("language-"));
    const lang = langClass?.slice("language.".length) ?? langClass?.replace("language-", "") ?? "text";
    const lines = (code.textContent ?? "").replace(/\n$/, "").split("\n");

    const box = document.createElement("div");
    box.className = "hp-code";
    box.dataset.lang = lang;

    const bar = document.createElement("div");
    bar.className = "hp-code__bar";

    const label = document.createElement("span");
    label.className = "hp-code__lang";
    label.textContent = lang;

    const ops = document.createElement("span");
    ops.className = "hp-code__ops";

    if (lines.length > FOLD_THRESHOLD) {
      box.classList.add("is-foldable", "is-folded");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "hp-code__fold";
      toggle.textContent = tf("code.expand", { n: lines.length });
      toggle.addEventListener("click", () => {
        const folded = box.classList.toggle("is-folded");
        toggle.textContent = folded ? tf("code.expand", { n: lines.length }) : t("code.collapse");
      });
      ops.appendChild(toggle);
    }

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "hp-code__copy";
    copy.textContent = t("code.copy");
    copy.addEventListener("click", async () => {
      // 复制的是原始代码文本，不含行号与工具条文字
      const ok = await copyText(code.textContent ?? "");
      copy.textContent = ok ? t("code.copied") : t("code.copyFailed");
      window.setTimeout(() => (copy.textContent = t("code.copy")), 1500);
    });
    ops.appendChild(copy);

    bar.append(label, ops);
    pre.classList.toggle("hp-code--numbered", settings.codeLineNumbers);
    pre.style.setProperty("--hp-code-lines", String(lines.length));

    // 顺序不能反：先把占位框换到 pre 的位置，再把 pre 装进去。
    // 反过来（先 append 再 replaceWith(box)）等于「把 box 换成它的子孙」，
    // 浏览器直接抛 DOMException，整个 hydrate 链路会从这里断掉
    // —— 表现是代码块工具条、TOC、灯箱全都不出现。
    pre.replaceWith(box);
    box.append(bar, pre);
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/**
 * 127：给一条错误提示挂「关闭」的叉（她：「做个叉放右边，点击关闭当前这个错误提示」）。
 *
 * 只关**当前这一条**，不是把提示机制哑掉：下一次渲染、下一张坏图照样会报。
 *
 * 藏起来用的是**行内 style**，不是 `hidden` 属性：坏图占位卡是 `display:inline-flex`、
 * 编辑模式错误块是 `display:block`（都带自己的选择器权重），
 * 作者规则的优先级压过 UA 的 `[hidden]{display:none}` —— 光设 `hidden` 会**看着没关掉**。
 * 行内样式能压过任何非 `!important` 的作者声明，所以两个都写：
 * `hidden` 给语义/无障碍，行内 style 给实际效果。
 */
export function addDismiss(box: HTMLElement, title = t("status.closeHint")): HTMLElement {
  const x = document.createElement("button");
  x.type = "button";
  x.className = "hp-dismiss";
  x.textContent = "×";
  x.setAttribute("title", title);
  x.setAttribute("aria-label", title);
  x.setAttribute("data-testid", "dismiss-error");
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    box.hidden = true;
    box.style.display = "none";
  });
  box.appendChild(x);
  return x;
}

/** 图片：加载失败换成占位块（带原始路径与复制），点击进灯箱 */
export function enhanceImages(root: HTMLElement, host: Host): void {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    if (img.dataset.hpBound === "1") continue;
    img.dataset.hpBound = "1";
    img.classList.add("hp-img");

    const origin = img.dataset.localPath ?? img.getAttribute("src") ?? "";

    img.addEventListener("error", () => {
      if (img.dataset.broken === "true") return;
      img.dataset.broken = "true";
      const ph = document.createElement("span");
      ph.className = "hp-img-broken";
      ph.setAttribute("title", origin);
      const name = origin.split(/[\\/]/).pop() ?? origin;
      const label = document.createElement("span");
      label.className = "hp-img-broken__label";
      label.textContent = tf("image.broken", { name });
      const path = document.createElement("code");
      path.className = "hp-img-broken__path";
      path.textContent = origin;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "hp-img-broken__copy";
      copy.textContent = t("image.copyPath");
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        void copyText(origin);
      });
      ph.append(label, path, copy);
      addDismiss(ph, t("status.closeHint"));
      img.replaceWith(ph);
    });

    img.addEventListener("click", () => {
      if (img.dataset.broken === "true") return;
      openLightbox(img.src, origin);
    });
    void host;
  }
}

/** `[TOC]` 段落换成可点击目录；锚点与大纲共用同一套 id（022） */
export function enhanceToc(root: HTMLElement): number {
  const targets = Array.from(root.querySelectorAll("p")).filter(
    (p) => (p.textContent ?? "").trim() === "[TOC]"
  );
  for (const p of targets) {
    const list = document.createElement("nav");
    list.className = "hp-toc";
    const title = document.createElement("div");
    title.className = "hp-toc__title";
    title.textContent = t("toc.title");
    const ul = document.createElement("ul");
    for (const h of Array.from(root.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]"))) {
      const li = document.createElement("li");
      li.className = "hp-toc__i";
      li.dataset.level = h.tagName.toLowerCase();
      const a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent ?? "";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const y = h.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12;
        const scroller = root.closest(".pane__scroller") ?? root.parentElement;
        if (scroller) scroller.scrollTop = Math.max(0, y);
        else h.scrollIntoView();
      });
      li.appendChild(a);
      ul.appendChild(li);
    }
    list.append(title, ul);
    p.replaceWith(list);
  }
  return targets.length;
}

/**
 * 灯箱：滚轮缩放、拖拽平移、Esc/遮罩关闭、一键回到适应尺寸。
 *
 * 127 把它从「只能装 `<img>`」改成能装任意节点 —— 她要的「大图（应用架构图那种）单独缩放」
 * 走的就是这条路：**点开大图里缩放 + 平移**，而不是在正文里给每张图加一套手势。
 * 理由说清楚：正文里 `Ctrl+滚轮` 已经是「整篇缩放」，再让「鼠标停在图上时滚轮只缩放这张」
 * 就成了同一个手势两种含义，得靠角标之类的反馈才不歧义；而她的原话诉求是「无法看到全貌」，
 * 看全貌对症的是**一块没有正文干扰的画布**，就地缩放只能看清局部（缩到能看全貌时字就糊了）。
 */
interface LightboxSpec {
  /** 放进灯箱的节点（图片元素，或 Mermaid SVG 的克隆） */
  node: HTMLElement | SVGElement;
  /** 底栏那行说明 */
  label: string;
  /** 复位按钮的名字：图片是「原始尺寸」，矢量图是「适应屏幕」 */
  resetLabel: string;
  /** 未缩放时的自然尺寸，用来算「适应窗口」 */
  size: () => { w: number; h: number };
  /**
   * 什么时候算第一次适应。图片的 `naturalWidth` 要等 `load`，
   * SVG 克隆是现成的 —— 不等 load 去量图片会拿到 0，一进来就糊满屏。
   */
  ready?: (run: () => void) => void;
}

function showInLightbox(spec: LightboxSpec): void {
  const mask = document.createElement("div");
  mask.className = "hp-lightbox";
  mask.dataset.testid = "lightbox";
  spec.node.classList.add("hp-lightbox__stage");
  mask.appendChild(spec.node);

  const bar = document.createElement("div");
  bar.className = "hp-lightbox__bar";
  const info = document.createElement("span");
  info.textContent = spec.label;
  const hint = document.createElement("span");
  hint.className = "hp-lightbox__hint";
  hint.textContent = t("lightbox.hint");
  const reset = document.createElement("button");
  reset.type = "button";
  reset.dataset.testid = "lightbox-fit";
  reset.textContent = spec.resetLabel;
  const close = document.createElement("button");
  close.type = "button";
  close.dataset.testid = "lightbox-close";
  close.textContent = t("lightbox.close");
  bar.append(info, hint, reset, close);
  mask.appendChild(bar);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => {
    spec.node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const fitToWindow = () => {
    const n = spec.size();
    const f = Math.min(1, (window.innerWidth * 0.9) / n.w, (window.innerHeight * 0.8) / n.h);
    scale = f || 1;
    tx = 0;
    ty = 0;
    apply();
  };
  const afterReady = (run: () => void) => (spec.ready ? spec.ready(run) : run());
  afterReady(fitToWindow);

  mask.addEventListener("wheel", (e) => {
    e.preventDefault();
    scale = Math.min(8, Math.max(0.1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    apply();
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  spec.node.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = (e as PointerEvent).clientX;
    lastY = (e as PointerEvent).clientY;
    (e.target as Element).setPointerCapture?.((e as PointerEvent).pointerId);
  });
  spec.node.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    tx += (e as PointerEvent).clientX - lastX;
    ty += (e as PointerEvent).clientY - lastY;
    lastX = (e as PointerEvent).clientX;
    lastY = (e as PointerEvent).clientY;
    apply();
  });
  spec.node.addEventListener("pointerup", () => (dragging = false));

  reset.addEventListener("click", fitToWindow);

  const destroy = () => {
    document.removeEventListener("keydown", onKey);
    mask.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") destroy();
  };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (e) => {
    if (e.target === mask) destroy();
  });
  close.addEventListener("click", destroy);

  document.body.appendChild(mask);
}

/** 图片灯箱（021 那条老路，行为一字不改） */
export function openLightbox(src: string, origin: string): void {
  const img = document.createElement("img");
  img.src = src;
  img.alt = origin;
  img.draggable = false;
  showInLightbox({
    node: img,
    label: origin.split(/[\\/]/).pop() ?? "",
    resetLabel: t("lightbox.reset"),
    size: () => ({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 }),
    ready: (run) => img.addEventListener("load", run, { once: true }),
  });
}

/**
 * 127：把一张 Mermaid 图放进灯箱。
 *
 * **克隆，不搬移**：原图必须留在文档里 —— 搬走的话正文会塌一个洞，
 * 而编辑模式下那张图还挂在 ProseMirror 的 NodeView 里，搬走等于动别人的 DOM。
 * 尺寸优先读 SVG 自己的 `width` / `viewBox`（124 起 `useMaxWidth:false`，
 * mermaid 给的是真实像素宽），量不到才退回 `getBoundingClientRect`。
 */
export function openSvgLightbox(svg: SVGSVGElement, label = t("lightbox.mermaidTitle")): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.style.transform = "";
  const natural = (): { w: number; h: number } => {
    const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    const attrW = Number(svg.getAttribute("width"));
    const rect = svg.getBoundingClientRect();
    const w = attrW > 1 ? attrW : vb[2] > 0 ? vb[2] : rect.width;
    const h = vb[3] > 0 ? vb[3] : rect.height;
    return { w: w || 1, h: h || 1 };
  };
  const n = natural();
  /*
   * 给克隆一份**明确的像素尺寸**并关掉两条 max-*：
   * 灯箱那条 `.hp-lightbox__stage { max-width:92vw; max-height:82vh }` 是给图片准备的，
   * 矢量图要是被它夹住，「适应屏幕」的倍率就叠在「浏览器已经替你缩过一次」上面 ——
   * 同一段路缩两次，滚轮加上去的手感会明显不对。缩放这件事只交给 transform 做。
   */
  clone.style.width = n.w + "px";
  clone.style.height = n.h + "px";
  clone.style.maxWidth = "none";
  clone.style.maxHeight = "none";
  showInLightbox({ node: clone, label, resetLabel: t("lightbox.fit"), size: () => n });
}
