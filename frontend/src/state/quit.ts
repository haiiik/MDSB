import { t, tf } from "../i18n";
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
    await confirm({ title: t("quit.autoSavePending"), message: autoSaveError.value, actions: [t("dialog.gotIt")] });
  }

  const dirty = tabs.list.filter(isDirty);
  if (dirty.length > 0) {
    // 139：按钮文案进字典之后，**判据不能再拿中文串当哨兵** —— 先把两个动作存成局部量，
    // 传进去和比出来用的是同一个值，切英文也不会认不出点的是哪颗。
    const saveAndExit = t("quit.saveAndExit");
    const discardAndExit = t("quit.discardAndExit");
    const choice = await confirm({
      title: t("quit.title"),
      message:
        dirty.length === 1
          ? tf("quit.dirtyOne", { name: dirty[0].name }) +
            (dirty[0].path ? "" : t("quit.dirtyNewNote"))
          : tf("quit.dirtyMany", { n: dirty.length, list: dirty.map((tab) => "· " + tab.name).join("\n") }),
      actions: [saveAndExit, discardAndExit],
    });
    if (choice === null) return false;
    if (choice === saveAndExit) {
      for (const tab of dirty) {
        const r = await saveOne(tab);
        if (!r.ok) {
          // 未命名文档在保存对话框里点了取消 = 不退了，安静地留在应用里
          if (r.error === "已取消") return false;
          await confirm({
            title: t("quit.saveFailedTitle"),
            message: tf("quit.saveFailedMsg", { name: tab.name, error: r.error ?? "" }),
            actions: [t("dialog.gotIt")],
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
