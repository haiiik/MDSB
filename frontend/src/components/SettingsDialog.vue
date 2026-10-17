<script setup lang="ts">
import { settings, settingsOpen } from "../state/settings";

/** 130：只报「产品名 · 版本」——`wails · windows` 这些实现细节她不要看了（原来那行是 hostLabel · v版本） */
defineProps<{ version: string }>();

/**
 * 127：**主题不在这里了** —— 挪到标签栏齿轮右侧的主题开关（`ThemeToggle.vue`）。
 * 一个设置项只留一个入口（122 收模式切换时定的口径），这里不再放第二份。
 */
function close() {
  settingsOpen.value = false;
}
</script>

<template>
  <div v-if="settingsOpen" class="mask" data-testid="settings-dialog" @click.self="close">
    <div class="box" role="dialog" aria-modal="true">
      <header class="box__head">
        <h3>设置</h3>
        <button class="box__x" data-testid="settings-close" @click="close">×</button>
      </header>

      <div class="rows">
        <label class="row">
          <span class="row__label">
            自动保存
            <small class="row__hint">开启后停止输入 1 秒落盘；关闭时只用 Ctrl+S</small>
          </span>
          <input v-model="settings.autoSave" type="checkbox" data-testid="setting-autosave" />
        </label>

        <!-- 130：「基础字号」整行删掉 —— 她说这颗与缩放重复。
             曾短暂挪进编辑工具栏，但那颗的语义没对齐（不是缩放），当前连工具栏那颗一起隐藏
             （开关 `EditToolbar.vue` 的 SHOW_FONT_SIZE）。别看到"少一个设置项"就顺手加回来。 -->

        <label class="row">
          <span class="row__label">
            代码块行号
            <small class="row__hint">只影响阅读与编辑时的显示，不改动文档内容</small>
          </span>
          <input v-model="settings.codeLineNumbers" type="checkbox" data-testid="setting-linenumbers" />
        </label>
      </div>

      <p class="note">
        设置立即生效并自动记住。
        <!-- 130：版本信息留在这儿（底栏那条已删），但只写「产品名 · 版本」，不再报宿主与平台 -->
        <span class="note__ver" data-testid="setting-version">MDStar v{{ version }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--hp-mask);
}

.box {
  width: min(460px, 92vw);
  border: 1px solid var(--hp-border);
  border-radius: 8px;
  background: var(--hp-surface);
  box-shadow: 0 12px 40px var(--hp-shadow);
}

.box__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--hp-border);
}

.box__head h3 {
  margin: 0;
  font-size: 15px;
}

.box__x {
  font-size: 16px;
  color: var(--hp-text-weak);
}

.rows {
  padding: 8px 18px 4px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--hp-border-weak, rgba(0, 0, 0, 0.06));
  font-size: 13px;
}

.row__label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row__hint {
  color: var(--hp-text-weak);
  font-size: 11px;
  font-weight: 400;
}

select {
  font: inherit;
  padding: 3px 8px;
  border: 1px solid var(--hp-border);
  border-radius: 4px;
  background: var(--hp-surface);
  color: inherit;
}

input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--hp-accent);
}

.note {
  margin: 10px 18px 16px;
  color: var(--hp-text-weak);
  font-size: 12px;
}

/* 版本那截靠右、更淡，别和「设置立即生效」抢同一行视觉重量 */
.note__ver {
  float: right;
  color: var(--hp-text-weak);
  opacity: 0.75;
  font-family: var(--hp-font-md);
}
</style>
