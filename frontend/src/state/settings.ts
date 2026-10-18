import { reactive, ref, watch } from "vue";
import { normalizeLang, setLang, type Lang } from "../i18n";

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

/**
 * 首启语言怎么定（纯函数，单独可测）：
 * 1. 存过的 `lang` 最大 —— 用户在设置里改过一次，之后每次启动都按它，安装期选什么都不再看；
 * 2. 没存过 → 用安装器那一页写进注册表的值（`installLang`，"zh"/"en"）；
 * 3. 两个都没有（没装过、直接跑 exe、或注册表读不到）→ 中文。
 * 存值里的坏字符串按"没存过"处理，不照单全收。
 */
export function resolveInitialLang(stored: Partial<Settings> | null, installLang: string): Lang {
  const fromStore = normalizeLang(stored?.lang);
  if (fromStore) return fromStore;
  const fromInstaller = normalizeLang(installLang);
  return fromInstaller ?? "zh";
}

let bound = false;

export function bindSettingsPersistence(
  get: (k: string) => Promise<string>,
  set: (k: string, v: string) => Promise<void>,
  /** 安装期语言；不传（浏览器/单测）= 没有安装期意见 */
  installLang: () => Promise<string> = async () => ""
) {
  if (bound) return;
  bound = true;
  void Promise.all([
    get(KEY),
    // 注册表读不到不该影响启动：兜成空串，让 resolveInitialLang 回落中文
    installLang().catch(() => ""),
  ]).then(([raw, installer]) => {
    let parsed: Partial<Settings> | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Partial<Settings>;
      } catch {
        parsed = null; // 坏数据直接忽略，回落默认值
      }
    }
    if (parsed) Object.assign(settings, parsed);
    settings.lang = resolveInitialLang(parsed, installer);
    // 读档后立刻同步一次语言（watch 的 immediate 只能看到默认值）
    setLang(settings.lang);
  });
  watch(settings, (s) => void set(KEY, JSON.stringify(s)), { deep: true });
}
