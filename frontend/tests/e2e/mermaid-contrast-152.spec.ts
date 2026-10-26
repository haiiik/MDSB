import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 152（10-22：「浅色主题可以看清，深色主题看不清啊，我觉得是软件层面的问题」+ 两张同图两档截图）：
 * 深色档里，**文档用 `classDef` 写了浅底**的那些节点，字被 mermaid 的 dark 主题翻成浅灰 → 浅底 + 浅字。
 * 修前实测对比度：浅粉底 1.35、浅蓝底 1.40（WCAG AA 正文要 4.5），没写样式的节点 10.17 不受影响。
 *
 * 拍的兜底口径：**只翻字色，底色一个不改**，而且**只在对比度不合格时才动手**。
 * 判据因此是两半：① 该修的修了（每个节点都 ≥4.5）；② 不该修的没动（作者自己配好颜色的那些，
 * 计算值逐字不变）—— 只做①会顺手把作者写的颜色也翻掉，那正是"软件改内容"。
 */

const 浅底 = "fill:#ffe6e6,stroke:#c00";
const 浅蓝 = "fill:#e6f0ff,stroke:#06c";
const 作者配好 = "fill:#ffe6e6,stroke:#c00,color:#7a1f1f";
const 深底 = "fill:#1b2733,stroke:#0a1420";

const DOC = [
  "# 对比度兜底",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[没写样式的节点] --> B[浅粉底]",
  "  A --> C[浅蓝底]",
  "  A --> D[作者自己配好了字色]",
  "  A --> E[深底]",
  `  classDef 浅粉 ${浅底};`,
  `  classDef 浅蓝 ${浅蓝};`,
  `  classDef 作者 ${作者配好};`,
  `  classDef 深 ${深底};`,
  "  class B 浅粉;",
  "  class C 浅蓝;",
  "  class D 作者;",
  "  class E 深;",
  "```",
  "",
  "正文。",
  "",
].join("\n");

/** 每个节点：底色、字色、对比度（量的是**真正画字的那个叶子**，见下面注释） */
const 量节点 = (page: Page, 根Sel = '.hp-mermaid[data-state="done"]') =>
  page.evaluate((sel) => {
    const 解析 = (s: string): [number, number, number] | null => {
      const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s ?? "");
      if (m) return [+m[1], +m[2], +m[3]];
      const h = /^\s*#([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(s ?? "");
      if (!h) return null;
      let t = h[1];
      if (t.length === 3) t = t.split("").map((c) => c + c).join("");
      return [0, 2, 4].map((i) => parseInt(t.slice(i, i + 2), 16)) as [number, number, number];
    };
    const 亮 = (v: [number, number, number]) => {
      const f = v.map((x) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
    };
    const 比 = (a: string, b: string) => {
      const x = 解析(a);
      const y = 解析(b);
      if (!x || !y) return 99;
      const l1 = 亮(x);
      const l2 = 亮(y);
      return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
    };
    const 根 = document.querySelector(sel);
    if (!根) throw new Error("图没渲染出来：" + sel);
    /*
     * **量真正被画出来的那一个元素**：mermaid 的 htmlLabels 是
     * `foreignObject > div > span.nodeLabel > p`，主题色 `color:#ccc` 挂在**最里层**那两级上。
     * 只量外层 div 会被骗 —— 外层改成什么，里面的 `p` 都照旧用自己的规则画，
     * 肉眼看到的就是"粉色矩形里还是浅灰字"（第一版判据全绿而产品没修好，栽的就是这一条）。
     */
    const 叶子 = (起: Element): Element[] => {
      const out: Element[] = [];
      const 走 = (el: Element) => {
        let 有子 = false;
        for (const c of Array.from(el.children)) {
          if (!(c.textContent ?? "").trim()) continue;
          有子 = true;
          走(c);
        }
        if (!有子 && (el.textContent ?? "").trim()) out.push(el);
      };
      走(起);
      return out;
    };
    return Array.from(根.querySelectorAll("g.node")).map((g) => {
      const 形 = g.querySelector("rect, polygon, ellipse, circle, path") as SVGElement | null;
      const 标签 = g.querySelector("foreignObject, .nodeLabel, .label, text");
      const 叶 = 标签 ? 叶子(标签) : [];
      const 字 = (叶[0] ?? 标签) as HTMLElement | null;
      const 底 = 形 ? getComputedStyle(形).fill : "";
      const 色 = 字 ? getComputedStyle(字).color : "";
      return {
        名: (字?.textContent ?? g.textContent ?? "").trim().slice(0, 12),
        底,
        字色: 色,
        层数: 叶.length,
        对比度: 比(底, 色),
      };
    });
  }, 根Sel);

async function 打开(page: Page): Promise<void> {
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    ["/demo/对比度兜底.md", DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.locator('.hp-mermaid[data-state="done"] g.node')).toHaveCount(5, { timeout: 20_000 });
}

const 全及格 = (表: { 名: string; 对比度: number }[], 档: string) => {
  const 坏 = 表.filter((x) => x.对比度 < 4.5);
  expect(坏, `${档}还有对比度不及格的节点：${JSON.stringify(坏)}`).toEqual([]);
};

test("深色档：浅底节点的字被翻深，五个节点全部及格", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  await page.getByTestId("theme-dark").click();
  await page.waitForTimeout(2_500);
  const 表 = await 量节点(page);
  全及格(表, "深色档");
  const 浅粉 = 表.find((x) => x.名.startsWith("浅粉底"))!;
  expect(浅粉.对比度, `修前实测 1.35，现在还是 ${浅粉.对比度}`).toBeGreaterThanOrEqual(4.5);
  // 底色一个不改（作者写的颜色是内容）
  expect(浅粉.底).toBe("rgb(255, 230, 230)");
});

test("浅色档：本来就及格的节点，字色逐字没被动过", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  const 表 = await 量节点(page);
  全及格(表, "浅色档");
  for (const x of 表) {
    /*
     * 三种"不许动"和一种"必须动"：
     * - 作者自己写了 color 的那颗 → 保持作者的值（122,31,31 与浅粉底配得上，本来及格）；
     * - 主题配的浅底 + 深字 → 不动（51,51,51）；
     * - **深底那颗在浅色档里本身就是坏的**（深底 + 主题深字 = 1.2）→ 正该翻成浅字，
     *   这条就是"另一类：深底配深字"的兜底，写在这里免得被误读成"改坏了"。
     */
    const 应 = x.名.startsWith("作者自己")
      ? "rgb(122, 31, 31)"
      : x.名.startsWith("深底")
        ? "rgb(245, 245, 245)"
        : "rgb(51, 51, 51)";
    expect(x.字色, `${x.名} 的字色与预期不符（应 ${应} / 实 ${x.字色}）`).toBe(应);
  }
});

test("作者自己配好了字色的节点：不碰（只兜不合格的，不替作者做主）", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  const 浅 = await 量节点(page);
  const 作者浅 = 浅.find((x) => x.名.startsWith("作者自己"))!;
  expect(作者浅.字色, "作者写的 color 被翻掉了").toBe("rgb(122, 31, 31)");
  await page.getByTestId("theme-dark").click();
  await page.waitForTimeout(2_500);
  const 深 = await 量节点(page);
  const 作者深 = 深.find((x) => x.名.startsWith("作者自己"))!;
  // 深档下 mermaid 会拿主题色覆盖作者写的 color 吗？会 —— 那就轮到兜底出手，
  // 但**兜完必须及格**，这条钉的是结果不是手段
  expect(作者深.对比度).toBeGreaterThanOrEqual(4.5);
});

test("深底 + 深字（浅色档那种坏法）也兜得住", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  const 表 = await 量节点(page);
  const 深 = 表.find((x) => x.名.startsWith("深底"))!;
  expect(深.底, "底色不该被改").toBe("rgb(27, 39, 51)");
  expect(深.对比度, "浅底配深字、深底配浅字 —— 深底这个必须翻成浅字").toBeGreaterThanOrEqual(4.5);
});

test("编辑档走同一个入口：深色档同样全部及格", async ({ page }) => {
  test.setTimeout(180_000);
  await 打开(page);
  await page.getByTestId("theme-dark").click();
  await page.waitForTimeout(1_500);
  await setMode(page, "edit");
  await page.waitForSelector('.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg g.node');
  await page.waitForTimeout(2_500);
  /*
   * 编辑档**复用同一个量法**（含"量真正画字的那个叶子"这条）。
   * 这条测试原来自己抄了一份测量，用的还是旧的外层 div 选择器 ——
   * 于是产品已经修好了、它还报红了两次；判据抄一份就是给自己造一个会骗人的尺子。
   */
  const 表 = await 量节点(page, '.hp-codebox[data-mermaid="1"] .hp-mermaidbox__svg');
  全及格(表, "编辑档深色");
  expect(表.length, "编辑档节点数不对").toBe(5);
});
