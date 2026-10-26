<script setup lang="ts">
import { t } from "../i18n";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { formatCount } from "../kernel/search";
import {
  closeSearch,
  gotoMatch,
  replaceAllMatches,
  replaceCurrent,
  search,
  setSearchOptions,
  setSearchQuery,
  searchAdapter,
  setCurrentAtPoint,
  toggleReplace,
} from "../state/search";

/**
 * 118：查找条浮层。
 *
 * 三种模式共用这一个组件（数据与动作全在 `state/search.ts`），
 * 唯一的差别是**能不能替换** —— 阅读模式是只读行为，替换那一行直接不出现，
 * 而不是置灰让人点了没反应。
 */

const input = ref<HTMLInputElement | null>(null);
const replaceInput = ref<HTMLInputElement | null>(null);

const count = computed(() => formatCount(search.matches.length, search.current));
const canReplace = computed(() => searchAdapter()?.canReplace ?? false);

/** 这三个 key 是判断依据（喂 `setSearchOptions`），所以字面量类型要留着，不能退成 string */
type SearchOptionKey = "caseSensitive" | "wholeWord" | "regex";

/**
 * 139：文案走字典，且做成 computed —— 模块级常量会把语言烘死在 import 那一刻。
 */
const OPTIONS = computed<{ key: SearchOptionKey; label: string; title: string }[]>(() => [
  { key: "caseSensitive", label: "Aa", title: t("search.caseTitle") },
  { key: "wholeWord", label: t("search.wholeLabel"), title: t("search.wholeTitle") },
  { key: "regex", label: ".*", title: t("search.regexTitle") },
]);

function focusInput(): void {
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
}

/** 那颗「替换」按钮：展开时顺手把焦点给替换输入框（收起时不动，别把光标从查找框抢走） */
function onToggleReplace(): void {
  toggleReplace();
  if (search.withReplace) void nextTick(() => replaceInput.value?.focus());
}

/**
 * 140：**输入法组合期不能打断**（报来的问题：查找框输入一个字符就断、中文打不出来）。
 *
 * 三处各自都会掐断组合，缺一不可一起修：
 *  ① 组合期间把值推给 store → 重算命中 → 适配器往正文里落选区/滚动 →
 *     Chromium 的 DOM 选区被抢走，拼音串当场作废；
 *  ② 用 Enter / 空格选候选词时，`keydown` 也照样发过来（`isComposing: true`），
 *     我们把它当成「跳到下一个命中」并 `preventDefault` → 候选词选不上；
 *  ③ 阅读模式的退化路径每敲一下就 `removeAllRanges()`，同样掐断组合（在 searchDom 里挡）。
 * 所以：组合期间**不推值**，`compositionend` 那一刻推一次；组合期间的按键一律不拦。
 */
/*
 * 两个框**各一份**标记：只有一枚共享 ref 时，替换框开始组合会把查找框也一起「哑掉」，
 * 而组合中途失焦（切窗口、点别处）时浏览器可能不再补发 compositionend，
 * 那枚标记就永远卡在 true —— 之后每一笔输入都被吞掉，等于这条修过的洞重新裂开。
 * 所以：各自的标记 + `input` 事件自带的 `isComposing` 双保险 + 失焦即复位。
 */
const composingFind = ref(false);
const composingReplace = ref(false);

/** 组合期一律不推值：推了就会重算命中并往正文落选区，拼音串当场被掐断 */
function inComposition(e: Event, flag: { value: boolean }): boolean {
  return flag.value || (e as InputEvent).isComposing === true;
}

function onFindInput(e: Event): void {
  if (inComposition(e, composingFind)) return;
  setSearchQuery((e.target as HTMLInputElement).value);
}

function onCompositionEnd(e: CompositionEvent): void {
  composingFind.value = false;
  setSearchQuery((e.target as HTMLInputElement).value);
}

function onReplaceInput(e: Event): void {
  if (inComposition(e, composingReplace)) return;
  search.replacement = (e.target as HTMLInputElement).value;
}

function onReplaceCompositionEnd(e: CompositionEvent): void {
  composingReplace.value = false;
  search.replacement = (e.target as HTMLInputElement).value;
}

function onKeydown(e: KeyboardEvent): void {
  // 组合期间的按键属于输入法（选词、翻页、回车上屏），一个都不许拦
  if (e.isComposing) return;
  // Esc 只关查找条：拦住冒泡，别让外壳的「关闭标签 / 退出」也吃到这一下
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSearch();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  }
}

function onReplaceKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSearch();
  }
}

/*
 * 148：点正文里的高亮 → 计数跟着走到"第几处"。
 * 监听挂在 document 上、只在查找条开着的那段时间存在：
 * 三档的内容区在三个不同组件里，各挂一份迟早有一份忘记挂。
 * 用捕获阶段，避免被 PM / CM 自己那套事件处理挡掉。
 */
function onDocClick(e: MouseEvent): void {
  setCurrentAtPoint(e.clientX, e.clientY);
}

watch(
  () => search.open,
  (open) => {
    if (open) {
      focusInput();
      document.addEventListener("click", onDocClick, true);
    } else {
      document.removeEventListener("click", onDocClick, true);
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => document.removeEventListener("click", onDocClick, true));

watch(
  () => search.withReplace,
  (v) => {
    if (v) void nextTick(() => replaceInput.value?.focus());
  }
);
</script>

<template>
  <div v-if="search.open" class="searchbar" data-testid="search-bar" @keydown="onKeydown">
    <div class="searchbar__row">
      <input
        ref="input"
        class="searchbar__input"
        data-testid="search-input"
        type="text"
        :value="search.query"
        :placeholder="t('search.find')"
        spellcheck="false"
        @input="onFindInput"
        @compositionstart="composingFind = true"
        @compositionend="onCompositionEnd"
        @blur="composingFind = false"
      />
      <span
        class="searchbar__count"
        :class="{ 'is-empty': search.matches.length === 0 }"
        data-testid="search-count"
      >
        {{ count }}
      </span>
      <button :title="t('search.prev')" data-testid="search-prev" :disabled="!search.matches.length" @click="gotoMatch(-1)">
        ↑
      </button>
      <button :title="t('search.next')" data-testid="search-next" :disabled="!search.matches.length" @click="gotoMatch(1)">
        ↓
      </button>
      <span class="searchbar__sep" />
      <button
        v-for="o in OPTIONS"
        :key="o.key"
        class="searchbar__opt"
        :class="{ 'is-on': search.options[o.key] }"
        :title="o.title"
        :data-testid="'search-opt-' + o.key"
        @click="setSearchOptions({ [o.key]: !search.options[o.key] })"
      >
        {{ o.label }}
      </button>
      <button
        v-if="canReplace"
        class="searchbar__opt"
        :class="{ 'is-on': search.withReplace }"
        :title="t('search.replaceToggle')"
        data-testid="search-toggle-replace"
        @click="onToggleReplace"
      >{{ t("search.replace") }}</button>
      <button class="searchbar__close" :title="t('search.close')" data-testid="search-close" @click="closeSearch()">×</button>
    </div>

    <div v-if="canReplace && search.withReplace" class="searchbar__row">
      <input
        ref="replaceInput"
        class="searchbar__input"
        data-testid="replace-input"
        type="text"
        :value="search.replacement"
        :placeholder="t('search.replaceWith')"
        spellcheck="false"
        @keydown="onReplaceKeydown"
        @input="onReplaceInput"
        @compositionstart="composingReplace = true"
        @blur="composingReplace = false"
        @compositionend="onReplaceCompositionEnd"
      />
      <button data-testid="replace-one" :disabled="!search.matches.length" @click="replaceCurrent()">{{ t("search.replace") }}</button>
      <button data-testid="replace-all" :disabled="!search.matches.length" @click="replaceAllMatches()">
        {{ t("search.replaceAll") }}
      </button>
    </div>

    <!--
 146：替换回执（要求：「替换功能增加结果反馈」）。
      与正则报错那条各占一行、各有各的 testid —— 合并成一条会把"没匹配到"和"表达式写坏了"混成一谈。
    -->
    <p v-if="search.feedback" class="searchbar__hint" data-testid="search-feedback">{{ search.feedback }}</p>
    <p v-if="search.error" class="searchbar__error" data-testid="search-error">{{ search.error }}</p>
  </div>
</template>

<style scoped>
.searchbar {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--hp-border);
  border-radius: 8px;
  background: var(--hp-surface);
  box-shadow: 0 8px 26px var(--hp-shadow);
}

.searchbar__row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.searchbar__input {
  width: 220px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--hp-border);
  border-radius: 5px;
  background: var(--hp-bg);
  color: var(--hp-text);
  font-size: 13px;
}

.searchbar__count {
  min-width: 52px;
  font-size: 12px;
  color: var(--hp-text-weak);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.searchbar__count.is-empty {
  color: var(--hp-error);
}

.searchbar__opt.is-on {
  background: var(--hp-selected);
  color: var(--hp-accent);
  border-color: var(--hp-border);
}

.searchbar__sep {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--hp-border);
}

.searchbar__close {
  width: 22px;
  color: var(--hp-text-weak);
}

.searchbar__error {
  margin: 0;
  padding-left: 2px;
  color: var(--hp-error);
  font-size: 12px;
}

/* 146：替换回执是"做成了"的陈述，不是报错，所以用弱色不用红 */
.searchbar__hint {
  margin: 0;
  padding-left: 2px;
  color: var(--hp-text-weak);
  font-size: 12px;
}
</style>
