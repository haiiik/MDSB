import { reactive } from "vue";

/**
 * 应用内确认对话框。
 *
 * 不用 window.confirm：原生框在 WebView2 里样式突兀、按钮文案不可本地化，
 * 而且浏览器 mock 下会直接阻塞 Playwright。
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** 按顺序给出，第一个是默认动作 */
  actions: string[];
  resolve: (choice: string | null) => void;
}

export const dialog = reactive<{ current: ConfirmRequest | null }>({ current: null });

/** 同时来两个确认（例如批量关闭脏标签）时排队，避免互相吃掉结果 */
const queue: Array<() => void> = [];

export function confirm(req: Omit<ConfirmRequest, "resolve">): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const open = () => {
      let settled = false;
      dialog.current = {
        ...req,
        resolve: (choice) => {
          if (settled) return;
          settled = true;
          dialog.current = null;
          resolve(choice);
          const next = queue.shift();
          if (next) next();
        },
      };
    };
    if (dialog.current) queue.push(open);
    else open();
  });
}

/** Esc / 遮罩关闭：等价于「取消」，不选任何动作 */
export function dismissDialog() {
  dialog.current?.resolve(null);
}
