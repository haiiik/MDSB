import { expect, test, type Page } from "@playwright/test";
import { gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 113：Markdown 输入规则（US-38 前半）。
 *
 * 单测（`tests/unit/input-rules.spec.ts`）管「规则本身造出什么形状」，
 * 这里管「真键盘打字时规则会不会触发、什么时候不该触发」——
 * 后三态（组合输入 / 代码块内 / 行内代码内）是插件与 `inCodeMark` 闸门的职责，
 * 只能靠真事件验，拿复刻的守卫写单测等于自证。
 */

const PATH = "/demo/输入规则.md";

async function seedAndOpen(page: Page, doc: string) {
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [PATH, doc]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );

/** 在第一个段落末尾另起一块，打一串字符，保存，返回落盘文本 */
async function typeFreshBlock(page: Page, keys: string): Promise<string> {
  // 光标用 placeCaret 同步放定，不用 click + End：那两步之间没有同步点，
  // 负载高时「Enter」会打在旧光标上（107 的拆项用例就这么假红过一次）
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.press("Enter");
  await page.keyboard.type(keys);
  await page.keyboard.press("Control+s");
  return savedOf(page);
}

const BASE = "正文段落。\n";

test("`# ` 变一级标题，`## ` 变二级", async ({ page }) => {
  await seedAndOpen(page, BASE);
  let saved = await typeFreshBlock(page, "# 一级");
  expect(saved).toContain("# 一级");
  expect(saved).toContain("正文段落。");

  await seedAndOpen(page, BASE);
  saved = await typeFreshBlock(page, "## 二级");
  expect(saved).toContain("## 二级");
  // 井号没被当成正文里的字面字符转义
  expect(saved).not.toContain("\\#");
});

test("`- ` 无序、`1. ` 有序、`> ` 引用", async ({ page }) => {
  await seedAndOpen(page, BASE);
  const saved = await typeFreshBlock(page, "- 甲");
  expect(saved).toMatch(/^- 甲$/m);

  await seedAndOpen(page, BASE);
  expect(await typeFreshBlock(page, "1. 第一")).toMatch(/^1\. 第一$/m);

  await seedAndOpen(page, BASE);
  expect(await typeFreshBlock(page, "> 引用内容")).toMatch(/^> 引用内容$/m);
});

test("有序列表从 3 开始就写 3，不被改回 1", async ({ page }) => {
  await seedAndOpen(page, BASE);
  expect(await typeFreshBlock(page, "3. 第三项")).toMatch(/^3\. 第三项$/m);
});

test("``` 变代码围栏，后续输入都在围栏内", async ({ page }) => {
  await seedAndOpen(page, BASE);
  const saved = await typeFreshBlock(page, "```\nSELECT 1");
  expect(saved).toContain("```");
  expect(saved).toContain("SELECT 1");
  // 围栏是成对的：至少两个 ``` 行
  expect((saved.match(/```/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("`- [ ] ` 走完两步规则：先变列表项、再变成任务项", async ({ page }) => {
  await seedAndOpen(page, BASE);
  const saved = await typeFreshBlock(page, "- [ ] 买牛奶");
  expect(saved).toMatch(/^- \[ ] 买牛奶$/m);

  await seedAndOpen(page, BASE);
  expect(await typeFreshBlock(page, "- [x] 已办")).toMatch(/^- \[[xX]] 已办$/m);
});

test("代码块里打 `# ` 与 `- ` 不触发规则（109 提的要求）", async ({ page }) => {
  await seedAndOpen(page, "正文。\n\n```sql\nSELECT 1;\n```\n");
  // 光标用 DOM Range 精确放到围栏文字末尾。
  // 别用 Ctrl+End / End 这类按键去找落点 —— 在代码块里它们的语义不是「块尾」，
  // 实测会把光标停在单词中间，打进去的字被劈开插进原文（第七次踩这坑了）。
  await page.evaluate(() => {
    const code = document.querySelector('.ProseMirror [data-testid="pm-code-block"] code');
    if (!code) throw new Error("没有代码块");
    const range = document.createRange();
    range.selectNodeContents(code);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("# 这不是标题");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 这不是列表");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 原内容一个字符都不许被劈开：SELECT 1; 仍是一整行
  expect(saved).toContain("SELECT 1;");
  const fenceLines = saved.split("\n");
  const fenceStart = fenceLines.findIndex((l) => l.startsWith("```"));
  expect(fenceStart).toBeGreaterThanOrEqual(0);
  const fenceEnd = fenceLines.findIndex((l, i) => i > fenceStart && l.startsWith("```"));
  // 两行都必须在**围栏之内**：落在围栏外就意味着块被规则改成了标题/列表
  const inside = fenceLines.slice(fenceStart + 1, fenceEnd);
  expect(inside).toEqual(["SELECT 1;", "# 这不是标题", "- 这不是列表"]);
  // 整篇仍只有一个代码块（一对围栏）
  expect(fenceLines.filter((l) => l.startsWith("```"))).toHaveLength(2);
});

test("行内代码里打 `#` + 空格不会把整段变成标题", async ({ page }) => {
  // 代码段在行尾，End 之后光标就落在它的最后一个字符后面
  await seedAndOpen(page, "看这个标记 `#`\n");
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.type(" 尾巴");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 规则若误触发：整段变成 heading，反引号消失、行首变成 "# "
  expect(saved.split("\n")[0]).toMatch(/^看这个标记/);
  expect(saved).toContain("`");
  await expect(page.locator(".ProseMirror h1")).toHaveCount(0);
  // 光标在 code 标记内打字，新字符自然继承该标记（这是 PM 的 mark 延续，不是规则）
  expect(saved).toContain("`# 尾巴`");
});

test("退格能把刚转换的块类型撤回原样（输入规则自带的那步撤销）", async ({ page }) => {
  await seedAndOpen(page, BASE);
  await placeCaret(page, ".ProseMirror p", -1);
  await page.keyboard.press("Enter");
  // 规则触发后**紧接着**退格才有效：插件的暂存状态在下一个 docChanged / 选区变化时就清了
  // （`prosemirror-inputrules/dist/index.cjs:48`），所以这里不能中途再点别处。
  await page.keyboard.type("# ");
  await expect(page.locator(".ProseMirror h1")).toHaveCount(1);

  await page.keyboard.press("Backspace");
  await expect(page.locator(".ProseMirror h1")).toHaveCount(0);
  const last = page.locator(".ProseMirror p").last();
  await expect(last).toContainText("#");

  // 撤回后那行是「以 # 开头的普通段落」，落盘必须转义，否则重开就变回标题了
  await page.keyboard.press("Control+s");
  const saved = await savedOf(page);
  expect(saved).toContain("\\#");
  expect(saved.split("\n").some((l) => /^#{1,6}\s/.test(l))).toBe(false);
});

/*
 * 验收里「撤销一次能回到转换前的块类型」不在这里验：编辑模式**还没接
 * `prosemirror-history`**，Ctrl+Z 目前什么都不做，history 插件与合并窗口是 117 的活
 * （和 112 的「一步撤销」同一处衔接）。这颗先把**能立刻验的那半**钉住：
 * 上一条用例的「退格撤回块类型」走的是 `undoInputRule`，它就在输入规则插件里。
 */
