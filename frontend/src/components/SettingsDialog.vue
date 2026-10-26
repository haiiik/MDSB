<script setup lang="ts">
import { settings, settingsOpen } from "../state/settings";
import { t } from "../i18n";

/** 130：只报「产品名 · 版本」——`wails · windows` 这些实现细节不该摆出来（原来那行是 hostLabel · v版本） */
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
        <h3>{{ t("dialog.settings") }}</h3>
        <button class="box__x" data-testid="settings-close" @click="close">×</button>
      </header>

      <div class="rows">
        <label class="row">
          <span class="row__label">
            {{ t("settings.autoSave") }}
            <small class="row__hint">{{ t("settings.autoSaveHint") }}</small>
          </span>
          <input v-model="settings.autoSave" type="checkbox" data-testid="setting-autosave" />
        </label>

        <!-- 130：「基础字号」整行删掉 —— 原话：这颗与缩放重复。
             曾短暂挪进编辑工具栏，但那颗的语义没对齐（不是缩放），当前连工具栏那颗一起隐藏
             （开关 `EditToolbar.vue` 的 SHOW_FONT_SIZE）。别看到"少一个设置项"就顺手加回来。 -->

        <label class="row">
          <span class="row__label">
            {{ t("settings.codeLineNumbers") }}
            <small class="row__hint">{{ t("settings.codeLineNumbersHint") }}</small>
          </span>
          <input v-model="settings.codeLineNumbers" type="checkbox" data-testid="setting-linenumbers" />
        </label>

        <!-- M3-134：界面语言。只有双选（已定的口径：**不做「跟随系统」**，装的时候已经选过一次） -->
        <label class="row">
          <span class="row__label">
            {{ t("settings.language") }}
            <small class="row__hint">{{ t("settings.languageHint") }}</small>
          </span>
          <select v-model="settings.lang" class="row__select" data-testid="setting-lang">
            <option value="zh">{{ t("lang.zh") }}</option>
            <option value="en">{{ t("lang.en") }}</option>
          </select>
        </label>
      </div>

      <!--
        154 / 155 / 156 的三颗动作**不在这里了**（2026-10-26）：它们是动作不是设置项，
        而且一个功能只留一个入口（122 收模式切换时定的口径）—— 现在只在阅读档顶上那条栏上
        （`OutputActions.vue`：「打印」+「导出 ▾」），`Ctrl+P` 照旧直达打印。
        别看到"设置里少一组"就顺手加回来。
      -->

      <p class="note">
        {{ t("settings.appliesNote") }}
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

/* 154–156：输出那一组。与上面设置项之间留一条分隔，视觉上是"另一件事" */


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
