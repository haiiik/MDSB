import { expect, it } from "vitest";
import {
  收纳浮窗锚点,
  窗边距,
  浮窗间距,
  浮窗默认宽,
  最小露出,
} from "../../src/kernel/tabPickerAnchor";

/**
 * 162（要求：「窗口过多收纳展开放在展开按钮那里，而不是放在左边」）。
 *
 * 钉的是**锚点算法**这一层：按钮在栏里会随活动标签与栏宽挪位置，浮窗必须跟着挪。
 * 元素真的贴没贴上，由 E2E `tab-picker-anchor-162.spec.ts` 与桌面判据量几何；
 * 这两层必须给出同一个答案（本项目反复钉的"不许两处真相"）。
 */

const 视口 = { width: 1280, height: 800 };
/** 一颗长在标签串尾巴上的「+N」（栏左内边距 18，右边还跟着「+」「打开文件」） */
const 按钮 = { top: 6, bottom: 28, left: 700, right: 734 };

it("右缘与按钮右缘齐平，顶边落在按钮下方 4px（这才是「放在展开按钮那里」）", () => {
  expect(收纳浮窗锚点(按钮, 视口)).toEqual({
    top: 按钮.bottom + 浮窗间距,
    right: 视口.width - 按钮.right,
  });
});

it("按钮挪了，锚点跟着挪：左移 100px → right 偏移 +100（不是算一次定死）", () => {
  const 原 = 收纳浮窗锚点(按钮, 视口)!;
  const 挪 = 收纳浮窗锚点({ ...按钮, left: 按钮.left - 100, right: 按钮.right - 100 }, 视口)!;
  expect(挪.right - 原.right).toBe(100);
  // 竖向与横向无关：按钮只左右挪，top 不许跟着变
  expect(挪.top).toBe(原.top);
});

it("按钮几乎贴着窗口右缘时，浮窗不贴窗边（留最小窗宽 720 那种窄栏也算得出来）", () => {
  const 贴边 = { top: 6, bottom: 28, left: 1260, right: 1278 };
  expect(收纳浮窗锚点(贴边, 视口)!.right).toBe(窗边距);
});

it("浮窗宽到装不下时改夹左缘：左缘仍在窗口里，宁可让右缘不齐平按钮", () => {
  // 名字很长的一篇会把浮窗顶得很宽（min-width 240 只是下限）
  const 挤 = 收纳浮窗锚点({ top: 6, bottom: 28, left: 890, right: 914 }, 视口, 1000)!;
  expect(视口.width - 挤.right - 1000).toBe(窗边距);
  expect(挤.right).toBeLessThan(视口.width - 按钮.right); // 确实没再齐平按钮
  // 同一种极端放在最小窗宽上：仍然夹得住，且 right 不小于窗边距
  const 窄 = 收纳浮窗锚点({ top: 6, bottom: 28, left: 590, right: 610 }, { width: 720, height: 480 }, 660)!;
  expect(720 - 窄.right - 660).toBe(窗边距);
  expect(窄.right).toBeGreaterThanOrEqual(窗边距);
});

it("常规情况下按 min-width 估就够了：最小窗宽 + 默认宽 → 浮窗整片在窗口里", () => {
  const 锚 = 收纳浮窗锚点({ top: 6, bottom: 28, left: 640, right: 660 }, { width: 720, height: 480 })!;
  const 左缘 = 720 - 锚.right - 浮窗默认宽;
  expect(左缘).toBeGreaterThanOrEqual(窗边距);
  expect(锚).toEqual({ top: 32, right: 60 });
  // **装得下就不许夹**：夹过头 = 浮窗又跑回左边去了（上面那格的反面）
  expect(收纳浮窗锚点(按钮, 视口, 240)!.right).toBe(视口.width - 按钮.right);
});

it("窗口矮到快放不下整片浮窗时往上夹：top 不小于间距，也不许跑到按钮上方去", () => {
  const 矮 = 收纳浮窗锚点(按钮, { width: 1280, height: 130 })!;
  expect(矮.top).toBe(Math.max(浮窗间距, 130 - 最小露出));
  expect(矮.top).toBeGreaterThanOrEqual(浮窗间距);
  // 正常高度下不该触发这条夹（否则浮窗会莫名其妙压在按钮上）
  expect(收纳浮窗锚点(按钮, 视口)!.top).toBe(按钮.bottom + 浮窗间距);
});

it("按钮这一帧不在 → null（调用方保持上一次位置，不许跳回左上角）", () => {
  expect(收纳浮窗锚点(null, 视口)).toBeNull();
  // 视口尺寸拿不到（0）同样算不出锚点，别硬给一个 (0,0)
  expect(收纳浮窗锚点(按钮, { width: 0, height: 0 })).toBeNull();
});
