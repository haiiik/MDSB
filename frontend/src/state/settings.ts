import { reactive, ref, watch } from "vue";
import { setLang, type Lang } from "../i18n";

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
  /**
   * 界面语言（M3-134）。**默认中文**；
   * 安装器写的 `HKCU\Software\MDStar\Language` 是「首启初值」的来源，
   * 一旦这里存过值就以它为准（她定的口径：设置里只有 中文 / English 双选，不做跟随系统）。
   */
  lang: Lang;
}

export const settings = reactive<Settings>({
  autoSave: false,
  autoSaveDelayMs: 1000,
  codeLineNumbers: false,
  baseFontSize: 15,
  lang: "zh",
});

// 设置里的语言 → 真正生效的那份状态。放在 store 里而不是组件里：
// 启动读档、用户改设置、以后安装器传值，三条路都要过同一个映射，别各写一份。
watch(
  () => settings.lang,
  (v) => setLang(v),
  { immediate: true },
);

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
      // 读档后立刻同步一次语言（watch 的 immediate 只能看到默认值）
      setLang(settings.lang);
    } catch {
      /* 坏数据直接忽略，回落默认值 */
    }
  });
  watch(settings, (s) => void set(KEY, JSON.stringify(s)), { deep: true });
}
