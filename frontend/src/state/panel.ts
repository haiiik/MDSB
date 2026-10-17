import { reactive, watch } from "vue";
import { getHost } from "./documents";

/**
 * 侧栏面板状态（014 双页 + 016 折叠）。
 * 两个值都要跨重启保持，所以直接接宿主状态袋。
 */
export const panel = reactive<{ page: "recent" | "outline"; collapsed: boolean }>({
  page: "recent",
  collapsed: false,
});

const PAGE_KEY = "panel.page.v1";
const COLLAPSE_KEY = "panel.collapsed.v1";

let bound = false;

export function bindPanelPersistence() {
  if (bound) return;
  const h = getHost();
  if (!h) return;
  bound = true;
  void (async () => {
    const [page, collapsed] = await Promise.all([h.getState(PAGE_KEY), h.getState(COLLAPSE_KEY)]);
    if (page === "recent" || page === "outline") panel.page = page;
    panel.collapsed = collapsed === "1";
  })();
  watch(
    () => panel.page,
    (v) => void h.setState(PAGE_KEY, v)
  );
  watch(
    () => panel.collapsed,
    (v) => void h.setState(COLLAPSE_KEY, v ? "1" : "0")
  );
}

export function toggleCollapsed() {
  panel.collapsed = !panel.collapsed;
}
