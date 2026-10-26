<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import { activeTab } from "../state/documents";
import { exportHtml, exportPdf, printDoc } from "../state/output";
import { t } from "../i18n";

/**
 * 154 / 155 / 156 的入口，放在**阅读档顶上那条栏的左端**（与编辑档工具栏同一个起点）。
 *
 * 形状（2026-10-26 定）：「打印」单独一颗（最常用，少一次点击，`Ctrl+P` 也直达），
 * 两份导出收进「导出 ▾」一个菜单里。设置里那一组**撤掉了** —— 一个功能只留一个入口
 * （122 收模式切换时定的口径），两处放着早晚对不上。
 *
 * 只在阅读档放：编辑档那条工具栏已经排到 13 颗按钮，再塞会 `flex-wrap` 换行，
 * 一换行"两档顶上那条栏等高"就破了（147 那两条判据会红）。
 */

const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const 菜单位置 = ref({ left: 0, top: 0 });

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (!open.value) return;
  // 位置按按钮的实际盒子算（缩放 / 字号一变，硬写的偏移就会飘）
  await nextTick();
  const el = anchor.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  菜单位置.value = { left: r.left, top: r.bottom + 2 };
}

function 选(做什么: () => Promise<void>): void {
  open.value = false;
  void 做什么();
}

/** Esc 关菜单：用捕获阶段拦在页面级监听之前，别把 Esc 同时当成"关查找条/取消编辑" */
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && open.value) {
    open.value = false;
    e.stopPropagation();
  }
}
window.addEventListener("keydown", onKey, true);
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <span class="output-actions" data-testid="output-actions">
    <button
      class="edit-toolbar__btn"
      type="button"
      data-testid="bar-output-print"
      :disabled="!activeTab"
      :title="t('output.printHint')"
      @click="printDoc()"
    >
      {{ t("output.print") }}
    </button>

    <button
      ref="anchor"
      class="edit-toolbar__btn"
      :class="{ 'is-active': open }"
      type="button"
      data-testid="bar-output-export"
      :disabled="!activeTab"
      :aria-haspopup="true"
      :aria-expanded="open"
      :title="t('output.exportHint')"
      @click="toggle()"
    >
      {{ t("output.export") }} <span class="output-actions__caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="open" class="menu-mask" data-testid="output-menu-mask" @click="open = false">
      <ul
        class="menu output-menu"
        data-testid="output-menu"
        :style="{ left: 菜单位置.left + 'px', top: 菜单位置.top + 'px' }"
        @click.stop
      >
        <li>
          <button class="menu__item" type="button" data-testid="menu-output-html" @click="选(exportHtml)">
            {{ t("output.html") }}
          </button>
        </li>
        <li>
          <button class="menu__item" type="button" data-testid="menu-output-pdf" @click="选(exportPdf)">
            {{ t("output.pdf") }}
          </button>
        </li>
      </ul>
    </div>
  </span>
</template>

<style scoped>
.output-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.output-actions__caret {
  font-size: 0.8em;
  opacity: 0.7;
  /* 不参与行盒：箭头的字体度量会把这颗按钮撑高 1px（实测 131 vs 130） */
  line-height: 0;
}

/*
 * 盒子与编辑档工具栏的按钮**逐项同参**（同一批 `:root` 变量）。
 * 不是抄一份就完事：EditToolbar 那份 `.edit-toolbar__btn` 是 scoped 样式，
 * 选择器带它的 scope id，命中不到这里建的按钮 —— 少这一份，按钮没内边距、
 * 那条栏会比编辑档矮，147 钉的"两档等高"当场红。
 */
.edit-toolbar__btn {
  min-width: 34px;
  padding: var(--hp-toolbar-btn-pad-y) var(--hp-toolbar-btn-pad-x);
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--hp-text);
  font: inherit;
  line-height: var(--hp-toolbar-line);
  cursor: pointer;
}
.edit-toolbar__btn:hover:not(:disabled) {
  border-color: var(--hp-border);
}
.edit-toolbar__btn.is-active {
  border-color: var(--hp-accent);
  color: var(--hp-accent);
}
.edit-toolbar__btn:disabled {
  color: var(--hp-text-weak);
  opacity: 0.5;
  cursor: default;
}

/* 菜单：外壳与标签栏/侧栏那两处右键菜单同一套观感（这里 scoped 内自带一份，不跨组件抢样式） */
.menu-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.menu {
  position: fixed;
  min-width: 148px;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--hp-border);
  border-radius: 6px;
  background: var(--hp-surface);
  box-shadow: var(--hp-shadow);
}
.menu__item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--hp-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.menu__item:hover {
  background: var(--hp-hover);
}
</style>
