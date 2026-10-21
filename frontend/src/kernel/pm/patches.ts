import type { Node as PMNode } from "prosemirror-model";
import { patch, serializeBlock, type BlockPatch } from "../blockPatch";
import { blockToMdast } from "./docToMdast";
import { contentEq } from "./schema";

/**
 * 103：`changedBlocks(oldDoc, newDoc, source)` —— 找出**真正变了的块**，
 * 换算成原文区间，交给 101 的 `patch` 做按块替换（D23）。
 *
 * 为什么不能只比长度或只比首尾：PM 的一次事务可能同时插入、删除、改写多处，
 * 而「整段中间区域」的粗判会把夹在中间的**未改动块**一起卷进重排 ——
 * 那正是 D23 要避免的静默规范化。所以这里做的是块序列对齐：
 * 先剥公共前缀 / 后缀，中间再跑一次 LCS，剩下的不匹配段才是要重排的块。
 */

type Kid = { node: PMNode; from: number | null; to: number | null };

function kidsOf(doc: PMNode): Kid[] {
  const out: Kid[] = [];
  doc.forEach((n) => out.push({ node: n, from: n.attrs?.srcFrom ?? null, to: n.attrs?.srcTo ?? null }));
  return out;
}

/** 把一段 PM 块节点序列化成 Markdown（块之间用空行分隔，与 remark 输出一致） */
function serializeRun(kids: Kid[]): string {
  return kids.map((k) => serializeBlock(blockToMdast(k.node) as never)).join("\n\n");
}

/** LCS 规模上限：超过就退化为「整段视为改动」，避免大文档重排时 O(n·m) 卡住输入 */
const LCS_CELL_CAP = 400_000;

function lcsMatches(a: Kid[], b: Kid[], aLo: number, aHi: number, bLo: number, bHi: number): [number, number][] {
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n <= 0 || m <= 0) return [];
  if (n * m > LCS_CELL_CAP) return [];

  // 标准 LCS DP，从后往前填表
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = contentEq(a[aLo + i].node, b[bLo + j].node)
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (contentEq(a[aLo + i].node, b[bLo + j].node)) {
      pairs.push([aLo + i, bLo + j]);
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * 编辑器改过一次之后，哪些原文块需要重排。
 *
 * 返回的区间满足 101 `patch` 的全部前置条件：升序、不重叠、落在原文之内。
 * 未改动的块**一定不出现**在这里 —— 这是「改一处只有那一处变」的机制保证。
 */
export function changedBlocks(oldDoc: PMNode, newDoc: PMNode, source: string): BlockPatch[] {
  const oldK = kidsOf(oldDoc);
  const newK = kidsOf(newDoc);

  // 1) 公共前缀 / 后缀
  let lo = 0;
  while (lo < oldK.length && lo < newK.length && contentEq(oldK[lo].node, newK[lo].node)) lo++;
  let hiOld = oldK.length;
  let hiNew = newK.length;
  while (hiOld > lo && hiNew > lo && contentEq(oldK[hiOld - 1].node, newK[hiNew - 1].node)) {
    hiOld--;
    hiNew--;
  }

  // 2) 中间段做块级对齐，得到「保持不动」的锚点
  const anchors = lcsMatches(oldK, newK, lo, hiOld, lo, hiNew);

  const patches: BlockPatch[] = [];
  let oi = lo;
  let ni = lo;

  const pushRegion = (oStart: number, oEnd: number, nStart: number, nEnd: number) => {
    const newRun = newK.slice(nStart, nEnd);
    if (newRun.length === 0 && oStart >= oEnd) return;

    const prev = oldK[oStart - 1];
    const next = oldK[oEnd];
    const first = oldK[oStart];
    const last = oldK[oEnd - 1];
    const run = serializeRun(newRun);

    if (oStart >= oEnd) {
      // 纯插入：区间取零长度，靠前后补的空行把自己和邻居分开
      const atPos = prev?.to ?? next?.from ?? source.length;
      const 前空行 = atPos > 0 ? "\n\n" : "";
      const 后空行 = atPos === 0 && source.length > 0 ? "\n\n" : "";
      patches.push({ from: atPos, to: atPos, md: 前空行 + run + 后空行 });
      return;
    }

    /*
     * 有旧块被替换 / 删除。
     *
     * 142：**边界只认「自己有源区间」的旧块**。无源块（粘贴进来的、142 补在末尾的那一行）
     * 在原文里占的字节我们指不出来，把邻居的边界当成它的边界就会**连邻居之间的空行一起替换掉**，
     * 而序列化器不会补那个空行（101 的口径：块区间不含前后空行）。
     * 实测症状：在末尾补出来的那一行打字，写出来是 `| 采油 | 12 |补一句` ——
     * 段落粘在表格最后一行上，整张表当场读坏。
     *
     * 而且**往外退要退到最近一个有源区间的邻居，不能只看紧挨着的那一个**：
     * 连着两块粘贴进来的块（或一块粘贴 + 末尾补的那行）都改过时，`prev.to` 与 `next.from` 也是 null。
     * 旧代码在这里直接兜到 0 或 `source.length`，等于把「区间外那些没原文的块」连它们的字节
     * 一起换掉 —— 那是**丢块**，比粘住更糟。所以：
     * 左边界退到 L 之后，`L 与区域之间的那些无源块` 必须重新序列化写回；右边界同理。
     * **代价要如实写**（review 提的，别把这条当成"绝对不动"）：这一串是**按当前 PM 状态重序列化**，
     * 不是逐字节搬回原文 —— 段落、标题这类逐字映射的块重序列化就是原来那串；
     * 表格若被别的编辑器改过列宽，会被我们顺手归一次列宽（与 111 的"改任一格子整块重排"同一条既定代价）。
     * 方向仍然比旧写法好：旧写法是**丢整块**。
     */
    let from = first?.from ?? null;
    let to = last?.to ?? null;
    const 补前空行 = from == null;
    let 补后空行 = false;

    let 前置: Kid[] = [];
    let 后置: Kid[] = [];
    if (from == null) {
      let p = oStart - 1;
      while (p >= 0 && oldK[p].to == null) p--;
      from = p >= 0 ? (oldK[p].to as number) : 0;
      前置 = oldK.slice(p + 1, oStart); // 这一段全是无源块：文本里有字节，但指不出区间
    }
    if (to == null) {
      let q = oEnd;
      while (q < oldK.length && oldK[q].from == null) q++;
      if (q < oldK.length) {
        to = oldK[q].from as number;
        补后空行 = true; // 区间右端停在**下一块开头**，中间那段空行被吃进来了，要补回去
        后置 = oldK.slice(oEnd, q);
      } else {
        // 一直到文件末尾：把末尾的空白留在区间外 ——
        // 「文件以换行结尾」这件事不是她改的，不该被这次替换顺手改掉。
        // 这条路上**不补后空行**：区间右端已经贴着最后一块的文字，补了就多两行空白。
        let t = source.length;
        while (t > from && /\s/.test(source[t - 1])) t--;
        to = t;
        后置 = oldK.slice(oEnd);
      }
    }
    // 纯删除时顺手吃掉后随的空行，别在文档里留一串无意义空白
    if (newRun.length === 0 && next?.from != null) to = next.from;

    const 段 = [前置.length ? serializeRun(前置) : "", run, 后置.length ? serializeRun(后置) : ""].filter(
      (s) => s !== ""
    );
    let md = 段.join("\n\n");
    if (补前空行 && from > 0) md = "\n\n" + md;
    /*
     * 判据用 `段.length`（这次到底有没有写下内容），**不能用 `md !== ""`**：
     * 上一行刚给 `md` 加过前导空行，纯删除时 `md` 就不是空串了，
     * 于是给一个"后面根本没有内容"的位置再补一段空行 ——
     * 实测删掉一个无源区间的中间块会留下 `甲段\n\n\n\n丙段`（双空行）。
     */
    if (补后空行 && 段.length) md = md + "\n\n";
    patches.push({ from, to, md });
  };

  for (const [ao, an] of anchors) {
    pushRegion(oi, ao, ni, an);
    oi = ao + 1;
    ni = an + 1;
  }
  pushRegion(oi, hiOld, ni, hiNew);

  return patches;
}

/** 便捷出口：一次事务后直接拿到新文本（104 的回写口径就是它） */
export function applyChanges(source: string, oldDoc: PMNode, newDoc: PMNode): { text: string; patches: BlockPatch[] } {
  const patches = changedBlocks(oldDoc, newDoc, source);
  // 复用 101 的实现，保证「恒等」「行尾」「越界检查」这些性质只有一份定义
  return { text: patch(source, patches), patches };
}
