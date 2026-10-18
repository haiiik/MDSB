<script setup lang="ts">
import { t as msg, tf } from "./i18n";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getHost } from "./host";
import type { Host, HostInfo } from "./host/types";
import {
  activate,
  closeTab,
  createUntitled,
  globalError,
  isDirty,
  openPath,
  openWithDialog,
  saveActiveAs,
  saveTab,
  saveTabAs,
  tabError,
  tabs,
} from "./state/documents";
import { confirm } from "./state/dialogs";
import { closeSearch, openSearch, search as searchState } from "./state/search";
import { settingsOpen } from "./state/settings";
import { autoSaveError } from "./state/autosave";
import { scanRecoverable, clearSnapshotFor } from "./state/snapshot";
import { restoreSession, saveSession } from "./state/session";
import { wirePersistence } from "./state/persistence";
import { confirmQuit } from "./state/quit";
import { bindPanelPersistence } from "./state/panel";
import { perf, signalReady } from "./kernel/perf";
import { refreshRecent } from "./state/recent";
import TopBar from "./components/TopBar.vue";
import TabBar from "./components/TabBar.vue";
import SideBar from "./components/SideBar.vue";
import EditorPane from "./components/EditorPane.vue";
import StatusBar from "./components/StatusBar.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import SettingsDialog from "./components/SettingsDialog.vue";

const host = ref<Host | null>(null);
const info = ref<HostInfo | null>(null);
const error = ref("");

/** 127：底栏那条错误提示的叉 —— 只关当前这条（自动保存真又失败时会重新报，不会哑掉） */
function dismissBarError(): void {
  error.value = "";
  autoSaveError.value = "";
}

/**
 * 保存一份标签：**有路径走落盘，没路径（未命名）走另存为**。
 * 127 新增标签之后，「保存」这一句话有两种落法，三处调用点（Ctrl+S、关标签、退出）必须同一套，
 * 否则会出现「关标签问我要不要保存、我点保存、它回我一句『该文档还没有路径』」。
 * `error === "已取消"` 是用户在原生对话框里点了取消 —— 那不是失败，调用方不要弹错误。
 */
async function saveAny(tab: (typeof tabs.list)[number]): Promise<{ ok: boolean; error?: string }> {
  return tab.path ? saveTab(tab) : saveTabAs(tab);
}

/** 关闭标签：脏则先问「保存 / 丢弃 / 取消」（006） */
async function requestCloseTab(id: string) {
  const tab = tabs.list.find((t) => t.id === id);
  if (!tab) return;
  if (!isDirty(tab)) {
    closeTab(id);
    return;
  }
  const choice = await confirm({
    title: msg("dialog.unsavedTitle"),
    message:
      tf("dialog.unsavedMsg", { name: tab.name }) +
      // 127（她：「关闭时让重命名文件，或者用另存」）：未命名档的「保存」其实是选位置 + 起名，
      // 按钮上就该说出来，别让人以为按下去会像普通文档那样原地存好。
      (tab.path ? "" : msg("dialog.unsavedNewNote")),
    actions: [tab.path ? msg("dialog.save") : msg("dialog.saveAsName"), msg("dialog.discard")],
  });
  if (choice === null) return;
  if (choice === msg("dialog.discard")) {
    closeTab(id);
    return;
  }
  const r = await saveAny(tab);
  if (r.ok) closeTab(id);
  // 另存为被取消 = 用户改主意了，标签留着继续编辑，不报「保存失败」
  else if (r.error !== "已取消") {
    await confirm({ title: msg("dialog.saveFailed"), message: r.error ?? msg("dialog.unknownError"), actions: [msg("dialog.gotIt")] });
  }
}

/** 崩溃恢复（008）：逐个询问，恢复即把快照内容写进标签并标脏 */
async function offerRecovery(h: Host) {
  const items = await scanRecoverable();
  for (const item of items) {
    const choice = await confirm({
      title: msg("dialog.recoverTitle"),
      message: item.fileMissing
        ? tf("dialog.recoverMissing", { name: item.name })
        : tf("dialog.recoverDiff", { name: item.name }),
      actions: [msg("dialog.restore"), msg("dialog.discard")],
    });
    if (choice === msg("dialog.restore")) {
      const existing = tabs.list.find((t) => t.path === item.path);
      if (existing) {
        existing.markdown = item.content;
        activate(existing.id);
      } else {
        await openPath(item.path);
        const t = tabs.list.find((x) => x.path === item.path);
        if (t) t.markdown = item.content;
      }
      // 恢复后仍视为未保存，快照留着直到用户真的存盘
    } else {
      const t = tabs.list.find((x) => x.path === item.path);
      if (t) clearSnapshotFor(t);
      else await h.clearSnapshot(item.path).catch(() => undefined);
    }
  }
}

/** 取空宿主的待打开队列（启动参数 / 拖放 / 第二实例都汇到这里） */
async function drainStartup(h: Host) {
  const paths = await h.takeStartupFiles();
  for (const p of paths) {
    const ok = await openPath(p);
    if (!ok) globalError.value = tf("open.cannotOpen", { name: p.split(/[\\/]/).pop() ?? p });
  }
}

/** 拖放高亮：桌面端真实路径由 Go 事件给出，这里只负责视觉反馈 */
const dropping = ref(false);
const dropRejected = ref("");
let dragDepth = 0;

function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  dragDepth++;
  dropping.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropping.value = false;
}
function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
}
function onDrop() {
  dragDepth = 0;
  dropping.value = false;
  dropRejected.value = "";
  // 非 md 的拒绝提示：mock 在页面内就能判定；桌面由 Go 侧过滤后静默丢弃，
  // 这里补一句可见反馈，避免用户拖了没反应以为坏了
  window.setTimeout(() => {
    if (tabs.list.length === 0) dropRejected.value = msg("drop.onlyMarkdown");
  }, 250);
}

async function onKeydown(e: KeyboardEvent) {
  // 118：Esc 关查找条。查找条自己会 stopPropagation，
  // 所以走到这里的是「焦点不在条上」的那一类（比如焦点在正文里按 Esc）。
  if (e.key === "Escape" && searchState.open) {
    closeSearch();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === "o" && !e.shiftKey) {
    e.preventDefault();
    await openWithDialog();
  } else if (key === "t") {
    // 127：新增标签的键盘入口（与标签栏那颗「+」同一个动作，`createUntitled` 里会复用空标签）
    e.preventDefault();
    createUntitled();
  } else if (key === "f") {
    // 118：接管浏览器自带的查找条（WebView2 里它找的是整个页面，含外壳按钮文字）
    e.preventDefault();
    openSearch(false);
  } else if (key === "h") {
    e.preventDefault();
    openSearch(true);
  } else if (key === "s" && e.shiftKey) {
    e.preventDefault();
    const r = await saveActiveAs();
    if (!r.ok && r.error && r.error !== "已取消") {
      await confirm({ title: msg("dialog.saveAsFailed"), message: r.error, actions: [msg("dialog.gotIt")] });
    }
  } else if (key === "s") {
    e.preventDefault();
    const t = tabs.list.find((x) => x.id === tabs.activeId);
    if (!t) return;
    // 未命名文档按 Ctrl+S = 走另存为（这是它唯一的落盘方式），不是报一句「还没有路径」
    const r = await saveAny(t);
    if (r.ok) tabError.delete(t.id);
    else if (r.error !== "已取消") {
      await confirm({ title: "保存失败", message: r.error ?? "未知错误", actions: ["知道了"] });
    }
  } else if (key === ",") {
    e.preventDefault();
    settingsOpen.value = true;
  }
  /*
   * 这里**没有** Ctrl+1/2/3 切模式，是刻意的：D18 定了「模式切换不占键」（US-08 同一条）。
   * 示例文档里那张 模式/Ctrl+2 的表是**演示内容**，不是快捷键契约，别拿它当依据往外壳上加绑定。
   */
}

let offCloseRequest: (() => void) | null = null;
let beforeUnloadHandler: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  try {
    const h = await getHost();
    host.value = h;
    wirePersistence(h);
    info.value = await h.info();

    // 先取随进程带进来的路径，再订阅后续信号：事件可能早于前端挂载
    await drainStartup(h);
    h.onStartupSignal(() => void drainStartup(h));

    await restoreSession();
    void bindPanelPersistence();
    void refreshRecent();
    await offerRecovery(h);

    offCloseRequest = h.onWindowCloseRequest(() => void confirmQuit());

    // 浏览器 mock 下没有「退出」按钮，关页面时同样要把会话落下来
    beforeUnloadHandler = () => {
      void saveSession();
    };
    window.addEventListener("beforeunload", beforeUnloadHandler);

    signalReady();
    (window as unknown as { __hpPerf?: typeof perf }).__hpPerf = perf;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    signalReady();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("dragenter", onDragEnter);
  window.removeEventListener("dragleave", onDragLeave);
  window.removeEventListener("dragover", onDragOver);
  window.removeEventListener("drop", onDrop);
  if (beforeUnloadHandler) window.removeEventListener("beforeunload", beforeUnloadHandler);
  offCloseRequest?.();
});

defineExpose({ confirmQuit, requestCloseTab, offerRecovery });
</script>

<template>
  <div class="shell">
    <TopBar />
    <!-- 127：标签栏「+」是新增标签（不再发 open）；打开文件走那颗文件夹图标 -->
    <TabBar @close="requestCloseTab" @open="openWithDialog()" @open-settings="settingsOpen = true" />
    <div class="shell__body">
      <SideBar />
      <EditorPane :host="host" @open="openWithDialog()" />
    </div>
    <StatusBar :error="error || autoSaveError" @clear-error="dismissBarError" />
    <div v-if="dropping" class="dropzone" data-testid="drop-overlay">
      <div class="dropzone__inner">
        {{ msg("drop.hint") }}
        <small v-if="dropRejected" class="dropzone__reject">{{ dropRejected }}</small>
      </div>
    </div>
    <ConfirmDialog />
    <!-- 130：这里只报「MDStar v版本」；宿主与平台（wails · windows）不再出现在界面上 -->
    <SettingsDialog :version="info?.version ?? ''" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.shell__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.dropzone {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--hp-accent);
  background: var(--hp-mask);
  pointer-events: none;
}

.dropzone__inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 26px;
  border-radius: 8px;
  background: var(--hp-surface);
  color: var(--hp-accent);
  font-size: 15px;
  font-weight: 600;
}

.dropzone__reject {
  color: var(--hp-error);
  font-size: 12px;
  font-weight: 400;
}
</style>
