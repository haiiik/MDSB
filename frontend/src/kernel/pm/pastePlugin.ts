import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { clipboardToMdast } from "../paste/clipboard";
import { imageExt } from "../paste/images";
import { mdastRootToNodes } from "./mdastToDoc";
import { placePastedBlocks } from "./tableCommands";

/** 116：一张剪贴板图片写盘之后要用的东西 */
export type PasteImageOptions = {
  /** 落盘并给出写进正文的相对路径；不传 = 这个宿主不接图片（单测里就不触发） */
  saveImage?: (file: File) => Promise<{ relPath: string }>;
  /** 落盘失败要说给用户的话（「文档还没保存过」这类，不能默默吞掉） */
  onImageError?: (message: string) => void;
};

/** 剪贴板里的文件是不是「认识的图片」 */
function pastedImages(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  return files.filter((f) => imageExt(f.type, f.name) !== null);
}

/**
 * 116：把图片作为**行内节点**插进当前选区。
 *
 * 顺序是先落盘、后插节点 —— 反过来就会出现「正文里有引用、文件不存在」。
 * 多张图之间用 hard_break 分隔（单元格里会退化成空格，见 115 的 Q2 实测）。
 * 光标在代码块里时直接拒绝：`code_block` 的内容是 `text*`，
 * 插进去会被 PM 静默丢掉，那时文件已经写盘、正文却没有引用，比报错更难查。
 */
async function insertPastedImages(
  view: import("prosemirror-view").EditorView,
  files: File[],
  opts: PasteImageOptions
): Promise<void> {
  const save = opts.saveImage;
  if (!save) return;
  const relPaths: string[] = [];
  try {
    for (const f of files) relPaths.push((await save(f)).relPath);
  } catch (e) {
    opts.onImageError?.(e instanceof Error ? e.message : String(e));
    return;
  }

  const { image, hard_break: hardBreak } = view.state.schema.nodes;
  if (!image) return;
  const inline: PMNode[] = [];
  relPaths.forEach((src, i) => {
    if (i && hardBreak) inline.push(hardBreak.create());
    inline.push(image.create({ src, alt: "", title: null }));
  });
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(inline), 0, 0)).scrollIntoView());
}

/**
 * 114 / 115 / 116：粘贴 → 文档的接线。
 *
 * 走 PM 的 `handlePaste`，**只从 `event.clipboardData` 取数据**，不碰 `navigator.clipboard` ——
 * 这样 E2E 注入的 `ClipboardEvent` 与真实 Ctrl+V 走的是同一条代码路径，测试才有意义
 * （注入契约见 114 工单，115/116 共用）。
 *
 * 分派顺序：
 * 1. 剪贴板里有图片文件 → 116：先落盘（哈希去重、时间戳序号），再插行内图片节点；
 * 2. 有 `text/html` → 走 HTML 转换（Excel 同时给 html+plain 时也走这条，信息更全）；
 * 3. 只有 `text/plain` 且含制表符 → 当 TSV 表格转（部分来源只给 plain）；
 * 4. 其余（普通文字）→ 返回 false，交回 PM 默认插入，**不触发任何转换**。
 *
 * 粘贴进来的块**没有源区间**（`srcFrom/srcTo` 为 null），这是 103 的例外分支：
 * 新块没有原文可拷，第一次保存时整块序列化，块外仍走逐字节拷回。
 */
export function richPastePlugin(opts: PasteImageOptions = {}): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return false;

        const images = opts.saveImage ? pastedImages(data) : [];
        if (images.length) {
          // 先问 schema：代码块这类「行内只收纯文本」的地方装不下图片。
          // 这一步必须在**同步的 handlePaste 里**做完 —— 落盘是异步的，
          // 等异步回调再检查，选区早已跟着用户的下一次点击跑了，判据就成了摆设
          // （更糟：文件已写出去、正文里却没有引用）。
          const imageType = view.state.schema.nodes.image;
          const parent = view.state.selection.$from.parent;
          if (!imageType || !parent.type.contentMatch.matchType(imageType)) {
            event.preventDefault();
            opts.onImageError?.(
              `光标当前位置（${parent.type.name}）放不下图片 —— 先把光标放到正文里再粘。`
            );
            return true;
          }
          // handlePaste 必须同步返回值，落盘是异步的 —— 先接住事件，
          // 成功后再 dispatch 事务（失败就什么都不动，只把原因说给用户）。
          event.preventDefault();
          void insertPastedImages(view, images, opts);
          return true;
        }

        const root = clipboardToMdast({
          html: data.getData("text/html"),
          text: data.getData("text/plain"),
        });
        if (!root) return false;

        const nodes = mdastRootToNodes(root.children);
        if (!nodes.length) return false;

        // 光标在表格里时，落点由 `placePastedBlocks` 决定（115）：
        // 一张表 → 并入；纯段落 → 行内投进格子；有块级结构 → 整组插到表下面。
        // 直接 replaceSelection 会让 PM 把宿主表从光标那行劈成两张（桌面实测抓到的缺陷）。
        const inTable = placePastedBlocks(view.state, nodes);
        if (inTable) {
          view.dispatch(inTable);
          return true;
        }

        view.dispatch(
          view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView()
        );
        return true;
      },
    },
  });
}
