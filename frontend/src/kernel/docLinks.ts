/**
 * 137「插入文档链接」的路径换算。
 *
 * 单独一个纯函数模块，因为这一小段是整颗功能里**唯一会写进盘上那份文件、且肉眼难验**的部分：
 * 弹层里看着对、插进去打不开，是最差的失败。所以每条规则都有单测钉着。
 *
 * 口径（已定的，见 Q28）：**相对路径是相对"当前文件所在目录"**，
 * 不引入"工作区根"这种新概念 —— Markdown 的相对链接本来就是这个语义，
 * 按"根"算出来的链接换个目录打开就全断。
 */

/** 路径统一成正斜杠、去掉重复斜杠；保留开头的盘符 / 斜杠 */
export function norm(p: string): string {
  const s = (p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return s;
}

/** 去掉结尾的 `/`，但根目录 `/` 本身要保住（否则"从根算相对"会退化成绝对） */
function trimEnd(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s === "" && p.startsWith("/") ? "/" : s;
}

/** 所在目录（正斜杠，不带结尾斜杠）。`/a/b/c.md` → `/a/b`；`c.md` → `` */
export function dirOf(path: string): string {
  const p = trimEnd(norm(path));
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  return p.slice(0, i);
}

/** 文件名（含扩展名） */
export function baseName(path: string): string {
  const p = trimEnd(norm(path));
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** 去掉扩展名的文件名 —— 用作链接文字 */
export function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  // 开头的点不算扩展名（`.gitignore` 整名都是名字）
  return i > 0 ? name.slice(0, i) : name;
}

/** 盘符（`c:`）或根（`/`）；用于"跨盘就别算相对了"的判断 */
function volumeOf(p: string): string {
  const m = /^([a-zA-Z]:)\//.exec(p);
  return m ? m[1].toLowerCase() : p.startsWith("/") ? "/" : "";
}

/** 拆成不含根的前缀段 */
function segsOf(p: string): string[] {
  const v = volumeOf(p);
  const rest = v && v !== "/" ? p.slice(v.length) : p;
  return rest.split("/").filter((s) => s !== "");
}

/**
 * 从 `fromDir` 到 `toPath` 的相对路径（正斜杠）。
 *
 * 只有两种情况**退回绝对路径**，不硬凑一串 `../`：
 * ① 拿不到基准（当前文件未保存）；② 跨盘符（Windows 的 `C:` ↔ `D:`）。
 *
 * 曾经还有第三条"相对写法反而比绝对还长就用绝对"，实测是错的：
 * `/a/b` → `/a/c/d.md` 这种最常见的兄弟目录，相对 `../c/d.md`(10) 就比绝对(9) 长一个字符，
 * 结果同库互链全被写成了绝对路径 —— 换台机器就全断。**同库就该给相对**，
 * 丑不丑不是判断依据，能不能带走才是。
 */
export function relPath(fromDir: string, toPath: string): string {
  const from = trimEnd(norm(fromDir));
  const to = trimEnd(norm(toPath));
  if (!from || !to) return to;
  if (volumeOf(from) !== volumeOf(to)) return to;

  // Windows 的路径大小写不敏感：`C:/A` 和 `c:/a` 是同一个目录，
  // 按大小写敏感比就会算出一串没用的 `../`
  const ignoreCase = volumeOf(from) !== "" && volumeOf(from) !== "/";
  const eq = (a: string, b: string) => (ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b);

  const a = segsOf(from);
  const b = segsOf(to);
  let i = 0;
  while (i < a.length && i < b.length && eq(a[i], b[i])) i++;

  const up = a.length - i;
  const down = b.slice(i);
  const rel = [...Array(up).fill(".."), ...down].join("/");
  return rel || to; // 空 = 指向基准目录本身，相对写法没有意义，给绝对
}

/**
 * 链接目标里的转义。
 *
 * Markdown 的 `<destination>` 里空格会截断链接、`)` 会提前闭合、`#`/`?` 会被当片段与查询。
 * 只编码**这几类**：CJK、`-`、`_`、`.` 保持原样，链接才读得下去
 * （全 encodeURI 一遍，中文路径会变成一串 `%E5%AE%A1...`，没人看得懂）。
 */
export function encodeLinkTarget(p: string): string {
  return norm(p).replace(/[ %()#?\[\]]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** 组装成 Markdown 链接：`[文件名](路径)`，链接文字用**去扩展名**的文件名 */
export function mdLink(name: string, target: string): string {
  return `[${stemOf(name)}](${encodeLinkTarget(target)})`;
}

/**
 * 弹层要显示的两行：相对 + 绝对，以及最终会插进去的那串。
 * `fromDir` 为空（当前文件未保存）时相对那条给 null，UI 据此禁用。
 */
export interface LinkChoice {
  rel: string | null;
  abs: string;
  /** 选相对时插进文档的完整 Markdown */
  mdRel: string | null;
  /** 选绝对时插进文档的完整 Markdown */
  mdAbs: string;
}

export function buildLink(name: string, absPath: string, fromDir: string): LinkChoice {
  const abs = trimEnd(norm(absPath));
  const rel = fromDir ? relPath(fromDir, abs) : null;
  // relPath 在"不该算相对"时会退回绝对路径本身 —— 那就等于没有相对可选项
  const hasRel = !!rel && rel !== abs;
  return {
    rel: hasRel ? rel : null,
    abs,
    mdRel: hasRel ? mdLink(name, rel) : null,
    mdAbs: mdLink(name, abs),
  };
}

/** 按文件名的模糊匹配（大小写不敏感、支持"目录/名"里任一段命中） */
export function matchesQuery(rel: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = rel.toLowerCase();
  if (hay.includes(q)) return true;
  // 空格分词：`周报 成本` 要求两段都命中（顺序不限）
  return q.split(/\s+/).every((w) => w && hay.includes(w));
}
