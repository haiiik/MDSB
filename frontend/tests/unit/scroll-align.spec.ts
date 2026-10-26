import { expect, it } from "vitest";
import {
  anchorScrollTop,
  anchorText,
  pickAnchorIndex,
  pickAnchorPos,
  ratioOf,
  scrollTopFor,
  type 锚,
} from "../../src/kernel/anchors";

/**
 * 140：跨模式定位换算的那两个纯函数。
 *
 * 这条要求是「切换模式时定位到相同位置」。三档内容高度不同，
 * 同一个 scrollTop 不是同一个位置，所以换算走「相对位置」——
 * 这两个函数就是换算的全部数学，值得单独钉：
 * 往返一致、边界不炸、内容不超高时恒为 0。
 */
it("往返一致：先算比例再算回去，落回原值", () => {
  const 内容 = 9000;
  const 视口 = 800;
  for (const top of [0, 1, 123, 4000, 8199, 8200]) {
    expect(scrollTopFor(ratioOf(top, 内容, 视口), 内容, 视口)).toBe(top);
  }
});

it("越界夹住，不返回负数也不越过可滚范围", () => {
  expect(ratioOf(-500, 9000, 800)).toBe(0);
  expect(ratioOf(999999, 9000, 800)).toBe(1);
  expect(scrollTopFor(-1, 9000, 800)).toBe(0);
  expect(scrollTopFor(2, 9000, 800)).toBe(8200);
});

it("内容不超高（没有可滚范围）时恒为 0，不出现除零", () => {
  expect(ratioOf(0, 500, 800)).toBe(0);
  expect(ratioOf(120, 500, 800)).toBe(0); // 浏览器会把它夹回 0，这里不假装滚得动
  expect(Number.isNaN(ratioOf(0, 800, 800))).toBe(false);
  expect(scrollTopFor(0.5, 800, 800)).toBe(0);
});

it("同一比例换到高一档的内容上，像素数跟着放大（这才叫同一个位置）", () => {
  // 阅读档滚到 50%：内容 9000 / 视口 800 → 4100
  const r = ratioOf(4100, 9000, 800);
  // 源码档行更高，内容 12000 → 50% 应该是 5600，而不是把 4100 原样搬过去
  expect(scrollTopFor(r, 12000, 800)).toBe(5600);
  expect(scrollTopFor(r, 12000, 800)).not.toBe(4100);
});

/* ------------------------------------------------------------------ 内容锚点 */

/**
 * 140：光有比例不够 —— 真壳里实测三档内容高度差得远，比例换算落偏 3 段。
 * 所以换档时**先按「顶端那一段字」找**，比例只兜底。
 * 这条找字的键就是 `anchorText`：三档必须用同一个，否则源码档的 `## 标题`
 * 和阅读档的「标题」配不上（第一次红的正是这个方向）。
 */
it("anchorText：源码行的 Markdown 标记与渲染后的文字归一化到同一个键", () => {
  expect(anchorText("## 安装")).toBe(anchorText("安装"));
  expect(anchorText("第 21 段：跨**模式**定位的验收样本")).toBe("第21段：跨模式定位的验收样本");
  expect(anchorText("  空 格 \t 换行\n")).toBe("空格换行");
  expect(anchorText("")).toBe("");
});

it("anchorText：只吃标记字符，正文里的字母数字一个不丢（丢了就会认错段）", () => {
  const s = "第 3 段 a-b_c 100% x|y";
  expect(anchorText(s).length).toBe(s.replace(/[\s|#*`>~_-]/g, "").length);
  expect(anchorText(s)).toContain("100%");
});

/**
 * 140 review 补的两条：链接/图片的归一化，和「重复短键挑最近的那一个」。
 *
 * 这两件事在理想夹具（纯「第 N 段」）下永远不会红，所以必须在这里单独钉住 ——
 * 否则它们只在真实文档里静默退化成比例换算（真壳里实测偏 3 段）。
 */
it("anchorText：链接折成文字、图片整个丢掉，两边才配得上", () => {
  // 源码行的形状
  const 源码 = anchorText("打开 [审批时效看板](https://example.com/board) 看第一列。");
  // 渲染之后 DOM 里的文字（没有中括号和小括号）
  const 渲染 = anchorText("打开 审批时效看板 看第一列。");
  expect(源码).toBe(渲染);
  expect(源码).toBe("打开审批时效看板看第一列。");

  // 图片：渲染出来是一个没有文字的 <img>，所以源码里这一整段引用也得消失
  expect(anchorText("![说明截图](assets/pic.png)后面这句")).toBe("后面这句");
  expect(anchorText("带图 ![x](a.png) 的段落")).toBe("带图的段落");

  // 没闭合的方括号不该把后面一口吞掉
  expect(anchorText("一个 [ 号 和后半句")).toContain("号");
  expect(anchorText("引用式 [文字] 结尾")).toBe("引用式文字结尾");
});

it("pickAnchorPos：同名的两块里挑离预测位置最近的那个，不是文档里第一个", () => {
  // 真实形状：两个小标题都只叫「概述」，键短到两边一模一样
  const 候选 = [
    { text: anchorText("概述"), top: 100 },
    { text: anchorText("中间段"), top: 900 },
    { text: anchorText("概述"), top: 1700 },
  ];
  const 键 = anchorText("概述");
  // 预测位置在 1600 附近 → 必须挑后面那块（1700），而不是文档里第一块（100）
  expect(pickAnchorPos(候选, 键, 1600)).toBe(1700 - 12);
  // 预测位置在前面那块附近 → 挑第一块
  expect(pickAnchorPos(候选, 键, 90)).toBe(100 - 12);
  // 没有预测值才退回「按文档顺序取第一个」
  expect(pickAnchorPos(候选, 键, -1)).toBe(100 - 12);
  // 配不上就是 -1，让调用方去走比例兜底
  expect(pickAnchorPos(候选, anchorText("这句根本不存在"), 1600)).toBe(-1);
  // 空键不干活（否则每块都算命中）
  expect(pickAnchorPos(候选, "", 1600)).toBe(-1);
});

/**
 * 150（要求：「编辑模式的位置，切换到阅读模式后仍对应不上」）：
 * 锚点从「哪一块」补成「哪一块 + 这一块内部已经滚过去多少」。
 *
 * 只有块级精度时，停在**比屏幕还高的一块**里（60 行表格、长引用、大代码块）
 * 会被整块当成一个坐标：切过去只能回到块首。实测差 1109px（编辑档表格第 28 行 →
 * 阅读档落到表头）。这几条钉的就是补上之后那笔算术。
 */
it("anchorScrollTop：块内偏移要跟着搬过去，不再落回块首", () => {
  // 顶端块：源档里高 2400，已经往下滚过 1200（偏移正好一半）
  const 源: 锚 = { 键: anchorText("编号"), 内偏: 1200, 块高: 2400 };
  // 目标档同一块两档等高（143 / 149-A 之后就是这个前提）→ 偏移原样搬
  expect(anchorScrollTop({ top: 500, h: 2400 }, 源)).toBe(500 + 1200 - 12);
  // 目标档这块矮一成 → 偏移按同一比例缩，不能照抄像素
  expect(anchorScrollTop({ top: 500, h: 1200 }, 源)).toBe(500 + 600 - 12);
  // 块高量不到（0 / 缺字段）时退回"照抄偏移"，不出现除零也不出现 NaN
  expect(anchorScrollTop({ top: 500 }, 源)).toBe(500 + 1200 - 12);
  expect(anchorScrollTop({ top: 500, h: 0 }, 源)).toBe(500 + 1200 - 12);
  expect(Number.isNaN(anchorScrollTop({ top: 0, h: 0 }, { 键: "x", 内偏: 0, 块高: 0 }))).toBe(false);
});

it("anchorScrollTop：偏移按构造必定落在块内，不会翻到下一块", () => {
  // 顶端块的定义是「底边还在视口上沿之下」→ 内偏 < 块高，缩放后仍 < 目标块高
  const 源: 锚 = { 键: anchorText("编号"), 内偏: 2399, 块高: 2400 };
  const 落 = anchorScrollTop({ top: 500, h: 4800 }, 源);
  expect(落 - 500).toBeLessThan(4800); // 还在这一块里
  expect(落).toBeGreaterThan(500); // 但绝不是块首
});

it("pickAnchorIndex：返回下标，块高字段带着走（源档与目标档的换算要用同一个候选表）", () => {
  const 候选 = [
    { text: anchorText("概述"), top: 100, h: 40 },
    { text: anchorText("中间段"), top: 900, h: 40 },
    { text: anchorText("概述"), top: 1700, h: 2400 },
  ];
  expect(pickAnchorIndex(候选, anchorText("概述"), 1600)).toBe(2);
  expect(pickAnchorIndex(候选, anchorText("概述"), 90)).toBe(0);
  expect(pickAnchorIndex(候选, anchorText("不存在"), 90)).toBe(-1);
  expect(pickAnchorIndex(候选, "", 90)).toBe(-1);
});
