/**
 * 路径工具：Markdown 里的相对图片路径要按「文档所在目录」解析成绝对路径，
 * 再交给 host 换成可用 URL。
 *
 * 统一用正斜杠内部表示，Go 侧再 `filepath.FromSlash` 转回平台分隔符。
 */

export function toSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * 网络/内联资源 URL —— 这些不该被当成本地路径处理。
 *
 * 方案段必须是**两个以上**字符：`[a-z][a-z0-9+.-]*:` 会把 Windows 盘符
 * `C:/Users/...` 误判成 scheme（桌面端图片因此整个跳过解析，
 * 表现是图裂但没有任何网络请求）。加号后 `C:` 不再匹配，`https:` / `file:` 仍匹配。
 */
export function isExternalUrl(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i.test(src) || src.startsWith("#");
}

/** 本地绝对路径：`C:/...`、`/...`、`//server/share/...` */
export function isAbsoluteFsPath(p: string): boolean {
  const s = toSlashes(p);
  return /^[a-z]:\//i.test(s) || s.startsWith("/");
}

export function dirname(p: string): string {
  const s = toSlashes(p);
  const i = s.lastIndexOf("/");
  if (i <= 0) return i === 0 ? "/" : "";
  return s.slice(0, i);
}

export function basename(p: string): string {
  const s = toSlashes(p);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * 把 `./a.png`、`../img/b.png`、`sub/c.png` 解析为相对文档目录的绝对路径。
 * 处理 `.` 与 `..` 段；越出根目录时按根截断（不产生 `..` 形式的非法路径）。
 */
export function resolveFsPath(baseDir: string, rel: string): string {
  const base = toSlashes(baseDir).replace(/\/+$/, "");
  const parts = toSlashes(rel).split("/");
  const out: string[] = base ? base.split("/") : [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** `<img src>` 里的路径可能带 URL 编码（中文目录常见），先解码再拼路径 */
export function decodeSrc(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}
