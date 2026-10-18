<script setup lang="ts">
import { t } from "../i18n";
import { computed, nextTick, ref, watch } from "vue";
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

const OPTIONS = [
  { key: "caseSensitive", label: "Aa", title: "区分大小写" },
  { key: "wholeWord", label: "全词", title: "全词匹配" },
  { key: "regex", label: ".*", title: "正则表达式" },
] as const;

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

function onKeydown(e: KeyboardEvent): void {
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
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSearch();
  }
}

watch(
  () => search.open,
  (open) => {
    if (open) focusInput();
  },
  { immediate: true }
);

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
        @input="setSearchQuery(($event.target as HTMLInputElement).value)"
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
      >
        替换
      </button>
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
        @input="search.replacement = ($event.target as HTMLInputElement).value"
      />
      <button data-testid="replace-one" :disabled="!search.matches.length" @click="replaceCurrent()">替换</button>
      <button data-testid="replace-all" :disabled="!search.matches.length" @click="replaceAllMatches()">
        替换全部
      </button>
    </div>

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
</style>
