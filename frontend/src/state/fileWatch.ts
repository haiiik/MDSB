import { reactive, watch } from "vue";
import { t } from "../i18n";
import { 变了之后怎么办, 指纹变了吗, type 指纹 } from "../kernel/externalChange";
import { activeTab, getHost, isDirty, tabs, type Tab } from "./documents";

/**
 * 164：**盯磁盘上这一篇有没有被别的工具改过**（要求：「新增文件自动刷新功能，应对其他工具改了文件」）。
 *
 * 三条已定口径写进 `kernel/externalChange.ts` 的判断里，这一层只管"什么时候问、问完做什么"：
 * - **只盯当前活动标签**：切走就把那一格的基准丢掉（下次切回来重新记），不开 20 篇就后台 stat 20 次；
 * - **窗口在后台时不轮询**：`document.hidden` 就跳过这一轮 —— 别的程序占着文件时我们不该去抢读，
 *   而且人不在看，刷新早一秒晚一秒没有区别；
 * - **提示条开着的时候不再问**：一次问一件事，不叠层。
 *
 * 为什么不在保存链路上挂"记得更新基准"的钩子：`Ctrl+S` 之后 mtime 必然变，
 * 但判断的第二步会读一份盘上的与 `saved` 逐字节比 —— 一样就落在"identical"那一支，
 * 什么都不做。**少一处接线就少一处会忘**（142/143 那两轮反复踩过"某条链路忘了通知"）。
 */

/** 轮询间隔：2 秒。再快就是白烧磁盘与 CPU，再慢就配不上"自动"这两个字 */
const 轮询毫秒 = 2000;

interface 提示态 {
  /** 正在问哪一颗标签（`tab.id`）；null = 没在问 */
  问: string | null;
  /** 问的是哪种事 */
  种类: "" | "改了" | "没了";
  /** 重载完成之后那一句会自己消失的回声 */
  回声: string;
}

export const 外部改动 = reactive<提示态>({ 问: null, 种类: "", 回声: "" });

/** 每颗标签认过的盘上指纹（连带它当时是哪个路径 —— 另存为之后旧指纹不作数） */
const 基准表 = new Map<string, { 路径: string; 指纹: 指纹 }>();

let 定时器: ReturnType<typeof setInterval> | null = null;
let 在跑 = false;

function 清提示(): void {
  外部改动.问 = null;
  外部改动.种类 = "";
}

/** 重载完成的那一句轻提示：2.6 秒后自己消失，不挡操作（与 154–156 那条输出回声同一格） */
let 回声计时: ReturnType<typeof setTimeout> | null = null;
function 说回声(文: string): void {
  外部改动.回声 = 文;
  if (回声计时) clearTimeout(回声计时);
  回声计时 = setTimeout(() => {
    回声计时 = null;
    外部改动.回声 = "";
  }, 2600);
}

/**
 * 把工作副本与落盘基准一起换成盘上那份。
 *
 * 不走 `setTabMarkdown`：那条会触发 `hooks.afterEdit`（自动保存的防抖），
 * 而我们刚读进来的就是盘上的内容，再写一遍纯属自激。
 * `saved` 必须同步跟上，否则脏点亮着 —— 而人并没有改任何东西。
 */
function 装进去(tab: Tab, 文本: string, 指纹: 指纹 | null): void {
  tab.markdown = 文本;
  tab.saved = 文本;
  if (指纹) 基准表.set(tab.id, { 路径: tab.path ?? "", 指纹 });
}

async function 取指纹(路径: string): Promise<指纹 | null> {
  const host = getHost();
  if (!host) return null;
  try {
    const s = await host.stat(路径);
    return { size: s.size, mtime: s.mtime };
  } catch {
    return null;
  }
}

async function 一轮(): Promise<void> {
  if (在跑) return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (外部改动.问) return; // 一次问一件事
  const tab = activeTab.value;
  if (!tab || !tab.path) {
    基准表.clear();
    return;
  }
  const host = getHost();
  if (!host) return;
  在跑 = true;
  try {
    const 旧 = 基准表.get(tab.id);
    const 现在 = await 取指纹(tab.path);
    const 判 = 指纹变了吗(旧 && 旧.路径 === tab.path ? 旧.指纹 : null, 现在);
    if (判 === "no-baseline") {
      if (现在) 基准表.set(tab.id, { 路径: tab.path, 指纹: 现在 });
      return;
    }
    if (判 === "unchanged") return;
    if (判 === "unreadable") {
      外部改动.问 = tab.id;
      外部改动.种类 = "没了";
      return;
    }
    // 指纹变了：再读一份盘上的，与「我们以为落盘的那份」逐字节比（这一步挡住两类噪音：
    // 别的工具把一样的字节重写一遍、以及我们自己刚保存）
    let 磁盘: string | null = null;
    try {
      磁盘 = await host.readFile(tab.path);
    } catch {
      磁盘 = null;
    }
    const 办 = 变了之后怎么办(磁盘, tab.saved, isDirty(tab));
    if (办 === "identical" || 办 === "unreadable") {
      if (现在) 基准表.set(tab.id, { 路径: tab.path, 指纹: 现在 });
      if (办 === "unreadable") {
        外部改动.问 = tab.id;
        外部改动.种类 = "没了";
      }
      return;
    }
    if (办 === "reload") {
      装进去(tab, 磁盘 as string, 现在);
      说回声(t("ext.reloaded"));
      return;
    }
    // 问一声：有未保存的编辑，谁也不许悄悄盖掉谁
    外部改动.问 = tab.id;
    外部改动.种类 = "改了";
  } finally {
    在跑 = false;
  }
}

/** 提示条主按钮：读盘上那份并装上（**会丢掉当前未保存的编辑**，这正是点它的人要的结果） */
export async function 重载磁盘版本(): Promise<void> {
  const tab = tabs.list.find((x) => x.id === 外部改动.问);
  清提示();
  if (!tab?.path) return;
  const host = getHost();
  if (!host) return;
  try {
    const 文本 = await host.readFile(tab.path);
    装进去(tab, 文本, await 取指纹(tab.path));
    说回声(t("ext.reloaded"));
  } catch {
    外部改动.问 = tab.id;
    外部改动.种类 = "没了";
  }
}

/**
 * 提示条次按钮：留着我们的编辑，**并把基准认到盘上现在这一份**。
 *
 * 不这么做的话每 2 秒就会再问一次，人没法继续干活。
 * 代价如实说：之后 `Ctrl+S` 会把盘上那份外部改动覆盖掉 —— 这是选了「保留我的编辑」的人自己的决定，
 * 界面上不再重复提醒（重复提醒等于没提醒）。
 */
export async function 保留我的编辑(): Promise<void> {
  const tab = tabs.list.find((x) => x.id === 外部改动.问);
  清提示();
  if (!tab?.path) return;
  const 现在 = await 取指纹(tab.path);
  if (现在) 基准表.set(tab.id, { 路径: tab.path, 指纹: 现在 });
}

/** 「文件读不到了」那一支只有一个按钮 */
export function 关掉提示(): void {
  清提示();
}

/** 换标签 / 关标签 / 另存为换了路径：旧基准与旧提示都不该继续挂着 */
watch(
  () => [activeTab.value?.id ?? "", activeTab.value?.path ?? ""] as const,
  () => {
    清提示();
    for (const [id, 记] of Array.from(基准表)) {
      const 还在 = tabs.list.find((x) => x.id === id);
      if (!还在 || !还在.path || 还在.path !== 记.路径) 基准表.delete(id);
    }
  }
);

/** 由 App 在拿到宿主之后启动（只装一次） */
export function startFileWatch(): void {
  if (定时器) return;
  定时器 = setInterval(() => void 一轮(), 轮询毫秒);
  void 一轮();
}

export function stopFileWatch(): void {
  if (定时器) clearInterval(定时器);
  定时器 = null;
  基准表.clear();
  if (回声计时) clearTimeout(回声计时);
  回声计时 = null;
  清提示();
}

/** 测试与判据用：立刻跑一轮，不等下一个 2 秒 */
export const 探一次 = 一轮;
