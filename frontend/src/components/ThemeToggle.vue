<script setup lang="ts">
import { t, tf } from "../i18n";
import { computed } from "vue";
import { view } from "../state/view";

/**
 * 127：主题开关从设置里挪到标签栏齿轮右侧（原始诉求：「主题从设置中移出来，放到设置右侧，
 * 左太阳月亮图标滑动或并排按钮，右侧与上方的关闭按钮对齐，注意是视觉效果对齐」）。
 *
 * 三个决定：
 * - **图标是画的，不是 ☀/🌙 字符**：齿轮那次已经证明，emoji/字符在不同字体档位下宽高与基线都不稳，
 *   而这一颗要和窗口三键的右缘对齐，尺寸必须可控；
 * - **两个并排的按钮 + 一块滑动的底衬**：既能直接点选（不用先知道当前在哪档），
 *   又有「滑动」的反馈；`aria-pressed` 让读屏能听出当前档；
 * - 值仍然只有 `view.theme` 一个来源（浅色 / 深色），设置里那条**删掉**，不留第二个入口 ——
 *   两处入口迟早会打架（122 收模式切换按钮时定的口径）。
 */
/** 139：档位标签是界面文案，走字典；且做成 computed（常量会把语言烘死在 import 那一刻） */
const orders = computed(() => [
  { value: "light" as const, label: t("theme.light"), testid: "theme-light" },
  { value: "dark" as const, label: t("theme.dark"), testid: "theme-dark" },
]);
</script>

<template>
  <div class="themepill" role="group" :aria-label="t('theme.label')" data-testid="theme-switch">
    <span class="themepill__thumb" :data-dark="view.theme === 'dark' ? '1' : '0'" aria-hidden="true" />
    <button
      v-for="o in orders"
      :key="o.value"
      class="themepill__btn"
      type="button"
      :title="tf('theme.pick', { label: o.label })"
      :aria-label="tf('theme.pick', { label: o.label })"
      :aria-pressed="view.theme === o.value"
      :data-testid="o.testid"
      @click="view.theme = o.value"
    >
      <!-- 太阳：圆心 + 8 道射线（stroke 画，粗细不随字号变） -->
      <svg v-if="o.value === 'light'" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <circle cx="12" cy="12" r="4.1" fill="currentColor" />
        <path
          d="M12 2.4v2.5M12 19.1v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.4 12h2.5M19.1 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
        />
      </svg>
      <!-- 月亮：闭合月牙，单条子路径，fill 实心 -->
      <svg v-else viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path
          d="M20.9 12.8A9 9 0 1 1 11.2 3.1 7 7 0 0 0 20.9 12.8Z"
          fill="currentColor"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/*
 * 22px 高 —— 与齿轮按钮同高；右缘对齐由标签栏的 padding 负责（见 TabBar.vue），
 * 这里不吃 margin，免得两处各调一半最后对不上。
 */
.themepill {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  align-self: center;
  height: 22px;
  padding: 2px;
  border: 1px solid var(--hp-border);
  border-radius: 11px;
  background: var(--hp-bg);
}

.themepill__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 18px;
  border-radius: 9px;
  background: var(--hp-hover);
  transition: transform 160ms ease;
}

.themepill__thumb[data-dark="1"] {
  /* 一格 24px + 按钮间无间隙，所以位移就是一个格的宽度 */
  transform: translateX(24px);
}

.themepill__btn {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--hp-text-weak);
  cursor: pointer;
}

.themepill__btn:hover {
  color: var(--hp-text);
}

.themepill__btn[aria-pressed="true"] {
  color: var(--hp-accent);
}
</style>
