import type { Host } from "../host/types";
import { enhanceCallouts, enhanceCodeBlocks, enhanceImages, enhanceToc } from "./enhance";
import { hydrateMath } from "./math";
import { hydrateMermaid } from "./mermaid";
import { decodeSrc, dirname, isAbsoluteFsPath, isExternalUrl, resolveFsPath } from "./paths";
import type { ThemeName } from "./render";

export interface HydrateOptions {
  theme: ThemeName;
  /** 当前文档的绝对路径；未保存文档传 null，此时相对图片无法解析 */
  sourcePath: string | null;
  host: Host;
}

/**
 * 把静态 HTML 里「需要宿主能力才能显示」的部分补活：本地图片、Mermaid 图。
 *
 * `render()` 保持同步且无副作用（spec §5.4 的接缝形状不能为了这两件事变形），
 * 异步增强单独一步，阅读模式与日后导出都调它。
 */
export async function hydrate(root: HTMLElement, opts: HydrateOptions): Promise<void> {
  await resolveImages(root, opts);
  enhanceCodeBlocks(root);
  enhanceToc(root);
  // 157：提示块（`> [!NOTE]`）。排在图片增强之前 —— 提示块里第一段的标记要剥掉，
  // 而 `enhanceImages` 会给图挂 error 监听，两者碰的是同一批子节点，先做形状再做监听少一类交叉。
  enhanceCallouts(root);
  enhanceImages(root, opts.host);
  await hydrateMermaid(root, { theme: opts.theme });
  // 138：公式。放最后一步是有意的 —— 它只在文档真有 `$…$` 时才动态取 KaTeX，
  // 而图片/代码/目录/图这些不依赖它，别让它把前面几步排在后面。
  await hydrateMath(root);
}

/**
 * 相对路径图片 -> host.assetUrl。
 *
 * 未保存的文档没有基准目录，网络/内联 URL 原样保留。
 * 图片加载失败的占位与点击放大在 021，这里只负责「路径解析对」。
 */
export async function resolveImages(root: HTMLElement, opts: HydrateOptions): Promise<number> {
  const baseDir = opts.sourcePath && !isExternalUrl(opts.sourcePath) ? dirname(opts.sourcePath) : "";
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  let rewritten = 0;

  for (const img of imgs) {
    const raw = img.getAttribute("src") ?? "";
    if (!raw) continue;
    img.loading = "lazy";
    // svgview 之类的片段标记去掉再判断
    const src = raw.split("#")[0];
    if (!src || isExternalUrl(raw)) continue;
    if (!baseDir && !isAbsoluteFsPath(src)) continue;

    const abs = isAbsoluteFsPath(src) ? decodeSrc(src) : resolveFsPath(baseDir, decodeSrc(src));
    img.dataset.localPath = abs;
    img.src = await opts.host.assetUrl(abs);
    rewritten++;
  }

  return rewritten;
}
