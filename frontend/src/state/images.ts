import { getHost } from "../host";
import { imageExt, planImage, sha256Hex } from "../kernel/paste/images";
import { dirname, resolveFsPath } from "../kernel/paths";
import { activePath } from "./documents";

/**
 * 116：剪贴板图片 → 落盘。
 *
 * 三层各管一段，别再往一处堆：
 * - `kernel/paste/images.ts`：命名、序号、去重的**纯规则**（注入 exists 探针）；
 * - 这里：拿文档目录、读/写「本文档的 hash 索引」、真的调宿主写盘；
 * - `kernel/pm/pastePlugin.ts`：什么时候触发、往文档里插什么。
 *
 * 索引存在宿主的键值袋里（`pastedImages:<文档路径>`），
 * 不往用户的 `assets/` 里塞一个我们自己的清单文件 ——
 * 那是用户的目录，多出来的隐藏文件他既看不见也还得手动删。
 */

const indexKey = (docPath: string) => `pastedImages:${docPath}`;

export type SavedImage = {
  /** 写进正文的相对路径，如 `assets/20261015-093012-1.png` */
  relPath: string;
  /** 去重命中：磁盘上没有新增文件 */
  reused: boolean;
  hash: string;
};

/** 读本文档已有的 hash → 路径索引（坏 JSON 当空表处理，不能因为索引烂了就粘不上图） */
async function readIndex(docPath: string): Promise<Map<string, string>> {
  const h = await getHost();
  const raw = await h.getState(indexKey(docPath));
  const out = new Map<string, string>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out.set(k, v);
  } catch {
    return out;
  }
  return out;
}

async function writeIndex(docPath: string, index: Map<string, string>): Promise<void> {
  const h = await getHost();
  await h.setState(indexKey(docPath), JSON.stringify(Object.fromEntries(index)));
}

/**
 * 把剪贴板里的一张图片落到文档同级 `assets/`。
 *
 * 三种情况**必须抛错**而不是默默返回，否则正文里会出现指向空气的引用：
 * ① 文档从未保存过（没有基准目录）；② 不是认识的图片类型；③ 宿主写盘失败。
 */
export async function savePastedImage(file: File, now: Date = new Date()): Promise<SavedImage> {
  const docPath = activePath.value;
  if (!docPath) {
    throw new Error("这份文档还没有保存过，图片要先保存文档才能落到它同级的 assets/。");
  }
  const ext = imageExt(file.type, file.name);
  if (!ext) throw new Error(`不认识的图片类型「${file.type || file.name}」，先另存成 PNG/JPG 再粘。`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) throw new Error("剪贴板里的图片是 0 字节，没有写入。");
  const hash = await sha256Hex(bytes);

  const docDir = dirname(docPath);
  const index = await readIndex(docPath);
  const host = await getHost();
  const exists = async (rel: string) => {
    try {
      await host.stat(resolveFsPath(docDir, rel));
      return true;
    } catch {
      return false;
    }
  };

  const plan = await planImage({ ext, hash, now, known: index, exists });
  if (!plan.reused) {
    // writeFileBytes 对已存在的文件返回 false（不覆盖）。走到这里说明
    // stat 与写之间被人抢了同名文件 —— 换个序号重来，最多三次，绝不覆盖别人的图。
    let written = await host.writeFileBytes(resolveFsPath(docDir, plan.relPath), bytes);
    let attempt = 0;
    while (!written && attempt < 3) {
      attempt++;
      index.delete(hash); // 让 planImage 重新找空位而不是又命中旧记录
      const retry = await planImage({ ext, hash, now, known: index, exists });
      written = await host.writeFileBytes(resolveFsPath(docDir, retry.relPath), bytes);
      if (written) return { relPath: retry.relPath, reused: false, hash };
    }
    if (!written) throw new Error(`图片写入失败：${plan.relPath}`);
  }
  index.set(hash, plan.relPath);
  await writeIndex(docPath, index);
  return { relPath: plan.relPath, reused: plan.reused, hash };
}
