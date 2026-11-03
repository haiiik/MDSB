import { expect, it } from "vitest";
import { 标签浮层锚点, 窗边距 } from "../../src/kernel/tabPickerAnchor";

/**
 * 163（要求：「标签栏标签新增鼠标移入静置 1 秒鼠标浮窗显示文件全名」）。
 *
 * 钉的是那一小条**落在哪里**。延时 1 秒、只给被截断的那颗弹这些是组件里的事，
 * 由 E2E 与真壳判据量几何；这里只保证一件事：**浮层永远整片在窗口里**。
 * 右边那颗标签的浮层要是照着标签左缘放，就会横着捅出窗口 —— 原来钉死在左边不会有这问题，
 * 跟着标签走之后这是新出现的风险（与 162 同一个形状）。
 */

const 视口 = { width: 1280, height: 800 };
const 标签 = { top: 6, bottom: 28, left: 300, right: 400 };

it("左缘齐平标签，顶边落在标签下方（浮层跟着它那颗标签走）", () => {
  expect(标签浮层锚点(标签, 视口, 200)).toEqual({ top: 32, left: 300 });
});

it("靠右的标签：浮层放不下时把左缘夹进窗口，宁可让左缘不齐平标签", () => {
  const 靠右 = { top: 6, bottom: 28, left: 1150, right: 1250 };
  const 锚 = 标签浮层锚点(靠右, 视口, 300)!;
  expect(视口.width - 锚.left - 300).toBeGreaterThanOrEqual(窗边距);
  expect(锚.left).toBeLessThan(靠右.left); // 确实往回收了
});

it("标签左缘太靠左时也不许贴出左边界（窄窗口 + 第一颗标签）", () => {
  const 锚 = 标签浮层锚点({ top: 6, bottom: 28, left: 0, right: 90 }, { width: 720, height: 480 }, 200)!;
  expect(锚.left).toBe(窗边距);
});

it("窗口比浮层还窄时不硬夹（交给 CSS 的 max-width 收窄），但仍不越过左边界", () => {
  const 锚 = 标签浮层锚点({ top: 6, bottom: 28, left: 40, right: 90 }, { width: 200, height: 480 }, 400)!;
  expect(锚.left).toBeGreaterThanOrEqual(窗边距);
});

it("窗口矮到快放不下时往上夹：top 不小于间距，也不许跑到标签上方", () => {
  const 矮 = 标签浮层锚点(标签, { width: 1280, height: 120 }, 200)!;
  expect(矮.top).toBeGreaterThanOrEqual(4);
  expect(矮.top).toBeLessThanOrEqual(120);
});

it("拿不到标签（这一帧没渲染出来）或视口尺寸非法 → null，调用方别乱摆", () => {
  expect(标签浮层锚点(null, 视口)).toBeNull();
  expect(标签浮层锚点(标签, { width: 0, height: 0 })).toBeNull();
});
