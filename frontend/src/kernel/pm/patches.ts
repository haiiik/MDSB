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

    if (oStart < oEnd) {
      // 有旧块被替换 / 删除
      const first = oldK[oStart];
      const last = oldK[oEnd - 1];
      const from = first.from ?? oldK[oStart - 1]?.to ?? 0;
      let to = last.to ?? oldK[oEnd]?.from ?? source.length;
      // 纯删除时顺手吃掉后随的空行，别在文档里留一串无意义空白
      if (newRun.length === 0 && oldK[oEnd]?.from != null) to = oldK[oEnd].from as number;
      const md = serializeRun(newRun);
      patches.push({ from, to, md });
      return;
    }

    // 纯插入：区间取零长度，靠前后补的空行把自己和邻居分开
    const prev = oldK[oStart - 1];
    const next = oldK[oStart];
    const atPos = prev?.to ?? next?.from ?? source.length;
    const md = prev ? "\n\n" + serializeRun(newRun) : serializeRun(newRun) + "\n\n";
    patches.push({ from: atPos, to: atPos, md });
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
