import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 118：查找与替换（US-40）。
 *
 * 三种模式共用一条查找条，所以每种模式都要跑一遍「计数 = 高亮数」这条不变量 ——
 * 这是验收第一条，也是最容易在某个模式里悄悄不一致的地方
 * （阅读模式改 DOM 会破坏渲染产物、源码模式的偏移与 PM 的位置不是一套）。
 */

const DOC =
  "# 审批时效周报\n\n指标口径已对齐，指标需要单独看板。\n\n正文里提到 **加粗** 与 avg 平均耗时 AVG。\n\n| 指标 | 值 |\n| :--- | --- |\n| 指标平均 | 12 |\n\n末段不动，指标只此一处。\n";

let path = "";

async function seedAndOpen(page: Page, mode: "read" | "edit" | "source") {
  path = "/demo/查找-" + mode + "-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, DOC]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  if (mode !== "read") await setMode(page, mode);
}

const type = (page: Page, text: string) => page.getByTestId("search-input").fill(text);
const countOf = (page: Page) => page.getByTestId("search-count").innerText();
/** 各模式的高亮落在不同地方：PM/CM 是类名，阅读模式是 CSS Custom Highlight */
const paintedCount = (page: Page, mode: "read" | "edit" | "source") =>
  mode === "read"
    ? page.evaluate(() => CSS.highlights.get("hp-search")?.size ?? 0)
    : mode === "edit"
      ? page.locator(".ProseMirror .hp-search").count()
      : page.locator(".cm-content .hp-search").count();

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

test("编辑模式：计数与高亮项数一致，中文关键词命中 4 处", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await type(page, "指标");
  await expect.poll(() => countOf(page)).toBe("1 / 5");
  expect(await paintedCount(page, "edit")).toBe(5); // 全部命中都画，当前项只是多一个类名
});

test("编辑模式：跳转循环不越界，末项再点下一个回首项", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  for (let i = 1; i < 5; i++) await page.getByTestId("search-next").click();
  await expect.poll(() => countOf(page)).toBe("5 / 5");
  await page.getByTestId("search-next").click();
  await expect.poll(() => countOf(page)).toBe("1 / 5");
  await page.getByTestId("search-prev").click();
  await expect.poll(() => countOf(page)).toBe("5 / 5");
});

test("编辑模式：含 Markdown 标记的关键词命中渲染后的文字", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  // 编辑模式里没有字面的 `**`：那是源码的写法，屏幕上看到的是渲染后的「加粗」
  await type(page, "加粗");
  await expect.poll(() => countOf(page)).toBe("1 / 1");
  await type(page, "**加粗**");
  await expect.poll(() => countOf(page)).toBe("0 / 0");
});

test("编辑模式：大小写与全词两个开关组合结果正确", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "avg");
  await expect.poll(() => countOf(page)).toBe("1 / 2"); // avg + AVG（大小写不敏感）
  await page.getByTestId("search-opt-caseSensitive").click();
  await expect.poll(() => countOf(page)).toBe("1 / 1"); // 只剩小写那个 avg
  await page.getByTestId("search-opt-caseSensitive").click();
  await page.getByTestId("search-opt-wholeWord").click();
  await expect.poll(() => countOf(page)).toBe("1 / 2"); // 两个都是独立词，全词不改变结果
  // 全词真正的效果：词内出现不算命中（「指标口」后面还跟着「径」）
  await type(page, "指标口");
  await expect.poll(() => countOf(page)).toBe("0 / 0");
  await page.getByTestId("search-opt-wholeWord").click();
  await expect.poll(() => countOf(page)).toBe("1 / 1");
});

test("编辑模式：正则开关 + 非法表达式只提示、不清空输入", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-opt-regex").click();
  await type(page, "指[标案]");
  await expect.poll(() => countOf(page)).toBe("1 / 5");
  await type(page, "指(标");
  await expect(page.getByTestId("search-error")).toContainText("正则表达式无效");
  await expect(page.getByTestId("search-input")).toHaveValue("指(标");
  await expect.poll(() => countOf(page)).toBe("0 / 0");
  await type(page, "指(标)");
  await expect(page.getByTestId("search-error")).toHaveCount(0);
  await expect.poll(() => countOf(page)).toBe("1 / 5");
});

test("编辑模式：替换当前项只改一个，其余命中还在", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await type(page, "指标");
  await page.getByTestId("replace-input").fill("KPI");
  await page.getByTestId("replace-one").click();
  await expect.poll(() => countOf(page)).toBe("1 / 4"); // 五处里改掉一处，还剩四处
  await page.keyboard.press("Control+s");
  const text = await savedOf(page);
  expect(text).toContain("KPI口径已对齐");
  expect(text).toContain("指标需要单独看板");
});

test("编辑模式：替换全部是**一步撤销**，撤销后逐字节还原", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await type(page, "指标");
  await page.getByTestId("replace-input").fill("KPI");
  await page.getByTestId("replace-all").click();
  await expect.poll(() => countOf(page)).toBe("0 / 0");
  await page.keyboard.press("Control+s");
  const replaced = await savedOf(page);
  expect(replaced).toContain("KPI口径已对齐");
  expect(replaced).toMatch(/\|\s*KPI平均\s*\|/); // 表格块被改过 → 整块重排（列宽补齐是 111 的既定代价），只能按形状匹配

  // 一次 Ctrl+Z 就该全部还原（不是四步）
  await page.getByTestId("search-close").click();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toBe(DOC);
});

test("编辑模式：替换只动命中块，未命中的块逐字节不变", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await type(page, "末段不动"); // 只出现在最后一段
  await page.getByTestId("replace-input").fill("收尾段落");
  await page.getByTestId("replace-all").click();
  await page.keyboard.press("Control+s");
  const text = await savedOf(page);
  expect(text).toContain("收尾段落，指标只此一处。");
  // 代码之外的其它块原样：标题、第二段、表格三行都在
  expect(text).toContain("# 审批时效周报\n\n指标口径已对齐，指标需要单独看板。\n\n");
  expect(text).toContain("| 指标平均 | 12 |");
});

test("阅读模式：能数能跳，且不产生脏状态", async ({ page }) => {
  await seedAndOpen(page, "read");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await expect.poll(() => countOf(page)).toBe("1 / 5");
  expect(await paintedCount(page, "read")).toBe(4); // 当前项单独一档 highlight，不在这个集合里
  await page.getByTestId("search-next").click();
  await expect.poll(() => countOf(page)).toBe("2 / 5");
  // 只读行为：没有脏点
  expect(await page.getByTestId("tab-dirty").count()).toBe(0);
  // 阅读模式不给替换入口
  await expect(page.getByTestId("replace-input")).toHaveCount(0);
});

test("Esc 只关查找条并清高亮，不关标签", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await page.getByTestId("search-input").press("Escape");
  await expect(page.getByTestId("search-bar")).toHaveCount(0);
  expect(await paintedCount(page, "edit")).toBe(0);
  expect(await page.getByTestId("tabbar").locator(".tab").count()).toBe(1);
});

test("查找条里再按 Ctrl+F 不重置输入（不重复触发）", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await page.getByTestId("search-input").press("Control+f");
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await expect(page.getByTestId("search-input")).toHaveValue("指标");
  await expect.poll(() => countOf(page)).toBe("1 / 5");
});

test("源码模式：找的是源文本，替换全部同样一步撤销", async ({ page }) => {
  await seedAndOpen(page, "source");
  await page.keyboard.press("Control+h");
  await type(page, "**加粗**"); // 源码模式里字面标记就在文本上
  await expect.poll(() => countOf(page)).toBe("1 / 1");
  await page.getByTestId("replace-input").fill("强调");
  await page.getByTestId("replace-all").click();
  await expect.poll(() => countOf(page)).toBe("0 / 0");
  await page.keyboard.press("Control+s");
  expect(await savedOf(page)).toContain("正文里提到 强调 与 avg 平均耗时 AVG。");
});

/**
 * 131：查找条里的「替换」入口。
 *
 * 原来只有 `Ctrl+H` 会展开替换行，`Ctrl+F` 打开的是同一条工具条但少一行 ——
 * 她实测的反馈是「和 Ctrl+F 长得一样，替换是不是没有」。
 * 入口藏在快捷键里等于没有入口，所以工具条上给一颗**看得见的开关**。
 */
test("Ctrl+F 打开后：替换行默认收起，但有一颗「替换」按钮可展开", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-input")).toBeVisible();
  await expect(page.getByTestId("replace-input")).toHaveCount(0);

  const toggle = page.getByTestId("search-toggle-replace");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("replace-input")).toBeVisible();
  // 展开后焦点该在替换框里（省一次点击）
  await expect(page.getByTestId("replace-input")).toBeFocused();

  await toggle.click();
  await expect(page.getByTestId("replace-input")).toHaveCount(0);
});

test("Ctrl+H 仍然直接展开，且那颗按钮跟着亮起来（同一份状态，不各算一套）", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+h");
  await expect(page.getByTestId("replace-input")).toBeVisible();
  await expect(page.getByTestId("search-toggle-replace")).toHaveClass(/is-on/);
});

test("阅读模式是只读档：不给替换入口（不是置灰，是不出现）", async ({ page }) => {
  await seedAndOpen(page, "read");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-input")).toBeVisible();
  await expect(page.getByTestId("search-toggle-replace")).toHaveCount(0);
  await expect(page.getByTestId("replace-input")).toHaveCount(0);
});

/**
 * 140：输入法组合期不能被打断（她的报告：查找框输入一个字符就断、中文打不出来）。
 *
 * 判据押在**外部可见行为**上，不读组件内部变量：
 *  ① 组合期间（拼音还没上屏）**不重算** —— 计数停在旧值；上屏那一刻才更新；
 *  ② 组合期间的 Enter（选候选词）**不许当成"跳到下一个"** —— 当前项不变；
 *  ③ 组合期结束后焦点仍在输入框里，值就是上屏的那串字。
 */
for (const mode of ["read", "edit", "source"] as const) {
  test(`${mode}：中文输入法组合期不打断、选词的 Enter 不当成跳转`, async ({ page }) => {
    await seedAndOpen(page, mode);
    await page.keyboard.press("Control+f");
    const box = page.getByTestId("search-input");
    await expect(box).toBeVisible();
    await type(page, "指标");
    const 计数 = await countOf(page);
    expect(计数).toBe("1 / 5");

    // ① 模拟一次完整的组合：start → 拼音 input（**这中间不许重算**）→ 上屏 → end
    await box.evaluate((el) => {
      const i = el as HTMLInputElement;
      i.focus();
      i.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      i.value = "指";
      i.dispatchEvent(new InputEvent("input", { data: "指", isComposing: true, inputType: "insertCompositionText", bubbles: true }));
    });
    // 拼音还没上屏：计数保持旧值（这条就是"每敲一下都去动正文"的那笔账）
    await page.waitForTimeout(250);
    await expect(page.getByTestId("search-count")).toHaveText(计数);
    await box.evaluate((el) => {
      const i = el as HTMLInputElement;
      i.value = "末段";
      i.dispatchEvent(new InputEvent("input", { data: "末段", isComposing: true, inputType: "insertCompositionText", bubbles: true }));
      i.dispatchEvent(new CompositionEvent("compositionend", { data: "末段" }));
    });
    await expect(box).toHaveValue("末段");
    // 上屏之后计数跟着换（"末段" 在这篇里命中 1 处）
    await expect(page.getByTestId("search-count")).not.toHaveText(计数);
    // ③ 焦点还在框里（没被正文抢走 = 组合没被打断的前提）
    await expect(box).toBeFocused();

    // ② 组合期间按 Enter（真实 IME 用它选词）不该推进当前项。
    //    这里换一个**多命中**的词再试：只有一条命中时"跳"与"不跳"看起来一样，判据量不出东西
    await type(page, "指标");
    const 当前 = await countOf(page);
    expect(当前).toBe("1 / 5");
    await box.evaluate((el) => {
      const i = el as HTMLInputElement;
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(250);
    await expect(page.getByTestId("search-count")).toHaveText(当前);
    // 而真的按 Enter（没在组合）就是要跳：这一步同时证明上一条不是"Enter 整个失灵"
    await box.press("Enter");
    await expect(page.getByTestId("search-count")).toHaveText("2 / 5");
  });
}

/* ---------------------------------------------------------------------------
 * 146：她两条一起提的 ——「替换功能增加结果反馈」+
 * 「查找使用中，编辑导致丢掉了当前目标，点上下箭头时自动定位上下位置，不要回到首个」。
 * ------------------------------------------------------------------------ */

/** 展开替换行并把替换内容填进去 */
async function 填替换(page: Page, 内容: string) {
  await page.getByTestId("search-toggle-replace").click();
  await page.getByTestId("replace-input").fill(内容);
}

test("146-C：替换一处 / 替换全部都给回执（换了几处、还剩几处）", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await 填替换(page, "KPI");

  await page.getByTestId("replace-one").click();
  await expect(page.getByTestId("search-feedback")).toHaveText("已替换 1 处，还剩 4 处");

  await page.getByTestId("replace-all").click();
  await expect(page.getByTestId("search-feedback")).toHaveText("已替换 4 处，还剩 0 处");
  // 换完的字节确实落得下去（回执不是嘴上说说）：回写要按 Ctrl+S，替换本身不自动落盘
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(900);
  expect(await savedOf(page)).not.toContain("指标");
});


test("146-C：换了查询词，上一笔回执要作废（挂着会以为说的是这一笔）", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  await 填替换(page, "KPI");
  await page.getByTestId("replace-one").click();
  await expect(page.getByTestId("search-feedback")).toHaveText("已替换 1 处，还剩 4 处");
  await page.getByTestId("search-input").fill("末段");
  await expect(page.getByTestId("search-feedback")).toHaveCount(0);
});

test("146-D：编辑把当前那一处换掉了，按 ↑ 回到**光标前面**那一处，不是绕到最后一个", async ({ page }) => {
  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  // 走到第 3 处（表头那一格），然后就地把它换成不含关键词的文字
  await page.getByTestId("search-next").click();
  await page.getByTestId("search-next").click();
  await expect(page.getByTestId("search-count")).toHaveText("3 / 5");
  await 填替换(page, "KPI");
  await page.getByTestId("replace-one").click();
  /*
   * 老行为：重算把当前项复位成**第一处** → "1 / 4"，接着按 ↑ 就绕到最后一个 "4 / 4"
   * —— 她看到的正是"我明明在表格里，怎么甩回文件另一头"。
   * 新行为：重算按**身份**（同一串文字 + 离原位最近）把它认回原地 → "3 / 4"，
   * 于是 ↑ 回到它前面那一处 "2 / 4"、↓ 走到它后面那一处，跳的始终是"上下位置"。
   */
  await expect(page.getByTestId("search-count")).toHaveText("3 / 4");
  await page.getByTestId("search-prev").click();
  await expect(page.getByTestId("search-count")).toHaveText("2 / 4");
  await page.getByTestId("search-next").click();
  await page.getByTestId("search-next").click();
  await expect(page.getByTestId("search-count")).toHaveText("4 / 4");
});

test("146-D：后面没有命中时按 ↓ 才循环回第一处（循环语义没被改掉）", async ({ page }) => {  await seedAndOpen(page, "edit");
  await page.keyboard.press("Control+f");
  await type(page, "指标");
  for (let i = 1; i < 5; i++) await page.getByTestId("search-next").click();
  await expect(page.getByTestId("search-count")).toHaveText("5 / 5");
  await 填替换(page, "KPI");
  await page.getByTestId("replace-one").click();
  // 被换掉的是**最后一处**：认回来的最近一处仍是最后一处（现在共 4 处）→ "4 / 4"
  await expect(page.getByTestId("search-count")).toHaveText("4 / 4");
  // 它后面确实没有命中了 → ↓ 才循环回第一处（循环语义没被这条改动弄坏）
  await page.getByTestId("search-next").click();
  await expect(page.getByTestId("search-count")).toHaveText("1 / 4");
});

/* ---------------------------------------------------------------------------
 * 146-E：她「查找功能查找后，切换模式时，显示位置发生变化了」。
 * 140 那条管的是"没开查找时换档落在同一段"；开着查找时**当前那一处**才是她站着的地方，
 * 换档必须还停在那一处附近，而不是被"视口顶端那一段"或比例换算带走。
 * ------------------------------------------------------------------------ */

const 跨模式文 = [
  "# 查找跨模式",
  "",
  ...Array.from({ length: 60 }, (_, i) => [
    i === 39 ? "第 40 段里有一个 关键词 在这里。" : `第 ${i + 1} 段正文。`,
    "",
  ]).flat(),
  "",
].join("\n");

/** 视口顶端那一段的段号（三档都数得出来：阅读/编辑看块，源码看行） */
const 顶端段 = (page: Page, 条目: string, 容器: string) =>
  page
    .evaluate(([itemSel, boxSel]) => {
      const box = document.querySelector<HTMLElement>(boxSel);
      if (!box) return -99;
      const 线 = box.getBoundingClientRect().top + 24;
      for (const el of Array.from(document.querySelectorAll(itemSel))) {
        if ((el as HTMLElement).getBoundingClientRect().bottom <= 线) continue;
        const m = (el.textContent ?? "").match(/第 ([0-9]+) 段/);
        if (m) return Number(m[1]);
      }
      return -2;
    }, [条目, 容器])
    .catch(() => -98);

/**
 * 当前那一处命中现在在不在视口里（她真正在意的就是这个蓝框还看得见）。
 * 编辑 / 源码档的当前项是**真 DOM 元素**（PM 与 CM 的 decoration）；
 * 阅读档走 CSS Custom Highlight API，**没有元素可查**，只能问 Highlight 里那条 Range。
 */
const 当前在视口 = (page: Page, sel: string, 容器选择器: string) =>
  page
    .evaluate(([命中选择器, 容器]) => {
      const 容 = document.querySelector(容器)?.getBoundingClientRect();
      if (!容) return null;
      const el = document.querySelector(命中选择器);
      let r = el?.getBoundingClientRect();
      if (!r) {
        const 高亮 = CSS.highlights.get("hp-search-current");
        const 第一条 = 高亮 ? Array.from(高亮)[0] : undefined;
        if (!第一条) return null;
        r = 第一条.getBoundingClientRect();
      }
      return r.top >= 容.top - 2 && r.bottom <= 容.bottom + 2;
    }, [sel, 容器选择器] as [string, string])
    .catch(() => null);

for (const [起点档, 起点条目, 起点容器, 目标档, 目标条目, 目标容器] of [  ["read", ".hp-doc > *", ".pane__scroller", "edit", ".ProseMirror > *", ".edit-pane__scroll"],
  ["edit", ".ProseMirror > *", ".edit-pane__scroll", "read", ".hp-doc > *", ".pane__scroller"],
  ["edit", ".ProseMirror > *", ".edit-pane__scroll", "source", ".cm-line", ".cm-scroller"],
] as const) {
  test(`146-E：${起点档} 档查到第 40 段后切到 ${目标档} 档，还停在那一处`, async ({ page }) => {
    path = "/demo/查找跨模式-" + 起点档 + "-" + 目标档 + ".md";
    await freshSession(page);
    await gotoApp(page);
    await page.evaluate(
      ([p, c]) => {
        (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
        (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
      },
      [path, 跨模式文]
    );
    await page.getByTestId("tab-open").click();
    await expect(page.getByTestId("document-root")).toBeVisible();
    if (起点档 !== "read") await setMode(page, 起点档);
    await page.waitForTimeout(500);

    await page.keyboard.press("Control+f");
    await page.getByTestId("search-input").fill("关键词");
    await expect(page.getByTestId("search-count")).toHaveText("1 / 1");
    // 打字只画高亮不跳转（140 为输入法定的口径），要跳得按 Enter
    await page.getByTestId("search-input").press("Enter");
    await page.waitForTimeout(600);

    const 前 = await 顶端段(page, 起点条目, 起点容器);
    // 跳过去之后当前项是**居中**落的（scrollIntoView 的语义），顶端不必正好是第 40 段；
    // 这条只确认"确实跳到下面来了"，真正的判据是下面那两条（顶端没跑远 + 那一处还在视口里）
    expect(前, `起点档 ${起点档} 压根没往下跳（顶端还在第 ${前} 段）`).toBeGreaterThanOrEqual(30);
    expect(await 当前在视口(page, ".hp-search--current", 起点容器)).toBeTruthy();

    await setMode(page, 目标档);
    await page.waitForTimeout(900);
    const 后 = await 顶端段(page, 目标条目, 目标容器);
    /*
     * 顶端段号只当"没跑回文件开头"的下限看，不当逐段对齐的判据：
     * 源码档一个段落要占两行（段落之间那行空行也在），同样一个 scrollTop 天然少看到约 1/4 的段数，
     * 硬要求 ±1 段量的其实是行高，不是"她还停在那一处"。真正的判据是下面那条。
     */
    expect(后, `换档后视口顶端掉回第 ${后} 段（起点是第 ${前} 段）`).toBeGreaterThanOrEqual(前 - 16);
    expect(
      await 当前在视口(page, ".hp-search--current", 目标容器),
      `换到 ${目标档} 档之后，那一处命中已经不在视口里了`
    ).toBeTruthy();
  });
}

/**
 * 146-E 的**判别性**判据：换档那一刻会注册新适配器 → 重算命中。
 * 老实现把当前项复位成第一处，于是她看到的是"切一下模式，蓝框跑到别处去了"；
 * 现在按身份（同一串文字 + 离原位最近）认回原地，计数与蓝框都该停在第 3 处。
 */
const 三处文 = [
  "# 三处对照",
  "",
  "第 1 处 关键词 在这里。",
  "",
  ...Array.from({ length: 20 }, (_, i) => [`铺垫第 ${i + 1} 行正文。`, ""]).flat(),
  "第 2 处 关键词 在这里。",
  "",
  ...Array.from({ length: 20 }, (_, i) => [`再铺垫第 ${i + 1} 行正文。`, ""]).flat(),
  "第 3 处 关键词 在这里。",
  "",
].join("\n");

test("146-E：换档之后当前项还是同一处（计数不从 1 重新开始）", async ({ page }) => {
  path = "/demo/查找换档三处.md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, 三处文]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("关键词");
  await expect(page.getByTestId("search-count")).toHaveText("1 / 3");
  await page.getByTestId("search-input").press("Enter");
  await page.getByTestId("search-input").press("Enter");
  await expect(page.getByTestId("search-count")).toHaveText("3 / 3");

  for (const 档 of ["read", "source", "edit"] as const) {
    await setMode(page, 档);
    await page.waitForTimeout(700);
    expect(await page.getByTestId("search-count").innerText(), `切到 ${档} 档之后`).toBe("3 / 3");
    expect(
      await 当前在视口(page, ".hp-search--current", 档 === "read" ? ".pane__scroller" : 档 === "edit" ? ".edit-pane__scroll" : ".cm-scroller"),
      `切到 ${档} 档之后那一处已经看不见了`
    ).toBeTruthy();
  }
});
