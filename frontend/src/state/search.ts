import { reactive, shallowRef } from "vue";
import {
  advance,
  advanceNear,
  DEFAULT_SEARCH_OPTIONS,
  findMatches,
  InvalidPatternError,
  type Match,
  type SearchOptions,
} from "../kernel/search";
import { tf } from "../i18n";

/**
 * 118：查找与替换的**共享状态**。
 *
 * 三种模式的文本表面不同（渲染文字 / PM 文档 / 原始 Markdown），
 * 但「查找条是同一个、查询词与三个开关是同一份、命中列表与当前项索引是同一份」——
 * 所以状态放这里，模式差异全部收在 `SearchAdapter` 这个接口后面：
 * 宿主组件（EditorPane / EditView / SourceView / 阅读渲染）在模式切换时注册自己的适配器，
 * 这里只负责「重算命中 + 推进当前项 + 把活派给适配器」。
 *
 * 判据（什么算命中）不在这里，在 `kernel/search.ts`，那份是纯函数、单测穷举过。
 */

export type SearchAdapter = {
  /** 当前模式下被搜索的纯文本 */
  text(): string;
  /**
   * 画高亮；`reveal` 为真时才把当前项**滚进视野并落成选区**。
   *
   * 这个开关是 140 为输入法加的：查找框每敲一个字都重算，
   * 而「落选区」会把 DOM 选区从输入框抢进正文 —— Chromium 在组合期被抢选区，
   * 拼音串当场作废（她的报告：输入一个字符就断、中文打不出来）。
   * 所以**打字时只画高亮**，按 Enter / ↑↓ / 点下一个时才跳转。
   */
  apply(matches: Match[], current: number, reveal: boolean): void;
  /** 能不能替换（阅读模式只读 → false） */
  canReplace: boolean;
  /**
   * 148：屏幕上这一点落在**第几处命中**上（没有就返回 -1）。
   * 三档的"点 → 偏移"各有各的算法（PM 的 posAtCoords、CM 的 posAtCoords、
   * 阅读档只能拿 Highlight 的那些 Range 的矩形去撞），所以留给各适配器实现。
   */
  indexAtPoint?(x: number, y: number): number;
  /** 关闭查找条后把焦点还给正文（否则 Ctrl+Z 这类快捷键打在 body 上，用户以为撤销坏了） */
  focus?(): void;
  /** 替换当前项，返回是否发生替换 */
  replaceOne?(replacement: string): boolean;
  /** 替换全部 = **一步撤销**（117 口径：一个事务里做完） */
  replaceAll?(replacement: string): number;
};

export const search = reactive({
  open: false,
  query: "",
  replacement: "",
  options: { ...DEFAULT_SEARCH_OPTIONS } as SearchOptions,
  matches: [] as Match[],
  current: -1,
  /** 正则非法时的提示文案（不清空输入，见验收那条） */
  error: "",
  /** 替换区是否展开（Ctrl+H 才展开，Ctrl+F 只看） */
  withReplace: false,
  /**
   * 146：替换的**回执**（她：「替换功能增加结果反馈」）。
   * 换完不留一句「换了几处、还剩几处」，用户只能自己数高亮 —— 点了像没反应，
   * 而"没反应"在替换这种不可见批量动作上是最糟的观感。
   */
  feedback: "",
});

/**
 * 适配器用 `shallowRef` 存，不是普通变量。
 *
 * 第一版是普通 `let`，于是 `SearchBar` 里 `canReplace` 这个 computed
 * 永远停在「还没有适配器」的 false 上 —— 表现成编辑模式下替换那一行根本不出现
 * （用例表现为 `fill(replace-input)` 超时）。适配器是跨组件注册的，必须可响应。
 *
 * 顺带一条依赖顺序：`SearchBar` 在 `EditorPane` 挂载时可能还没被 `v-if` 创建，
 * 此时没有任何 computed 读过 `adapterRef` —— 若 `canReplace` 写在 `state/search.ts`
 * 里导出，它会变成一个**永不被求值**的 computed，将来适配器换了也不失效（脏值）。
 * 所以它放在 `SearchBar` 里，模板每次渲染都求值一遍。
 */
const adapterRef = shallowRef<SearchAdapter | null>(null);

/**
 * 146：当前项的**身份** —— 匹配到的那段文字 + 当时在文本里的位置。
 *
 * 为什么要存这个：`search.current` 是**这一次命中列表里的下标**，
 * 正文一改（甚至只是在它前面多打一个字），列表重算，下标就不再代表她站着的那一处；
 * 重算又把 current 复位成 0，于是「按 ↓ 回到首个附近」—— 她的报告正是这一条。
 * 文字 + 位置才是跨重算仍然认得出的东西。
 */
let 当前身份: { text: string; from: number } | null = null;

export function registerSearchAdapter(next: SearchAdapter | null): void {
  adapterRef.value = next;
  recomputeSearch();
}

/**
 * 只有「当前还是我注册的那个」才注销。
 * 模式切换时 Vue 先挂新组件再卸旧组件，旧组件若无条件注销，
 * 会把刚注册上的新适配器一起清掉（表现为切到编辑模式后查找条永远 0 命中）。
 */
export function unregisterSearchAdapter(own: SearchAdapter): void {
  if (adapterRef.value === own) {
    adapterRef.value = null;
    recomputeSearch();
  }
}

export function searchAdapter(): SearchAdapter | null {
  return adapterRef.value;
}

/**
 * 按当前查询重算命中。适配器没注册（或模式刚切换还没挂载）时只是清空列表，不报错。
 *
 * `reveal=false` 用于**打字途中**：只画高亮，不动选区、不滚动（见 `SearchAdapter.apply` 的注释）。
 */
export function recomputeSearch(reveal = true): void {
  const adapter = adapterRef.value;
  if (!adapter) {
    search.matches = [];
    search.current = -1;
    return;
  }
  let 正文 = "";
  try {
    正文 = adapter.text();
    search.matches = findMatches(正文, search.query, search.options);
    search.error = "";
  } catch (e) {
    if (e instanceof InvalidPatternError) {
      // **不清空输入**：用户要的就是「改回来一个字就能继续找」
      search.error = "正则表达式无效：" + e.message;
      search.matches = [];
    } else {
      throw e;
    }
  }
  search.current = 找回当前项(正文);
  记身份(正文);
  adapter.apply(search.matches, search.current, reveal);
}

/**
 * 146：重算之后把「当前项」找回来。
 * 认的是**同一串文字里离原位最近的那一处**：在她前面补一个字，位置整体平移，
 * 但最近的那一处还是她刚才看的那一处；这一处真被改没了（文字不再出现）才给 -1，
 * 意思是「当前没落在任何一处」—— 计数条会显示 `0 / N`，上下箭头从丢的位置接着找邻居。
 */
function 找回当前项(正文: string): number {
  if (!search.matches.length) return -1;
  const 身份 = 当前身份;
  if (!身份) return 0;
  let 最好 = -1;
  let 最近 = Infinity;
  search.matches.forEach((m, i) => {
    if (正文.slice(m.from, m.to) !== 身份.text) return;
    const 差 = Math.abs(m.from - 身份.from);
    if (差 < 最近) {
      最近 = 差;
      最好 = i;
    }
  });
  return 最好;
}

/** 找到了就更新身份；没找到**留着旧身份**（那是上下箭头唯一还认得的落点） */
function 记身份(正文: string): void {
  const m = search.matches[search.current];
  if (m) 当前身份 = { text: 正文.slice(m.from, m.to), from: m.from };
}

/** 查找框打字走这条：`reveal=false`，输入法组合期不会被选区抢走 */
export function setSearchQuery(q: string, reveal = false): void {
  search.query = q;
  当前身份 = null; // 换查询词 = 换目标，旧身份不再作数（第一处重新开始）
  search.feedback = ""; // 换了查询词，上一笔回执就作废（还挂着会以为说的是这一笔）
  recomputeSearch(reveal);
}

/**
 * 文档变了才需要这个：查找条没开时不该为每次击键付一次全文扫描。
 *
 * 140 review：这条**不 reveal** —— 正文改动只是让高亮跟上，不是用户要求跳转；
 * 开着查找条在正文里用输入法打字时，reveal 会往正文落选区，
 * 那正是「查找框输入一个字符就断」的同一个根因，只是换了个入口。
 * （`search.open` 时 `setSearchQuery` 走的那条已经是 reveal=false。）
 */
export function recomputeIfOpen(): void {
  if (search.open) recomputeSearch(false);
}

export function setSearchOptions(patch: Partial<SearchOptions>): void {
  search.options = { ...search.options, ...patch };
  当前身份 = null;
  search.feedback = "";
  recomputeSearch();
}

export function gotoMatch(delta: 1 | -1): void {
  const adapter = adapterRef.value;
  if (!adapter || !search.matches.length) return;
  /*
   * 146：当前项还在（重算认出来了）就按索引推进 —— 这是原来那条被验收钉死的循环语义
   * （末项点下一个回首项），不能动。
   * 认不出来（`current < 0`，她刚把那一处改没了）才按**位置**找邻居：
   * 起点是丢掉的那一处的位置，正向取它之后第一处、反向取它之前最后一处。
   * 她的原话：「编辑导致丢掉了当前目标，点上下箭头时自动定位上下位置，不要回到首个」。
   */
  search.current =
    search.current >= 0
      ? advance(search.matches.length, search.current, delta)
      : advanceNear(search.matches, 当前身份 ? 当前身份.from : null, delta);
  const 正文 = adapter.text();
  记身份(正文);
  // 点了「上一个 / 下一个」或按 Enter 才跳转：这条**要** reveal（把当前项滚进视野并落成选区）
  adapter.apply(search.matches, search.current, true);
}

/**
 * 148：她「查找功能，点击查找到的高亮块时，查找条中的 5 / 98，要定位到对应数字」。
 *
 * 点正文里某一处高亮 = 告诉她"我要看这一处"，可计数一直停在原来那一处（甚至因为
 * 点击把光标挪走而在下一次重算时错位）。这里把点到的那一处认成当前项：
 * **只改当前项与高亮，不 reveal** —— 她点在哪就站在哪，视图不该再跳。
 */
export function setCurrentAtPoint(x: number, y: number): boolean {
  const adapter = adapterRef.value;
  if (!adapter?.indexAtPoint || !search.open || !search.matches.length) return false;
  const i = adapter.indexAtPoint(x, y);
  if (i < 0 || i >= search.matches.length || i === search.current) return false;
  search.current = i;
  记身份(adapter.text());
  adapter.apply(search.matches, i, false);
  return true;
}

export function openSearch(withReplace = false): void {
  search.open = true;
  search.withReplace = search.withReplace || withReplace;}

/**
 * 查找条上那颗「替换」按钮：展开 / 收起替换行。
 *
 * 118 第一版只有 `Ctrl+H` 会展开替换，`Ctrl+F` 打开的是同一条工具条但少一行 ——
 * 她实测的反馈是「和 Ctrl+F 长得一样，替换是不是没有」。入口藏在快捷键里等于没有入口，
 * 所以这里给一个**看得见的开关**；`Ctrl+H` 保留为「打开并直接展开」的快捷路径。
 */
export function toggleReplace(): void {
  search.withReplace = !search.withReplace;
}

export function closeSearch(): void {
  search.open = false;
  search.error = "";
  search.feedback = "";
  const adapter = adapterRef.value;
  adapter?.apply([], -1, false); // Esc 关闭并清高亮（验收明写）
  adapter?.focus?.();
}

/** 146：替换回执的文案（`done` 换了几处、`left` 还剩几处） */
const 回执 = (done: number, left: number): string => tf("search.replaced", { done, left });

/** 替换当前项并前进到下一项；返回是否真的替换了 */
export function replaceCurrent(): boolean {
  const adapter = adapterRef.value;
  if (!adapter?.replaceOne || !search.matches.length || search.current < 0) return false;
  const ok = adapter.replaceOne(search.replacement);
  if (ok) {
    recomputeSearch();
    // 剩几处只能重算之后才知道：替换写进去的文字本身可能又含查询词（`aa`→`aaa` 那种）
    search.feedback = 回执(1, search.matches.length);
  }
  return ok;
}

export function replaceAllMatches(): number {
  const adapter = adapterRef.value;
  if (!adapter?.replaceAll) return 0;
  const n = adapter.replaceAll(search.replacement);
  if (n) {
    recomputeSearch();
    search.feedback = 回执(n, search.matches.length);
  }
  return n;
}
