import { computed, ref } from "vue";
import { getHost } from "../host";
import { activeTab, setMode, type Mode } from "./documents";
import { t, tf } from "../i18n";

/**
 * 154 / 155 / 156：打印、导出 HTML、导出 PDF。
 *
 * 三条共用一个前提：**纸面（和导出件）用的是阅读档那份渲染**。
 * 编辑档的 DOM 里挂着 PM 的 `contentDOM`、光标、NodeView 的收起状态与"编辑源码"按钮，
 * 源码档是 CodeMirror 的虚拟滚动视图（没滚过的区域根本不在 DOM 里）——
 * 拿那两份去打印，得到的是"半篇文档 + 一堆控件"。所以先切到阅读档、等图渲完，再动手，
 * 完事把用户原来那一档切回去（119 保证切档不丢滚动/选区/撤销栈）。
 *
 * 导出 PDF 走的是**打印对话框里选「另存为 PDF」**，不是静默生成：
 * Wails v3 beta.24 在 Windows 上的 `Print()` 就是往 webview 里执行 `window.print()`
 * （`pkg/application/webview_window_windows.go:288`），WebView2 的打印界面自带
 * "Microsoft Print to PDF / 另存为 PDF"。要"点一下直接落一个 .pdf"得从 Go 侧调
 * WebView2 的 PrintToPdf COM 接口（Wails 没封装），那是另一颗工单的代价。
 */

/** 一次性提示（成功/失败都要出声：导出这种动作没有反馈就等于没做） */
export const outputNotice = ref("");
export const outputBusy = ref(false);
let noticeTimer: number | undefined;

export function say(text: string, ms = 4000): void {
  outputNotice.value = text;
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (outputNotice.value = ""), ms);
}

export const noticeVisible = computed(() => outputNotice.value !== "");

/** 等 Mermaid 渲完：还有 `pending` 的图就说明纸面会缺图 */
async function 等图渲完(上限毫秒 = 20_000): Promise<void> {
  const 起 = Date.now();
  for (;;) {
    const 未完 = document.querySelectorAll('.hp-mermaid[data-state="pending"]').length;
    if (未完 === 0) return;
    if (Date.now() - 起 > 上限毫秒) {
      // 超时也继续（可能是坏图卡在 pending），但要说一声：静默少图是最坏的结果
      say(t("output.mermaidTimeout"));
      return;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

/**
 * 切到阅读档、等渲染稳定，返回一个"把档位还原回去"的收尾函数。
 *
 * 为什么不用 `nextTick` 就够：换档时阅读档要重新走 hydrate（代码块工具条、`[TOC]`、
 * Mermaid、KaTeX 都是异步补的），Mermaid 还要等 `import("mermaid")` 那个 chunk。
 */
async function 进入纸面态(): Promise<() => void> {
  const tab = activeTab.value;
  const 原档: Mode = tab?.mode ?? "read";
  if (tab && 原档 !== "read") {
    setMode("read");
    // 等阅读档真的挂上（EditorPane 里阅读档不是异步组件，但 hydrate 是异步的）
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
  await 等图渲完();
  // 再让浏览器画一帧：换档当帧去 print 会拿到还没布局完的正文
  await new Promise((r) => setTimeout(r, 120));
  return () => {
    if (tab && 原档 !== "read") setMode(原档);
  };
}

/** 154：打印 */
export async function printDoc(): Promise<void> {
  if (outputBusy.value || !activeTab.value) return;
  outputBusy.value = true;
  const 还原 = await 进入纸面态();
  try {
    // WebView2 里 window.print() 会弹系统打印界面（含"另存为 PDF"）
    window.print();
  } finally {
    还原();
    outputBusy.value = false;
  }
}

/** 156：导出 PDF —— 同一条通道，区别只在**说清楚下一步做什么** */
export async function exportPdf(): Promise<void> {
  if (outputBusy.value || !activeTab.value) return;
  outputBusy.value = true;
  const 还原 = await 进入纸面态();
  try {
    say(t("output.pdfHint"), 30_000);
    window.print();
  } finally {
    还原();
    outputBusy.value = false;
  }
}

/**
 * 把当前文档的样式表收集成一段 CSS。
 *
 * Vite 在生产包里把 CSS 注成 `<style>` 标签（同源），所以能直接读 `cssRules`。
 * 跨源的表读不到会抛，跳过就是了 —— 我们现在没有跨源样式。
 */
function 收集样式(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const 规则 = sheet.cssRules;
      if (!规则) continue;
      for (const r of Array.from(规则)) {
        // @media print 那块是给打印用的，导出的 HTML 里也留着：别人拿去打印同样得到浅色纸面
        out.push(r.cssText);
      }
    } catch {
      /* 读不到就跳过，不因此中断导出 */
    }
  }
  return out.join("\n");
}

/** 图片转 base64（已定的口径：**单文件**，发给谁都不漏图） */
async function 内嵌图片(根: HTMLElement): Promise<{ 成功: number; 失败: number }> {
  let 成功 = 0;
  let 失败 = 0;
  const host = await getHost();
  for (const img of Array.from(根.querySelectorAll("img"))) {
    const 原路径 = img.dataset.localPath || "";
    const 要取 = 原路径 || img.getAttribute("src") || "";
    if (!要取) continue;
    try {
      const 址 = 原路径 ? await host.assetUrl(原路径) : 要取;
      const 响 = await fetch(址);
      if (!响.ok) throw new Error(String(响.status));
      // 有些静态服务器对不认识的路径不回 404，而是回 200 + 一个 HTML 回退页
      // （vite preview 就是这样）。那种"成功"当图片内嵌进去，导出件里就是一张永远转圈的图，
      // 比留着原地址更坏 —— 所以显式非图片的一律按失败算。
      const 型 = 响.headers.get("content-type") ?? "";
      if (型 && !型.startsWith("image/")) throw new Error(型);
      const 块 = await 响.blob();
      const 数据 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(块);
      });
      img.setAttribute("src", 数据);
      成功++;
    } catch {
      // 取不到就留着原样（多半本来就是坏图），但要在提示里报数
      失败++;
    }
  }
  return { 成功, 失败 };
}

/** 155：导出单文件 HTML */
export async function exportHtml(): Promise<void> {
  const tab = activeTab.value;
  if (!tab || outputBusy.value) return;
  outputBusy.value = true;
  const 还原 = await 进入纸面态();
  try {
    const 正文 = document.querySelector<HTMLElement>(".hp-doc");
    if (!正文) {
      say(t("output.failed"));
      return;
    }
    const 副本 = 正文.cloneNode(true) as HTMLElement;
    const { 成功, 失败 } = await 内嵌图片(副本);
    const 标题 = tab.name || "MDStar";
    const html =
      `<!DOCTYPE html>\n<html lang="zh" data-theme="light">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${转义(标题)}</title>\n<style>\n${导出基础样式()}\n${收集样式()}\n</style>\n</head>\n` +
      `<body class="hp-export">\n<div class="hp-doc">\n${副本.innerHTML}\n</div>\n</body>\n</html>\n`;
    const host = await getHost();
    const 目标 = await host.pickSaveAs(标题.replace(/\.md$/i, "") + ".html");
    if (!目标) return; // 按了取消，不是失败
    await host.writeFile(目标, html);
    say(失败 > 0 ? tf("output.htmlPartial", { ok: 成功, bad: 失败 }) : t("output.htmlDone"));
  } catch (e) {
    say(t("output.failed") + "：" + (e instanceof Error ? e.message : String(e)));
  } finally {
    还原();
    outputBusy.value = false;
  }
}

/** 标题里的尖括号要逃，否则文件名带 `<` 能把导出的 HTML 结构改掉 */
function 转义(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 导出件自带的一小段基础样式。
 *
 * 为什么不把界面那套 CSS 原样丢进去就完事：界面 CSS 里有几条是**为窗口布局服务**的
 * （`html,body{height:100%}`、`.hp-doc` 的 `overflow` 与居中、四档宽度），
 * 拿到普通浏览器里会让正文被裁在一屏里、滚不动。这里把那些压回来。
 */
function 导出基础样式(): string {
  return [
    "html,body{height:auto!important;overflow:visible!important;background:#fff;color:#2b2f36;}",
    "body{margin:0;padding:24px 16px 64px;}",
    ".hp-doc{max-width:860px;margin:0 auto;padding:0;zoom:1!important;}",
    ".topbar,.tabbar,.statusbar,.sidebar,.rail,.searchbar,.edit-toolbar,",
    ".hp-codebox__bar,.hp-code__bar,.hp-codebox__fold,.hp-codebox__zoom,.hp-mermaidbox__hint,",
    ".hp-mermaid__bar,.hp-dismiss{display:none!important;}",
  ].join("");
}
