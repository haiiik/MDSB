import { getHost, isDirty, saveTab, saveTabAs, tabs, type Tab } from "./documents";
import { confirm } from "./dialogs";
import { flushAutoSaves } from "./autosave";
import { autoSaveError } from "./autosave";
import { saveSession } from "./session";
import { settingsOpen } from "./settings";

/**
 * 退出流程（006 + 015 的交汇点）。
 *
 * 关闭按钮、原生 X / Alt+F4、以及 mock 的 windowClose 都走这里，
 * 保证「有未保存内容时一定先问」这条不变。
 */

/**
 * 退出时保存一个标签。
 * 127：未命名文档（`path === null`）没有「原地保存」这条路 —— 只能另存为，
 * 所以这里按有没有路径分流，与关标签、Ctrl+S 三处同一个口径。
 * 用户在原生保存对话框点「取消」返回 `已取消`：那是「我不退了」，不是错误，不要再弹一层错误框。
 */
async function saveOne(tab: Tab): Promise<{ ok: boolean; error?: string }> {
  return tab.path ? saveTab(tab) : saveTabAs(tab);
}

/** 返回 true 表示可以退出；false 表示用户取消 */
export async function confirmQuit(): Promise<boolean> {
  if (settingsOpen.value) settingsOpen.value = false;

  const flushed = await flushAutoSaves();
  if (!flushed) {
    await confirm({ title: "自动保存未完成", message: autoSaveError.value, actions: ["知道了"] });
  }

  const dirty = tabs.list.filter(isDirty);
  if (dirty.length > 0) {
    const choice = await confirm({
      title: "退出 MDStar",
      message:
        dirty.length === 1
          ? `「${dirty[0].name}」有未保存的改动。` +
            (dirty[0].path ? "" : "\n这份还没保存过，保存会先让你选存放位置。")
          : `有 ${dirty.length} 个标签存在未保存的改动：\n` + dirty.map((t) => "· " + t.name).join("\n"),
      actions: ["保存并退出", "丢弃并退出"],
    });
    if (choice === null) return false;
    if (choice === "保存并退出") {
      for (const t of dirty) {
        const r = await saveOne(t);
        if (!r.ok) {
          // 未命名文档在保存对话框里点了取消 = 不退了，安静地留在应用里
          if (r.error === "已取消") return false;
          await confirm({
            title: "保存失败，已中止退出",
            message: `${t.name}：${r.error ?? ""}`,
            actions: ["知道了"],
          });
          return false;
        }
      }
    }
  }

  await saveSession();
  const h = getHost();
  if (h) await h.windowQuit();
  return true;
}
