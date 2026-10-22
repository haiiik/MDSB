<script setup lang="ts">
import { t } from "../i18n";
import { computed, ref, watch } from "vue";
import type { BlockTarget, ToolbarState } from "../kernel/pm/toolbar";

/**
 * 113：编辑模式顶部的块类型 / 行内标记工具栏（US-38 后半）。
 *
 * 刻意做成**哑组件**：只吃 `state`（EditView 从 PM 的 EditorState 读出来的）
 * 和三个事件，不认识 ProseMirror。「按钮亮不亮、点了该变成什么」全部在
 * `kernel/pm/toolbar.ts` 的单测里钉，这里只留一层皮。
 *
 * 按钮清单按工单注记收着给（别一上来铺 20 个）：正文 / H1–H3 / 引用 / 代码块 /
 * 无序 / 有序 / 任务 + 加粗 / 斜体 / 链接。列宽不进工具栏（D9 不做列宽持久化）。
 *
 * 130 起**字号进工具栏最右**：她指出设置里那颗「基础字号」与缩放重复，删了设置项、
 * 把选择挪到编辑档里 —— 于是这颗**只作用编辑档**（阅读档要大小请用缩放）。
 * 值仍然存在 `state/settings.ts`（跨重启记住），组件不认识 store，照旧只吃 props 发事件。
 */

const props = defineProps<{ state: ToolbarState; fontSize: number }>();

const emit = defineEmits<{
  block: [target: BlockTarget];
  mark: [which: "bold" | "italic"];
  link: [href: string];
  /** 137：打开「插入文档链接」弹层 */
  doclink: [];
  fontsize: [px: number];
}>();

/**
 * 130：**这颗先隐藏**。她原话「编辑模式的字号是给编辑用的，并不是类似缩放功能，
 * 既然你不清楚，那就先隐藏掉这个功能」—— 我要的语义没对齐（是排版正文的字号？还是编辑器 UI 的字号？
 * 与缩放/阅读档怎么分工？），所以不做成"猜一个先上线"。
 * 管线全部留着（`settings.baseFontSize` → EditorPane → EditView → `.hp-doc` 的 `--hp-font-base`），
 * 对齐完只要把这个开关翻回 true，控件与判据都在原地。
 * 设置对话框里那条「基础字号」是**她明确要删的**（与缩放重复），不随这个开关回来。
 */
const SHOW_FONT_SIZE = false;

/** 档位与设置里原来那组一致，另加 20（她要在编辑档里放大的余地） */
const FONT_SIZES = [14, 15, 16, 18, 20];

function onFontSize(e: Event) {
  emit("fontsize", Number((e.target as HTMLSelectElement).value));
}

type Item =
  | { kind: "sep"; id: string }
  | { kind: "block"; id: string; label: string; title: string; target: BlockTarget }
  | { kind: "mark"; id: string; label: string; title: string; which: "bold" | "italic" };

const s = computed(() => props.state);

/** 代码块 / 表格里：块级与行内标记按钮都不适用（Markdown 里代码内没有标记语义） */
/** 代码块 / 表格里：块级按钮不适用（Markdown 里代码内没有标记语义；单元格本身就是行内容器） */
const blocked = computed(() => s.value.inCode || s.value.inTable);
/** 行内标记（粗/斜/链接）的可用性：只有代码块里不适用，表格里照样能加粗/加链接 */
const marksBlocked = computed(() => s.value.inCode);

/**
 * 139：**清单做成函数而不是模块级常量** —— 常量等于在 import 那一刻就把语言烘死，
 * 切到 English 也不会变（`tableMenu.ts` 同一个坑，同一个解法）。
 */
function items(): Item[] {
  return [
    { kind: "block", id: "paragraph", label: t("tb.body"), title: t("tb.bodyTitle"), target: { kind: "paragraph" } },
    { kind: "block", id: "h1", label: "H1", title: t("tb.h1Title"), target: { kind: "heading", level: 1 } },
    { kind: "block", id: "h2", label: "H2", title: t("tb.h2Title"), target: { kind: "heading", level: 2 } },
    { kind: "block", id: "h3", label: "H3", title: t("tb.h3Title"), target: { kind: "heading", level: 3 } },
    { kind: "sep", id: "sep1" },
    { kind: "block", id: "quote", label: t("tb.quote"), title: t("tb.quoteTitle"), target: { kind: "quote" } },
    { kind: "block", id: "code", label: t("tb.code"), title: t("tb.codeTitle"), target: { kind: "code" } },
    { kind: "sep", id: "sep2" },
    { kind: "block", id: "bullet", label: t("tb.bullet"), title: t("tb.bulletTitle"), target: { kind: "bullet" } },
    { kind: "block", id: "ordered", label: t("tb.ordered"), title: t("tb.orderedTitle"), target: { kind: "ordered" } },
    { kind: "block", id: "task", label: t("tb.task"), title: t("tb.taskTitle"), target: { kind: "task" } },
    { kind: "sep", id: "sep3" },
    { kind: "mark", id: "bold", label: t("tb.bold"), title: t("tb.boldTitle"), which: "bold" },
    { kind: "mark", id: "italic", label: t("tb.italic"), title: t("tb.italicTitle"), which: "italic" },
  ];
}

/** 语言是响应式的：切语言后这一份要跟着换，所以走 computed 而不是常量 */
const ITEMS = computed(items);

/** 当前项是否高亮：与 toolbarState 同一份数据源，不另算一套 */
function active(item: Item): boolean {
  if (item.kind === "block") {
    const t = item.target;
    const v = s.value;
    switch (t.kind) {
      case "paragraph":
        return v.block === "paragraph";
      case "heading":
        return v.block === "heading" && v.level === t.level;
      case "quote":
        return v.block === "blockquote";
      case "code":
        return v.block === "code";
      case "bullet":
        return v.list === "bullet" && v.checked === null;
      case "ordered":
        return v.list === "ordered";
      case "task":
        return v.checked !== null;
    }
  }
  if (item.kind === "mark") return item.which === "bold" ? s.value.bold : s.value.italic;
  return false;
}

/**
 * 置灰规则：
 * - **代码块里**（含 Mermaid 源）块级与行内标记全部不适用 —— Markdown 里围栏内没有标记语义；
 * - **表格里**只有块级按钮不适用（单元格本身就是行内容器，套引用/列表没意义），
 *   而加粗/斜体/链接**仍然可用**：`| **粗** |` 是合法 GFM。
 *   （桌面截图自查时发现整排灰掉过于保守，113 收口时改的。）
 */
function disabled(item: Item): boolean {
  if (item.kind === "sep") return false;
  if (item.kind === "mark") return marksBlocked.value;
  return blocked.value;
}

function click(item: Item) {
  if (item.kind === "block") emit("block", item.target);
  else if (item.kind === "mark") emit("mark", item.which);
}

/** 链接：URL 用小输入框，不用 window.prompt（桌面壳里 prompt 不可用） */
const linkOpen = ref(false);
const linkHref = ref("");
const linkInput = ref<HTMLInputElement | null>(null);

watch(linkOpen, (open) => {
  if (open) void Promise.resolve().then(() => linkInput.value?.focus());
});

function applyLink() {
  emit("link", linkHref.value.trim());
  linkOpen.value = false;
  linkHref.value = "";
}
</script>

<template>
  <div class="edit-toolbar" data-testid="edit-toolbar" role="toolbar" :aria-label="t('toolbar.aria')">
    <button
      v-for="item in ITEMS"
      :key="item.id"
      :class="[
        'edit-toolbar__btn',
        item.kind === 'sep' ? 'edit-toolbar__sep' : '',
        item.kind !== 'sep' && active(item) ? 'is-active' : '',
        disabled(item) ? 'is-disabled' : '',
      ]"
      :data-testid="item.kind === 'sep' ? undefined : 'tb-' + item.id"
      :disabled="disabled(item)"
      :title="item.kind === 'sep' ? '' : item.title"
      type="button"
      @mousedown.prevent
      @click="click(item)"
    >
      {{ item.kind === "sep" ? "" : item.label }}
    </button>

    <span class="edit-toolbar__group">
      <button
        class="edit-toolbar__btn"
        :class="{ 'is-active': linkOpen, 'is-disabled': marksBlocked }"
        data-testid="tb-link"
        :disabled="marksBlocked"
        :title="t('toolbar.link')"
        type="button"
        @click="linkOpen = !linkOpen"
      >{{ t("toolbar.link") }}</button>
      <template v-if="linkOpen">
        <input
          ref="linkInput"
          v-model="linkHref"
          class="edit-toolbar__input"
          data-testid="tb-link-input"
          placeholder="https://…"
          type="text"
          @keydown.enter.prevent="applyLink"
          @keydown.esc="linkOpen = false"
        />
        <button class="edit-toolbar__btn" data-testid="tb-link-apply" type="button" @click="applyLink">
          {{ t("toolbar.linkOk") }}
        </button>
        <button
          class="edit-toolbar__btn"
          data-testid="tb-link-clear"
          :title="t('toolbar.clearLink')"
          type="button"
          @click="emit('link', '')"
        >
          {{ t("toolbar.linkClear") }}
        </button>
      </template>
    </span>

    <!-- 137：从当前目录挑一篇文档插成链接。放在「链接」后面，因为它就是链接的一种 -->
    <button
      class="edit-toolbar__btn"
      :class="{ 'is-disabled': marksBlocked }"
      :disabled="marksBlocked"
      data-testid="tb-doclink"
      :title="t('toolbar.doclink')"
      type="button"
      @click="emit('doclink')"
    >{{ t("toolbar.doclink") }}</button>

    <!-- 130：字号选择靠最右（它不是"格式按钮"，视觉上要与左边那一排分开）。**当前隐藏**，见脚本里的 SHOW_FONT_SIZE -->
    <template v-if="SHOW_FONT_SIZE">
      <span class="edit-toolbar__spacer" aria-hidden="true" />
      <label class="edit-toolbar__font">
        字号
        <select
          class="edit-toolbar__select"
          data-testid="tb-fontsize"
          :title="t('toolbar.fontSize')"
          :value="fontSize"
          @change="onFontSize"
        >
          <option v-for="px in FONT_SIZES" :key="px" :value="px">{{ px }}</option>
        </select>
      </label>
    </template>
  </div>
</template>

<style scoped>
.edit-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  /* 147：这些尺寸走 :root 的变量，与阅读档那条空栏同一份来源 */
  padding: var(--hp-toolbar-pad-y) var(--hp-toolbar-pad-x);
  border-bottom: 1px solid var(--hp-border);
  background: var(--hp-bg);
  font-size: var(--hp-toolbar-font);
  /* 行高写在容器上：按钮那条 `font: inherit` 是简写，会把 line-height 一起重置成 normal，
     写在按钮自己身上等于没写（实测空栏比真栏高 2px）。写在容器上，按钮与占位元素继承同一个值。 */
  line-height: var(--hp-toolbar-line);
}

.edit-toolbar__group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.edit-toolbar__btn {
  min-width: 34px;
  padding: var(--hp-toolbar-btn-pad-y) var(--hp-toolbar-btn-pad-x);
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--hp-text);
  font: inherit;
  cursor: pointer;
}

.edit-toolbar__btn:hover {
  border-color: var(--hp-border);
}

.edit-toolbar__btn.is-active {
  border-color: var(--hp-accent);
  background: var(--hp-accent-soft, rgba(43, 108, 176, 0.12));
  color: var(--hp-accent);
}

.edit-toolbar__btn.is-disabled {
  color: var(--hp-text-weak);
  opacity: 0.5;
  cursor: default;
}

.edit-toolbar__sep {
  width: 1px;
  min-width: 1px;
  height: 18px;
  padding: 0;
  border: 0;
  background: var(--hp-border);
  cursor: default;
}

.edit-toolbar__input {
  width: 220px;
  padding: 3px 8px;
  border: 1px solid var(--hp-border);
  border-radius: 4px;
  background: var(--hp-surface);
  color: var(--hp-text);
  font: inherit;
}

/* 把字号那颗推到最右；窗口窄时靠上面的 flex-wrap 换行，不挤压按钮 */
.edit-toolbar__spacer {
  flex: 1 1 auto;
  min-width: 8px;
}

.edit-toolbar__font {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--hp-text-weak);
}

.edit-toolbar__select {
  padding: 2px 4px;
  border: 1px solid var(--hp-border);
  border-radius: 4px;
  background: var(--hp-surface);
  color: var(--hp-text);
  font: inherit;
}
</style>
