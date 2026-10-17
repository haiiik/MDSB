import { reactive, ref, watch } from "vue";

/**
 * 用户设置。持久化为状态袋里的一条 JSON（`settings.v1`），
 * 这样加一项设置不需要动 Go 侧接口。
 */
export interface Settings {
  /** 自动保存开关，默认关（D6） */
  autoSave: boolean;
  /** 自动保存防抖时长，停止输入后落盘 */
  autoSaveDelayMs: number;
  /** 代码块行号（020） */
  codeLineNumbers: boolean;
  /** 基础字号（018）：14 / 15 / 16 / 18 */
  baseFontSize: number;
}

export const settings = reactive<Settings>({
  autoSave: false,
  autoSaveDelayMs: 1000,
  codeLineNumbers: false,
  baseFontSize: 15,
});

export const settingsOpen = ref(false);

const KEY = "settings.v1";

let bound = false;

export function bindSettingsPersistence(
  get: (k: string) => Promise<string>,
  set: (k: string, v: string) => Promise<void>
) {
  if (bound) return;
  bound = true;
  void get(KEY).then((raw) => {
    if (!raw) return;
    try {
      Object.assign(settings, JSON.parse(raw) as Partial<Settings>);
    } catch {
      /* 坏数据直接忽略，回落默认值 */
    }
  });
  watch(settings, (s) => void set(KEY, JSON.stringify(s)), { deep: true });
}
