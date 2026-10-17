import { reactive, shallowRef } from "vue";
import {
  advance,
  DEFAULT_SEARCH_OPTIONS,
  findMatches,
  InvalidPatternError,
  type Match,
  type SearchOptions,
} from "../kernel/search";

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
  /** 画高亮并把当前项滚进视野；matches 为空时清掉所有高亮 */
  apply(matches: Match[], current: number): void;
  /** 能不能替换（阅读模式只读 → false） */
  canReplace: boolean;
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

/** 按当前查询重算命中。适配器没注册（或模式刚切换还没挂载）时只是清空列表，不报错 */
export function recomputeSearch(): void {
  const adapter = adapterRef.value;
  if (!adapter) {
    search.matches = [];
    search.current = -1;
    return;
  }
  try {
    search.matches = findMatches(adapter.text(), search.query, search.options);
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
  search.current = search.matches.length ? 0 : -1;
  adapter.apply(search.matches, search.current);
}

export function setSearchQuery(q: string): void {
  search.query = q;
  recomputeSearch();
}

/** 文档变了才需要这个：查找条没开时不该为每次击键付一次全文扫描 */
export function recomputeIfOpen(): void {
  if (search.open) recomputeSearch();
}

export function setSearchOptions(patch: Partial<SearchOptions>): void {
  search.options = { ...search.options, ...patch };
  recomputeSearch();
}

export function gotoMatch(delta: 1 | -1): void {
  const adapter = adapterRef.value;
  if (!adapter || !search.matches.length) return;
  search.current = advance(search.matches.length, search.current, delta);
  adapter.apply(search.matches, search.current);
}

export function openSearch(withReplace = false): void {
  search.open = true;
  search.withReplace = search.withReplace || withReplace;
}

export function closeSearch(): void {
  search.open = false;
  search.error = "";
  const adapter = adapterRef.value;
  adapter?.apply([], -1); // Esc 关闭并清高亮（验收明写）
  adapter?.focus?.();
}

/** 替换当前项并前进到下一项；返回是否真的替换了 */
export function replaceCurrent(): boolean {
  const adapter = adapterRef.value;
  if (!adapter?.replaceOne || !search.matches.length || search.current < 0) return false;
  const ok = adapter.replaceOne(search.replacement);
  if (ok) recomputeSearch();
  return ok;
}

export function replaceAllMatches(): number {
  const adapter = adapterRef.value;
  if (!adapter?.replaceAll) return 0;
  const n = adapter.replaceAll(search.replacement);
  if (n) recomputeSearch();
  return n;
}
