<script setup lang="ts">
import { onBeforeUnmount, onMounted, computed, ref } from "vue";
import { getHost } from "../state/documents";
import { confirmQuit } from "../state/quit";
import { view } from "../state/view";
import { t } from "../i18n";

/**
 * 外壳改造后的顶栏：只剩**品牌、拖动区、窗口三键**。
 * - 三档模式（阅读 / 编辑 / 源码）不是这里的按钮：122 收成标签栏右侧一个循环按钮，
 *   124 又在底栏加了直达的三按钮组（实现见 `TabBar.vue`、`StatusBar.vue` 与 `documents.setMode`）。
 * - 设置按钮也挪到标签栏右侧并换成齿轮（`data-testid="open-settings"` 跟着挪，用例不用改）。
 *
 * D18 不变：模式切换只走界面点击，不占用快捷键。
 */

const maximised = ref(false);

/**
 * 128：品牌标记换成 star-doc 那套「星里挖一张纸页」的图标，**深浅两套是各自设计的配色**
 * （不是同一张反过来：纸白磁贴要投影、近黑磁贴要描边），所以跟着主题换两张。
 *
 * 129：**两张都改成 SVG 矢量，不再用 48px PNG**。她反馈「图标有锯齿」—— 量出来确实是：
 * 48 的位图要铺到 20 CSS px（本机 175% ≈ 35 设备像素）是非整数倍缩小，
 * 而 md 档那圈**点状描边**在这种缩放下每段只剩一两个像素，边缘就碎成噪点。
 * 换成矢量母版后由浏览器按设备像素比栅格化，任何缩放档都是干净的。
 * 对照图（同一颗的 PNG / SVG / 透明底 / 单色剪影，各带 8× 放大看边缘）见
 * `.scratch/m2/evidence/顶栏标记-候选对照.png`。
 * 想换成「透明底那颗」（无磁贴、无描边，更贴文字）只换 `public/` 两张 SVG，别的都不用动。
 */
const brandLogo = computed(() => (view.theme === "dark" ? "/logo-dark.svg" : "/logo.svg"));

async function refreshMaximised() {
  const h = getHost();
  if (h) maximised.value = await h.windowIsMaximised();
}

async function winMinimise() {
  await getHost()?.windowMinimise();
}

async function winToggleMaximise() {
  await getHost()?.windowToggleMaximise();
  await refreshMaximised();
}

/** 关闭必须走未保存确认，不能直接杀进程（015 验收） */
async function winClose() {
  await confirmQuit();
}

// 最大化状态可能被系统改了（Win 键、任务栏双击），跟随窗口尺寸变化刷新图标
const onResize = () => void refreshMaximised();
onMounted(() => {
  void refreshMaximised();
  window.addEventListener("resize", onResize);
});
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

/* ---- 拖动：beta.24 没有可用的 CSS 非客户区，只能 Position/SetPosition 位移 ---- */
const dragging = ref(false);
let lastX = 0;
let lastY = 0;

function onCaptionDown(e: PointerEvent) {
  if (e.button !== 0) return;
  dragging.value = true;
  lastX = e.screenX;
  lastY = e.screenY;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onCaptionMove(e: PointerEvent) {
  if (!dragging.value) return;
  const h = getHost();
  if (!h) return;
  // screenX/Y 是 CSS 像素，窗口坐标是物理像素，换算在宿主侧做
  void h.windowDragMove(e.screenX - lastX, e.screenY - lastY);
  lastX = e.screenX;
  lastY = e.screenY;
}

function onCaptionUp(e: PointerEvent) {
  dragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
}
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <div class="topbar__brand" title="MDStar">
      <img class="topbar__logo" :src="brandLogo" alt="" data-testid="brand-logo" />
      <!-- 128：软件名 MDSB → MDStar（全称 Markdown Star Browser 只留在 exe 属性页的 FileDescription 里）。
           品牌位只放短名；再往前的 HorseParty 与「马嗅纸」图形一起退役，见 assets/brand/README.md -->
      <span class="topbar__name">MDStar</span>
    </div>

    <div
      class="topbar__drag"
      data-testid="caption-drag"
      @pointerdown="onCaptionDown"
      @pointermove="onCaptionMove"
      @pointerup="onCaptionUp"
      @dblclick="winToggleMaximise"
    />

    <div class="topbar__win">
      <button :title="t('win.minimize')" data-testid="win-min" @click="winMinimise">
        <span class="win-icon win-icon--min" aria-hidden="true" />
      </button>
      <button :title="maximised ? t('win.restore') : t('win.maximize')" data-testid="win-max" @click="winToggleMaximise">
        <span class="win-icon" :class="maximised ? 'win-icon--restore' : 'win-icon--max'" aria-hidden="true" />
      </button>
      <button class="is-close" :title="t('win.close')" data-testid="win-close" @click="winClose">
        <span class="win-icon win-icon--close" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--hp-topbar-h);
  padding: 0 10px;
  background: var(--hp-surface);
  border-bottom: 1px solid var(--hp-border);
}

.topbar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar__logo {
  width: 20px;
  height: 20px;
  /* 129：不再写 border-radius —— 图本身就是带圆角与投影的磁贴，
     再套一层 5px 圆角会把投影切掉、把边缘重新切出硬台阶 */
  display: block;
}

.topbar__name {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.topbar__drag {
  flex: 1;
  align-self: stretch;
  min-width: 24px;
  touch-action: none;
}

.topbar__win {
  display: flex;
  gap: 2px;
}

/**
 * 窗口三键：三个都是 30×22 的盒子，图标是**画出来的 10px 几何形状**，不是字符。
 *
 * 原来写的是「— / □ / ×」三个字符，三颗看着不一样大：
 * 全角破折号本身比另两个字宽，而且它的基线在字面中线、不在几何中线，
 * 「最小化」那条线就画得又长又靠下 —— 她指出的「最小化按钮大小偏大」就是这个。
 * 画图形之后与字体度量无关，深浅档、任何缩放档下三颗都一样大。
 */
.topbar__win button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 22px;
  padding: 0;
  color: var(--hp-text-weak);
}

.topbar__win button:hover {
  background: var(--hp-hover);
  color: var(--hp-text);
}

.topbar__win button.is-close:hover {
  background: var(--hp-error);
  color: #fff;
}

.win-icon {
  position: relative;
  display: block;
  width: 10px;
  height: 10px;
}

.win-icon--min::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 2px;
  height: 1px;
  background: currentColor;
}

.win-icon--max::after {
  content: "";
  position: absolute;
  inset: 1px 0 0 1px;
  border: 1px solid currentColor;
  border-radius: 1px;
}

.win-icon--restore::before,
.win-icon--restore::after {
  content: "";
  position: absolute;
  border: 1px solid currentColor;
  border-radius: 1px;
}

.win-icon--restore::before {
  inset: 0 3px 3px 2px;
}

.win-icon--restore::after {
  inset: 2px 0 0 4px;
  background: var(--hp-surface);
}

.win-icon--close::before,
.win-icon--close::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 4.5px;
  height: 1px;
  background: currentColor;
}

.win-icon--close::before {
  transform: rotate(45deg);
}

.win-icon--close::after {
  transform: rotate(-45deg);
}
</style>
