/**
 * 116：剪贴板图片 → 落盘位置的**纯规划器**。
 *
 * 这里只有「叫什么名、落在哪、是不是已经存在同一张图」这三件事，
 * 不碰 host、不碰文件系统、不碰 ProseMirror —— 那三样在
 * `state/images.ts`（写入与索引）、`kernel/pm/pastePlugin.ts`（插入）与 Go 侧各一层。
 * 分成纯函数是因为验收里最难测的正是命名与序号：
 * 「同一秒连续粘两张不同图要 -1 -2」「同一张图粘两次只留一个文件」，
 * 用真的时间戳和真的磁盘测，会变成「看运气红不红」。
 */

import { tf } from "../../i18n";

/** 图片统一落进文档同级的 `assets/`（spec US-36 定的目录名） */
export const ASSETS_DIR = "assets";

/** mime → 扩展名；不是「认识的图片」返回 null（不认识的宁可不写，也别写出打不开的引用） */
export function imageExt(mime: string, name = ""): string | null {
  const byMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
  };
  const hit = byMime[(mime ?? "").toLowerCase()];
  if (hit) return hit;
  // 剪贴板里的截图有时只给名字不给类型
  const m = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.exec(name ?? "");
  if (!m) return null;
  return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
}

/** `20261015-093012`：本地时间的年月日时分秒（spec 的命名口径，不带时区也不补零成日期外的字段） */
export function imageStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** SHA-256 → hex（截前 16 位够用：这里只为「同一张图不留两份」，不是内容寻址存储） */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export type ImagePlan = {
  /** 写进正文的相对路径，如 `assets/20261015-093012-1.png` */
  relPath: string;
  /** 去重命中：不用写盘，正文引用已有那份 */
  reused: boolean;
};

/**
 * 这张图该落到哪。
 *
 * - `known`：**本文档范围内**的 hash → 相对路径（工单注记：跨文档不共享图片库）。
 *   命中且文件还在（`exists` 为真）才复用 —— 用户可能已经把那张图删了，
 *   这时候要当新图重新落一份，不能留一个指向空气的引用。
 * - 序号 `n` 从 1 起，撞上已有文件（同一秒粘了两张不同的图）就 +1。
 *   上限 999 是防御：真有 999 张同一秒的图片，宁可乐出报错，也别写出重复引用。
 *
 * `exists` 是异步的：真判据在宿主的文件系统上（`host.stat`），
 * 这里只接受一个注入的探针 —— 单测给内存 Set，桌面给 stat。
 */
export async function planImage(opts: {
  ext: string;
  hash: string;
  now: Date;
  known: Map<string, string>;
  exists: (relPath: string) => Promise<boolean>;
}): Promise<ImagePlan> {
  const { ext, hash, now, known, exists } = opts;
  const previous = known.get(hash);
  if (previous && (await exists(previous))) return { relPath: previous, reused: true };

  const stamp = imageStamp(now);
  for (let n = 1; n <= 999; n++) {
    const relPath = `${ASSETS_DIR}/${stamp}-${n}.${ext}`;
    if (!(await exists(relPath))) return { relPath, reused: false };
  }
  throw new Error(tf("image.seqOverflow", { stamp }));
}
