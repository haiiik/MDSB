import { reactive, watch } from "vue";
import type { ThemeName } from "../kernel/render";

/**
 * 全局视图偏好。
 *
 * 只有主题是全应用共享的；正文宽度档与缩放在 018/019 里改成**每标签独立**，
 * 所以它们住在 Tab 上而不是这里。
 */
export const view = reactive<{ theme: ThemeName }>({
  theme: "light",
});

/**
 * 主题落到 <html data-theme>。
 *
 * 必须挂在 html 上而不是 .hp-doc 上：外壳（顶栏/侧栏/状态栏/对话框）也要一起换色，
 * 只给正文容器加属性的话会出现「白窗口里一块深色文档」。
 *
 * `typeof document` 那道判断是给**非 DOM 环境**留的：状态层的接线（`wirePersistence`）
 * 在 Node 单测里也会被 import，而这个 watcher 是 `immediate` 的 —— 不判断就是
 * 整份测试文件在 collect 阶段直接 `ReferenceError: document is not defined`，
 * 连一条用例都跑不到。
 */
watch(
  () => view.theme,
  (t) => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = t;
  },
  { immediate: true }
);

const THEME_KEY = "theme.v1";

let bound = false;

/** 017：主题持久化。与宿主绑定时才接，避免浏览器 mock 与桌面行为分叉 */
export function bindThemePersistence(
  get: (k: string) => Promise<string>,
  set: (k: string, v: string) => Promise<void>
) {
  if (bound) return;
  bound = true;
  void get(THEME_KEY).then((v) => {
    if (v === "dark" || v === "light") view.theme = v;
  });
  watch(
    () => view.theme,
    (v) => void set(THEME_KEY, v)
  );
}
