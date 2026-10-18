<script setup lang="ts">
import { t } from "../i18n";
import { dialog, dismissDialog } from "../state/dialogs";

function choose(action: string) {
  dialog.current?.resolve(action);
}
</script>

<template>
  <div v-if="dialog.current" class="mask" data-testid="confirm-dialog" @click.self="dismissDialog()">
    <div class="box" role="dialog" aria-modal="true">
      <h3 class="box__title">{{ dialog.current.title }}</h3>
      <p class="box__message">{{ dialog.current.message }}</p>
      <div class="box__actions">
        <button
          v-for="(a, i) in dialog.current.actions"
          :key="a"
          :class="{ 'is-primary': i === 0 }"
          :data-testid="'confirm-' + a"
          @click="choose(a)"
        >
          {{ a }}
        </button>
        <button class="box__cancel" data-testid="confirm-cancel" @click="dismissDialog()">{{ t("common.cancel") }}</button>
      </div>
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
  width: min(420px, 90vw);
  padding: 20px 22px;
  border: 1px solid var(--hp-border);
  border-radius: 8px;
  background: var(--hp-surface);
  box-shadow: 0 12px 40px var(--hp-shadow);
}

.box__title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}

.box__message {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--hp-text-weak);
  white-space: pre-line;
}

.box__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.box__actions button {
  padding: 5px 14px;
  border: 1px solid var(--hp-border);
  border-radius: 5px;
}

.box__actions button.is-primary {
  border-color: var(--hp-accent);
  background: var(--hp-accent);
  color: var(--hp-on-accent);
}

.box__cancel {
  color: var(--hp-text-weak);
}
</style>
