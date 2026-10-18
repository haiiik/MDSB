<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { t, tf } from "../i18n";
import { activeTab, clampZoom, MODE_CYCLE, modeLabel, setMode, setWidth, setZoom } from "../state/documents";
import { clearModeHint, modeHint } from "../state/modeInstances";
import { computeStats, type DocStats } from "../kernel/stats";
import type { WidthPreset } from "../kernel/render";

/**
 * 127：`info`（宿主 / 平台 / 版本）不再显示在这里 —— 底栏是干活时一直盯着的地方，
 * 「宿主=wails」是 M1 的自检字段，日常是噪音。版本挪进设置对话框底部（`SettingsDialog`）。
 */
defineProps<{ error: string }>();
const emit = defineEmits<{ "clear-error": [] }>();

const WIDTH_LABEL = {
  narrow: () => t("status.width.narrow"),
  normal: () => t("status.width.normal"),
  wide: () => t("status.width.wide"),
  full: () => t("status.width.full"),
} as const;

/**
 * 统计防抖：3000 行文档每次击键全量解析会拖慢输入（023 验收）。
 * 200ms 足够让人看不见延迟，又把连续输入合并成一次计算。
 */
const stats = ref<DocStats | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [activeTab.value?.id, activeTab.value?.markdown] as const,
  ([, md]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stats.value = md ? computeStats(md) : null;
    }, 200);
  },
  { immediate: true }
);
// 119：轻提示是「这一份文档刚才发生了什么」，换文档就不该还挂着上一条。
// 计时器由状态模块自己管，这里只负责在切标签时立刻收起。
watch(
  () => activeTab.value?.id,
  () => clearModeHint()
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <footer class="statusbar" data-testid="statusbar">
    <!--
      127（她的两条）：
      ① 「宿主=wails · windows · 0.1.1-dev」是 M1 001 的自检字段，日常看是噪音 —— 从底栏删掉，
         版本号挪进**设置对话框底部**（"我装的是哪一版"这个问题总得有个地方回答）；
      ② 模式三按钮进底栏（不再挤在字数与宽度之间）。
      **129 她把两组对调**：统计信息在最左、模式三按钮在右侧那一组的最前。
      顺序因此变成：字数 → 提示/错误 → （弹簧）→ 模式 → 宽度 → 缩放 → 文件名 → 脏标记。
      两组各归一边有个硬好处：**左侧只有统计会随文档长短变宽**，它单独占左边就不会把右边的控件推来推去；
      模式组贴着宽度/缩放，三个「看和改的开关」成一簇，手一伸都在同一个位置。
    -->
    <span
      v-if="activeTab && stats"
      class="statusbar__item statusbar__stats"
      data-testid="status-stats"
      :title="tf('status.statsTitle', { cjk: stats.cjk, latin: stats.latin })"
    >
      {{ stats.words }} 字 · {{ stats.lines }} 行 · {{ stats.headings }} 标题
    </span>
    <span v-if="!activeTab" class="statusbar__item placeholder" data-testid="status-not-opened">{{ t("status.notOpened") }}</span>
    <!--
      127：错误提示要能关。原来这条只能等下一次操作把它覆盖掉，
      用户看着底部一直挂着「找不到小节：xxx」却没有办法收起来 —— 加一个右侧的叉，
      点一下只关**当前这一条**（新的错误来了照样会显示）。
    -->
    <span v-if="error" class="statusbar__item statusbar__item--error" data-testid="status-error">
      {{ error }}
      <button
        class="statusbar__close"
        :title="t('status.closeHint')"
        :aria-label="t('status.closeHint')"
        data-testid="status-error-close"
        @click="emit('clear-error')"
      >
        ×
      </button>
    </span>
    <!-- 119（口径 Q4 的 A 案）：切回来发现另一头改过内容、撤销栈被重建 —— 必须说一句，
         否则用户按 Ctrl+Z 没反应，只会以为「撤销坏了」 -->
    <span v-if="modeHint" class="statusbar__item statusbar__item--hint" data-testid="status-hint">{{ modeHint }}</span>
    <span class="statusbar__spacer" />

    <template v-if="activeTab">
      <span class="statusbar__group statusbar__modes" data-testid="mode-picker">
        <button
          v-for="m in MODE_CYCLE"
          :key="m"
          class="statusbar__mode"
          :class="{ 'is-on': activeTab.mode === m }"
          :data-testid="'mode-' + m"
          :aria-pressed="activeTab.mode === m"
          :title="tf('mode.tooltip', { label: modeLabel(m) })"
          @click="setMode(m)"
        >
          {{ modeLabel(m) }}
        </button>
      </span>

      <!-- 外壳改造：4 档宽度按钮（窄/标准/宽/全宽）排成一行太占地方，收成一个上拉选项 -->
      <label class="statusbar__group" data-testid="width-picker">
        <strong>{{ t("status.width") }}</strong>
        <select
          class="statusbar__select"
          data-testid="width-select"
          :value="activeTab.width"
          :title="t('status.measureWidth')"
          @change="setWidth(($event.target as HTMLSelectElement).value as WidthPreset)"
        >
          <option v-for="(label, w) in WIDTH_LABEL" :key="w" :value="w">{{ label() }}</option>
        </select>
      </label>

      <span class="statusbar__group" data-testid="zoom-picker">
        <button :title="t('status.zoomOut')" data-testid="zoom-out" @click="setZoom(clampZoom(activeTab.zoom - 0.1))">−</button>
        <button :title="t('status.zoomReset')" data-testid="zoom-name" @click="setZoom(1)">
          {{ Math.round(activeTab.zoom * 100) }}%
        </button>
        <button :title="t('status.zoomIn')" data-testid="zoom-in" @click="setZoom(clampZoom(activeTab.zoom + 0.1))">+</button>
      </span>

      <!-- 130：右下角的文件名删了 —— 标签栏上就有名字，底栏再放一份是重复，
           而且长文件名会把宽度/缩放挤走。要看「现在开的是哪一篇」请押 `.tab.is-active`
           （原来有 7 处 e2e + 1 处桌面断言拿 `status-doc-name` 当这个探针，已一起换掉）。 -->
      <span
        v-if="activeTab.markdown !== activeTab.saved"
        class="statusbar__item statusbar__item--dirty"
        data-testid="status-dirty"
        :title="t('status.dirty')"
      >
        未保存
      </span>
    </template>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--hp-statusbar-h);
  padding: 0 8px;
  background: var(--hp-surface);
  border-top: 1px solid var(--hp-border);
  font-size: 12px;
}

.statusbar__item strong {
  color: var(--hp-text-weak);
  font-weight: 500;
}

/*
 * 127（她：「底栏里的字段和按钮要在底栏里上下居中」）：
 * 原来文字是裸 `<span>`（跟着行高与基线走），按钮是 18px 的盒子，
 * 两套对齐混在一行里，看着就是「字浮在上面、按钮沉在下面」。
 * 统一成**每个字段都是一个 20px 高的 flex 盒子、内容居中**，
 * 按钮与下拉仍按自己的高度画，但对齐基准只有一个。
 */
.statusbar__item,
.statusbar__group {
  display: inline-flex;
  align-items: center;
  height: 20px;
  line-height: 1;
}

.statusbar__item--error {
  color: var(--hp-error);
}

/* 关闭这条错误提示的叉：贴在提示右侧，字号比正文略大、行高对齐 */
.statusbar__close {
  margin-left: 6px;
  padding: 0 3px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  vertical-align: middle;
}

.statusbar__close:hover {
  color: var(--hp-text);
}

/* 119：轻提示不是错误，用次要色 + 斜体，别抢脏标记/统计的注意力 */
.statusbar__item--hint {
  color: var(--hp-text-weak);
  font-style: italic;
}

.statusbar__item--dirty {
  color: var(--hp-accent);
  font-weight: 600;
}

.statusbar__spacer {
  flex: 1;
}

.statusbar__group {
  display: flex;
  align-items: center;
  gap: 1px;
}

.statusbar__group strong {
  color: var(--hp-text-weak);
  font-weight: 500;
  margin-right: 2px;
}

.statusbar__group button {
  padding: 0 6px;
  height: 18px;
  color: var(--hp-text-weak);
  font-size: 11px;
}

.statusbar__group button.is-on {
  background: var(--hp-selected);
  color: var(--hp-accent);
  font-weight: 600;
}

/* 三档模式：紧挨着的按钮组，当前档高亮（这就是「代替模式状态文字」的那个控件） */
.statusbar__modes {
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--hp-border);
  border-radius: 5px;
}

.statusbar__mode {
  height: 18px;
  padding: 0 8px;
  border: 0;
  border-right: 1px solid var(--hp-border);
  background: var(--hp-bg);
  color: var(--hp-text-weak);
  font-size: 11px;
}

.statusbar__mode:last-child {
  border-right: 0;
}

.statusbar__mode.is-on {
  background: var(--hp-selected);
  color: var(--hp-accent);
  font-weight: 600;
}

/* 宽度改成上拉选项：与缩放那组按钮同高，别让 select 把状态栏顶高 */
.statusbar__select {
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--hp-border);
  border-radius: 4px;
  background: var(--hp-surface);
  color: var(--hp-text);
  font-size: 11px;
  font-family: inherit;
}
</style>
