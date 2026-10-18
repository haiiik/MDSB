import { flushAutoSaves, scheduleAutoSave, cancelAutoSave } from "./autosave";
import { bindHost, type Tab } from "./documents";
import { hooks } from "./documents";
import { clearSnapshotFor, scheduleSnapshot } from "./snapshot";
import { bindSettingsPersistence, settings } from "./settings";
import { bindThemePersistence } from "./view";
import type { Host } from "../host/types";

/**
 * 持久化接线。
 *
 * documents 只发「改了 / 存了 / 关了」三个事件，谁响应、怎么响应都集中在这里，
 * 避免 documents <-> autosave <-> snapshot 互相 import 成环。
 */

export function wirePersistence(h: Host) {
  bindHost(h);
  void bindSettingsPersistence(h.getState, h.setState, () => h.installLanguage());
  void bindThemePersistence(h.getState, h.setState);

  hooks.afterEdit = (tab: Tab) => {
    scheduleAutoSave(tab);
    scheduleSnapshot(tab);
  };
  hooks.afterSave = (tab: Tab) => {
    cancelAutoSave(tab.id);
    clearSnapshotFor(tab);
  };
  hooks.afterClose = (tab: Tab) => {
    cancelAutoSave(tab.id);
    /*
     * 127 修的真 bug（她踩到的：「关闭标签时丢弃了未保存内容，再打开程序又提示我发现未保存的内容」）：
     * 原来这里只 `stopSnapshot`（取消还没触发的定时器），**盘上那份快照没删**。
     * 于是「丢弃」只丢了一半 —— 标签关了，008 的崩溃快照还留着，
     * 下次启动 `scanRecoverable()` 一比：快照 ≠ 磁盘 → 又弹「发现未保存的内容」。
     * 关标签是**用户已经表过态**的动作（保存 / 丢弃 / 恢复提示在启动时就问过了），
     * 所以这份快照的语义已经失效，必须跟着清掉。`clearSnapshotFor` 内部就带 stopSnapshot。
     */
    clearSnapshotFor(tab);
  };
}

