import { ReplaceStep } from "prosemirror-transform";
import type { Transaction } from "prosemirror-state";

/**
 * 117：撤销粒度的**判据层**（纯函数，不起浏览器就能测）。
 *
 * PM 的 `history()` 自带「按时间 + 位置相邻合并」的分组：连续打字会并成一步，
 * 停顿超过 `newGroupDelay` 或改动不相邻就分成两步。这套默认行为对**打字**是对的，
 * 对**结构操作**是不够的 —— 粘一张表紧接着在同一个位置打字，
 * 在 PM 看来「相邻且没超时」，会被并进同一步，Ctrl+Z 一次把两件事一起撤回。
 *
 * 所以这里只回答一个问题：**这一笔事务是不是「用户在打字」**。
 * - 是 → 交给 PM 自己按时间合并（连续输入并一步、停顿分两步，正是验收要的）；
 * - 不是 → 调用方给它前后各补一个 `closeHistory`，让它自成一步。
 *
 * 判据刻意**不看节点名字**（116 的教训：按名字猜会漏），只看事务的几何形状：
 * 一步、且这一步是「纯文本的替换」，才算打字。
 */

/**
 * 合并窗口（毫秒）：停顿多久算「换了下一步」。
 *
 * 500ms 是工单建议的起点，实测手感：正常中文输入两字间隔 150~300ms，
 * 想清楚下一句再打通常 >700ms，所以 500 落在两者之间。
 * **后续任何模块要调这个数，改这里并回写 117 的完成记录，不许在别处各写一份。**
 */
export const HISTORY_GROUP_DELAY_MS = 500;

/** 显式声明「这一笔自成一步」（结构操作可以直接打，省得依赖形状判断） */
export const HP_STEP_META = "hpStep";

/** prosemirror-view 在 `dispatchPaste` / drop / cut 里打的标记（不是打字，要自成一步） */
const NON_TYPING_UI_EVENTS = new Set(["paste", "drop", "cut"]);

/** 这一笔是不是「纯文本输入 / 删除」 */
export function isTypingTransaction(tr: Transaction): boolean {
  if (tr.getMeta(HP_STEP_META) === true) return false;
  // 粘贴 / 拖入 / 剪切：哪怕内容是一串纯文本，也必须独立一步（验收明写「粘贴 → 独立一步」）
  const uiEvent = tr.getMeta("uiEvent");
  if (typeof uiEvent === "string" && NON_TYPING_UI_EVENTS.has(uiEvent)) return false;
  if (!tr.docChanged) return false;
  // 多步事务（比如一次粘贴里既有 replace 又有 mapping）不可能是「打字」
  if (tr.steps.length !== 1) return false;
  const step = tr.steps[0];
  // 标记步（加粗）、ReplaceAroundStep（块类型转换、列表拆分）都不是打字
  if (!(step instanceof ReplaceStep)) return false;
  const slice = step.slice;
  if (slice.openStart || slice.openEnd) return false; // 插拔了块边界
  if (!slice.content.size) return true; // 纯删除
  // **带 mark 的文字也算打字**：在粗体里连打五个字是一步，不是五步
  let textOnly = true;
  slice.content.forEach((node) => {
    if (!node.isText) textOnly = false;
  });
  return textOnly;
}
