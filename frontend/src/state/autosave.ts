import { ref } from "vue";
import { isDirty, saveTab, tabs, type Tab } from "./documents";
import { settings } from "./settings";

/**
 * 自动保存（007）：停止输入 N 毫秒后落盘，默认关闭。
 *
 * 三条硬要求：
 * - 关闭态与手动保存完全一致（这里直接不排程）；
 * - 连续快速输入只产生一次写盘（按标签防抖，不是按全局）；
 * - 退出/关标签前必须 flush，否则最后一次编辑会丢。
 */

const pending = new Map<string, ReturnType<typeof setTimeout>>();

export const autoSaveError = ref("");

export function scheduleAutoSave(tab: Tab) {
  if (!settings.autoSave) return;
  // 127：未命名文档**没有路径可写**，自动保存必须跳过它。
  // 不跳的话每停手 1 秒就在底栏冒一条「写入失败」，还把整个自动保存开关关掉 ——
  // 那等于用户新建了一张纸，反而把别的标签的自动保存弄坏了。
  if (!tab.path) return;
  const existing = pending.get(tab.id);
  if (existing) clearTimeout(existing);
  pending.set(
    tab.id,
    setTimeout(() => {
      pending.delete(tab.id);
      void saveTab(tab).then((r) => {
        if (!r.ok) {
          // 写失败（占用/只读）继续重试只会刷错误，先暂停并告诉用户
          settings.autoSave = false;
          autoSaveError.value = `${tab.name}：${r.error ?? "写入失败"}，已暂停自动保存`;
        }
      });
    }, settings.autoSaveDelayMs)
  );
}

export function cancelAutoSave(id: string) {
  const t = pending.get(id);
  if (t) {
    clearTimeout(t);
    pending.delete(id);
  }
}

/** 立即落盘所有挂起的写入；返回是否全部成功 */
export async function flushAutoSaves(): Promise<boolean> {
  const ids = [...pending.keys()];
  for (const id of ids) {
    const t = pending.get(id);
    if (t) clearTimeout(t);
    pending.delete(id);
  }
  let ok = true;
  for (const id of ids) {
    const tab = tabs.list.find((x) => x.id === id);
    if (!tab || !isDirty(tab)) continue;
    const r = await saveTab(tab);
    if (!r.ok) {
      ok = false;
      autoSaveError.value = `${tab.name}：${r.error ?? "写入失败"}`;
    }
  }
  return ok;
}

export function hasPendingAutoSave(): boolean {
  return pending.size > 0;
}
