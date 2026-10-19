<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { getHost } from "../host";
import type { MdEntry } from "../host/types";
import { buildLink, dirOf, matchesQuery, stemOf } from "../kernel/docLinks";
import { t, tf } from "../i18n";
import { activePath } from "../state/documents";

/**
 * 137「插入文档链接」的弹层：从当前文件所在目录往下挑一篇 .md，插成 `[文件名](路径)`。
 *
 * 三条设计口径（都写进判据）：
 * 1. **基准 = 当前文件所在目录**（Q28 她定的），不引入"工作区根"概念；
 * 2. **相对 / 绝对两行都显示**，并且把**最终会插进文档的那串 Markdown 原样预览出来** ——
 *    路径这种东西"看着对、插进去打不开"是最差的失败，不能让她靠想象；
 * 3. **当前文件未保存时相对路径禁用**：没有基准就不假装有一个。
 *    这时连扫描根都没有，所以列表是空的 + 一句人话说明，而不是转圈或报错。
 */

const emit = defineEmits<{
  (e: "close"): void;
  (e: "insert", payload: { text: string; href: string }): void;
}>();

/** 与 Go 侧 mdScanLimit 对齐：一次最多扫这么多，弹层不能把界面卡住 */
const SCAN_CAP = 400;
/** 列表一次最多渲染这么多行（再多也只按搜索缩小，不做虚拟滚动 —— 那是 123 的决策） */
const SHOW_CAP = 60;

const query = ref("");
const entries = ref<MdEntry[]>([]);
const loading = ref(true);
const scanError = ref("");
const active = ref(0);
const preferRel = ref(true);
const input = ref<HTMLInputElement | null>(null);

const baseDir = computed(() => dirOf(activePath.value ?? ""));
const hasBase = computed(() => baseDir.value !== "");

const rows = computed(() => {
  const list = entries.value
    .filter((e) => matchesQuery(e.rel, query.value))
    .slice(0, SHOW_CAP)
    .map((e) => ({ name: e.name, rel: e.rel, link: buildLink(e.name, e.path, baseDir.value) }));
  return list;
});

/** 越界钳位：搜索把行数缩小后 active 可能指到不存在的行 */
const safeIndex = computed(() => Math.min(active.value, Math.max(0, rows.value.length - 1)));
const current = computed(() => rows.value[safeIndex.value] ?? null);
const canRel = computed(() => current.value?.link.mdRel != null);
const useRel = computed(() => preferRel.value && canRel.value);
/**
 * 最终要插进文档的那串 Markdown —— **预览与插入共用这一个 computed**，
 * 不允许两边各拼一次（两边一分叉，"预览对、落盘错"就没人能发现）。
 */
const chosenMd = computed(() => {
  const c = current.value;
  if (!c) return "";
  return useRel.value ? (c.link.mdRel ?? c.link.mdAbs) : c.link.mdAbs;
});

onMounted(async () => {
  void nextTick(() => input.value?.focus());
  if (!hasBase.value) {
    loading.value = false;
    return;
  }
  try {
    const h = await getHost();
    entries.value = await h.listMarkdown(baseDir.value, SCAN_CAP);
  } catch (err) {
    scanError.value = String(err instanceof Error ? err.message : err);
  } finally {
    loading.value = false;
  }
});

function move(step: number) {
  const n = rows.value.length;
  if (!n) return;
  active.value = (safeIndex.value + step + n) % n;
}

function confirmInsert() {
  const c = current.value;
  if (!c) return;
  // **href 取自 chosenMd（= 预览那一串）**，不另算一遍：预览与插入共用同一个表达式，
  // 否则就会出现"预览看着是 %20、落盘是空格 + 尖括号"这种两份真相（实测踩过一次）。
  emit("insert", { text: stemOf(c.name), href: hrefOf(chosenMd.value) });
}

/** 从 `[文字](路径)` 里取回路径部分 */
function hrefOf(md: string): string {
  const m = /\((.*)\)$/.exec(md);
  return m ? m[1] : md;
}

function onKey(ev: KeyboardEvent) {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    move(1);
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    move(-1);
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    confirmInsert();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    emit("close");
  }
}
</script>

<template>
  <div class="doclink" data-testid="doclink" role="dialog" :aria-label="t('doclink.title')" @keydown="onKey">
    <div class="doclink__head">
      <span class="doclink__title">{{ t("doclink.title") }}</span>
      <span class="doclink__base" :title="baseDir">{{ baseDir || t("doclink.noBase") }}</span>
    </div>

    <input
      ref="input"
      v-model="query"
      class="doclink__search"
      data-testid="doclink-search"
      type="text"
      :placeholder="t('doclink.search')"
      @input="active = 0"
    />

    <p v-if="loading" class="doclink__note" data-testid="doclink-loading">{{ t("doclink.loading") }}</p>
    <p v-else-if="scanError" class="doclink__note is-error" data-testid="doclink-error">
      {{ tf("doclink.scanError", { msg: scanError }) }}
    </p>
    <p v-else-if="!hasBase" class="doclink__note" data-testid="doclink-nobase">{{ t("doclink.noBase") }}</p>
    <p v-else-if="!rows.length" class="doclink__note" data-testid="doclink-empty">{{ t("doclink.empty") }}</p>

    <ul v-else class="doclink__list" data-testid="doclink-list">
      <li
        v-for="(r, i) in rows"
        :key="r.rel"
        class="doclink__item"
        :class="{ 'is-active': i === safeIndex }"
        :data-testid="'doclink-item'"
        @mouseenter="active = i"
        @click="confirmInsert"
      >
        <span class="doclink__name">{{ r.name }}</span>
        <span class="doclink__rel">{{ r.link.rel ?? r.link.abs }}</span>
      </li>
    </ul>

    <p v-if="entries.length >= SCAN_CAP" class="doclink__hint" data-testid="doclink-capped">
      {{ tf("doclink.capped", { n: SCAN_CAP }) }}
    </p>

    <div class="doclink__foot">
      <label class="doclink__mode" :class="{ 'is-off': !canRel }">
        <input v-model="preferRel" :disabled="!canRel" data-testid="doclink-rel" type="radio" name="doclink-mode" />
        {{ t("doclink.rel") }}
      </label>
      <label class="doclink__mode">
        <input v-model="preferRel" :checked="!preferRel" data-testid="doclink-abs" type="radio" name="doclink-mode" :value="false" />
        {{ t("doclink.abs") }}
      </label>
      <code class="doclink__preview" data-testid="doclink-preview">{{ chosenMd }}</code>
      <button class="doclink__btn" data-testid="doclink-insert" type="button" :disabled="!current" @click="confirmInsert">
        {{ t("doclink.insert") }}
      </button>
      <button class="doclink__btn" data-testid="doclink-cancel" type="button" @click="emit('close')">
        {{ t("common.cancel") }}
      </button>
    </div>
    <p class="doclink__hint">{{ t("doclink.relHint") }}</p>
  </div>
</template>

<style scoped>
.doclink {
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 30;
  width: min(520px, calc(100% - 24px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 8px;
  border: 1px solid var(--hp-border);
  border-radius: 8px;
  background: var(--hp-panel, var(--hp-bg, #fff));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.doclink__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.doclink__title {
  font-weight: 600;
}

.doclink__base {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--hp-text-weak);
  font-size: 12px;
}

.doclink__search {
  padding: 5px 8px;
  border: 1px solid var(--hp-border);
  border-radius: 5px;
  background: var(--hp-bg, #fff);
  color: var(--hp-text);
}

.doclink__note {
  margin: 4px 0;
  color: var(--hp-text-weak);
}

.doclink__note.is-error {
  color: var(--hp-danger, #c0392b);
}

.doclink__list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow: auto;
}

.doclink__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.doclink__item.is-active {
  background: var(--hp-accent);
  color: #fff;
}

.doclink__name {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doclink__rel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.85;
}

.doclink__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.doclink__mode {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  white-space: nowrap;
}

.doclink__mode.is-off {
  opacity: 0.45;
}

.doclink__preview {
  flex: 1;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--hp-text-weak);
}

.doclink__btn {
  padding: 3px 10px;
  border: 1px solid var(--hp-border);
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.doclink__btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.doclink__hint {
  margin: 0;
  font-size: 11px;
  color: var(--hp-text-weak);
}
</style>
