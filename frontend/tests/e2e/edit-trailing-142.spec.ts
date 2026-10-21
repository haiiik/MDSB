import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 142：她的原话 ——「新建文件时，从其他文件复制来表格，然后我想另起一行写正文或标题，
 * 此时无法从下一行开始」。
 *
 * 复现出来是三件事叠在一起，缺一还坏，所以逐条钉：
 * ① 文档最后一块是**没有可输入落点**的块（表格 / 分割线 / 代码块 / 公式 / 脚注定义 / 不透明块）时，
 *    末尾补一行空段落（`ensureTrailingParagraph` + `documentShapePlugin`）；
 * ② Tab 到**最后一格**不再原地不动，而是落到表格下面那一行（`exitTableBelow`）；
 * ③ 正文下方那片留白属于可编辑区（`.hp-doc` 的 96px 下内边距搬进 `.ProseMirror`），
 *    点它就等于光标落到最后一行。
 *
 * 另外钉住一条**同一路径上的丢字**缺陷：格子里按回车原本拆第二个段落，
 * 而 GFM 单元格只有行内内容，落盘时「甲」「乙」两段被摊平成 `甲乙`（换行没了）。
 * 现在按 115 就定下的同一套表示（口径 Q2：单元格换行 = 行内 `<br>`）落地。
 *
 * 恒等那条（③之前）最要紧：**补出来的那一行不许让文件变脏、也不许多写空白** ——
 * 打开一篇以表格结尾的文件什么都没做就亮脏点，是 104 的恒等判据红线。
 */

let path = "";
let 开档序号 = 0;

const paste = (page: Page, payload: { html?: string; text?: string }) =>
  page.evaluate((p) => (window as unknown as { __hpMockPaste: (x: unknown) => void }).__hpMockPaste(p), payload);

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

/**
 * 顶层块的顺序。补没补那一行、有没有多补，看这个最直白。
 * 带 `data-testid` 的（代码块 / 公式 / 脚注定义是 NodeView 包的 div）直接用那个名字，
 * 免得用例里写「div」这种看不出是什么的东西。
 */
const 顶层块 = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelector(".ProseMirror")?.children ?? []).map(
      (el) => (el as HTMLElement).dataset.testid ?? el.tagName.toLowerCase()
    )
  );

/** 光标此刻落在哪一类**顶层块**里（判「字进没进表格」就看这个） */
const 光标所在顶层块 = (page: Page) =>
  page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror");
    const s = window.getSelection();
    let el = s?.anchorNode
      ? ((s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement) as HTMLElement | null)
      : null;
    if (!pm || !el) return null;
    while (el && el.parentElement !== pm) el = el.parentElement;
    return el ? el.tagName.toLowerCase() : null;
  });

/**
 * 把光标放进**最后一格**。
 *
 * 不用 `click()`：粘贴/事务之后点击与选区之间没有同步点（115 那条假红就是它，
 * 症状长得像「表格被排到文首」，其实是选区还没落地）。这里先点、再**轮询确认选区真的在格子里**。
 */
const 把光标放进最后一格 = async (page: Page) => {
  await page.locator(".ProseMirror td").last().click();
  await expect
    .poll(() => 光标所在顶层块(page), { timeout: 4000, message: "选区没落进表格" })
    .toBe("table");
};

async function 打开文档(page: Page, doc: string) {
  开档序号 += 1;
  path = `/demo/142-${test.info().title.replace(/[^\w一-龥]+/g, "-")}-${开档序号}.md`;
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, doc]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
}

const 表格在末尾 = "# 口径\n\n正文一段。\n\n| 部门 | 慢单数 |\n| :--- | ---: |\n| 采油 | 12 |\n";

test("新建未命名档粘完表格，末尾确实补出一行能写字的段落", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").click();
  await paste(page, {
    html: "<table><tr><th>部门</th><th>慢单数</th></tr><tr><td>采油</td><td>12</td></tr></table>",
  });

  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  // ① 表格后面那一行真的存在
  expect(await 顶层块(page)).toEqual(["table", "p"]);
});

test("②Tab 到最后一格出表格，打的字落在表格下面而不是格子里", async ({ page }) => {
  await freshSession(page);
  await gotoApp(page);
  await page.getByTestId("tab-new").click();
  await page.locator(".ProseMirror").click();
  await paste(page, {
    html: "<table><tr><th>部门</th><th>慢单数</th></tr><tr><td>采油</td><td>12</td></tr></table>",
  });
  await 把光标放进最后一格(page);

  await page.keyboard.press("Tab");
  expect(await 光标所在顶层块(page), "Tab 到最后一格应当出表格").toBe("p");

  await page.keyboard.type("下面这段是正文");
  await expect(page.locator(".ProseMirror > p:last-child")).toHaveText("下面这段是正文");
  // 最后一格还是 12，没被顺手写进表里
  await expect(page.locator(".ProseMirror td").last()).toHaveText("12");
});

test("③点表格下方的空白，光标落到补出来的那一行，打字即成文", async ({ page: p }) => {
  await freshSession(p);
  await gotoApp(p);
  await p.getByTestId("tab-new").click();
  await p.locator(".ProseMirror").click();
  await paste(p, {
    html: "<table><tr><th>部门</th><th>慢单数</th></tr><tr><td>采油</td><td>12</td></tr></table>",
  });
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

  // 点在表格**下沿**与容器底部之间那片留白上（`.ProseMirror` 矩形内）
  const 点 = await p.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".edit-pane__scroll")!.getBoundingClientRect();
    const pm = document.querySelector<HTMLElement>(".ProseMirror")!.getBoundingClientRect();
    const table = document.querySelector<HTMLElement>(".ProseMirror table")!.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round((table.bottom + pm.bottom) / 2) };
  });
  await p.mouse.click(点.x, 点.y);
  await expect
    .poll(() => p.evaluate(() => document.activeElement?.className ?? ""), { timeout: 3000 })
    .toContain("ProseMirror");
  await p.keyboard.type("点在表下面");
  expect(await 光标所在顶层块(p)).toBe("p");
  await expect(p.locator(".ProseMirror > p:last-child")).toHaveText("点在表下面");
});

test("打开以表格结尾的文件：末尾有那一行，但没改任何东西就不许脏", async ({ page }) => {
  await 打开文档(page, 表格在末尾);
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror table");

  // 补出来的行存在
  expect(await 顶层块(page)).toEqual(["h1", "p", "table", "p"]);
  // 恒等判据：这是**打开文件**，不是她改的 —— 脏点不该亮
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  // 在那一行打字，才真的算改动
  await page.locator(".ProseMirror > p:last-child").click();
  await expect.poll(() => 光标所在顶层块(page)).toBe("p");
  await page.keyboard.type("补一句");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  const 保存后 = await savedOf(page);
  // 原有的每一行逐字节不动，新内容只出现在末尾
  const 原行 = 表格在末尾.split("\n").filter((l) => l.trim());
  const 新行 = 保存后.split("\n").filter((l) => l.trim());
  expect(新行.slice(0, 原行.length)).toEqual(原行);
  expect(新行[原行.length]).toBe("补一句");
  expect(新行).toHaveLength(原行.length + 1);
});

test("表格在文档中间时 Tab 落到它下面已有的那段，不另起新行", async ({ page }) => {
  await 打开文档(page, "| 部门 | 慢单数 |\n| :--- | --- |\n| 采油 | 12 |\n\n下面已有的一段。\n");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror table");
  await 把光标放进最后一格(page);

  await page.keyboard.press("Tab");
  expect(await 光标所在顶层块(page)).toBe("p");
  // 没有多出一段空的：表格 + 原有那段，就两块
  expect(await 顶层块(page)).toEqual(["table", "p"]);
  await page.keyboard.type("接");
  await expect(page.locator(".ProseMirror > p:last-child")).toHaveText("接下面已有的一段。");
});

test("格子里按回车 = 单元格内换行，落盘是 <br>，不把两行并成一行丢字", async ({ page }) => {
  await 打开文档(page, "# 表\n\n| 部门 | 数量 |\n| :--- | --- |\n| 甲 | 1 |\n");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror table");
  await placeCaret(page, ".ProseMirror td p", -1); // 「甲」那格末尾
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("乙");

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  const 保存后 = await savedOf(page);
  expect(保存后).toContain("甲<br>乙");
  // 原来会写成这样：两段被摊平进行内序列，换行直接没了
  expect(保存后).not.toContain("| 甲乙 |");
  // 表格结构没被拆坏：还是 2 行 2 列
  expect(await page.locator(".ProseMirror tr").count()).toBe(2);
  expect(await page.locator(".ProseMirror tr").last().locator("td").count()).toBe(2);
});

test("以分割线结尾的文件：补一行、不脏、字落在线下面", async ({ page }) => {
  await 打开文档(page, "上面一段。\n\n---\n");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror hr");

  expect(await 顶层块(page)).toEqual(["p", "hr", "p"]);
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);

  await page.locator(".ProseMirror > p:last-child").click();
  await expect.poll(() => 光标所在顶层块(page)).toBe("p");
  await page.keyboard.type("线下面写的");
  await expect(page.locator(".ProseMirror > p:last-child")).toHaveText("线下面写的");
  // 不是把线上面那段改了
  await expect(page.locator(".ProseMirror > p").first()).toHaveText("上面一段。");
});

test("以代码块结尾的文件：末尾同样补一行且不脏", async ({ page }) => {
  await 打开文档(page, "上面一段。\n\n```js\nlet a = 1;\n```\n");
  await setMode(page, "edit");
  await page.waitForSelector('[data-testid="pm-code-block"]');

  expect(await 顶层块(page)).toEqual(["p", "pm-codebox", "p"]);
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
});

test("以普通段落结尾的文件：末尾不许多补出一行空的", async ({ page }) => {
  await 打开文档(page, "# 标题\n\n最后一句话。\n");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror h1");

  expect(await 顶层块(page)).toEqual(["h1", "p"]);
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
});

/* ---------------------------------------------------- 142 审计：同一路径上的其它问题 */

/** 焦点现在在谁身上（底栏那颗模式按钮也在这里露出来） */
const 焦点在 = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName}.${el.className}` : "null";
  });

test("142 审计：打开一篇空文件，切到编辑档就能直接打字（和新建未命名档同一条路）", async ({ page }) => {
  await 打开文档(page, "");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror");

  // 光标**已经在文档里**：不用先点一下页面
  await expect.poll(() => 焦点在(page), { timeout: 4000 }).toContain("ProseMirror");
  await page.keyboard.type("第一个字");
  await expect(page.locator(".ProseMirror")).toContainText("第一个字");
  // 底栏那颗按钮还带着焦点时按 Enter / Tab 会**把模式按钮再点一次**（模式当场跳走），
  // 所以这一条钉的不是「打字方便」而是「第一次按键打到哪儿」。
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="mode-edit"].is-on')).toBeVisible();
});

test("142 审计：正文里按 Tab 不丢焦点，随后打的字不蒸发", async ({ page }) => {
  await 打开文档(page, "一句话。\n");
  await setMode(page, "edit");
  await page.locator(".ProseMirror p").first().click();
  await expect.poll(() => 焦点在(page)).toContain("ProseMirror");

  await page.keyboard.press("Tab");
  // Tab 在正文里的语义还没对齐（Q33），但**接住事件**是确定的：焦点不许跑到工具栏/底栏
  await expect.poll(() => 焦点在(page)).toContain("ProseMirror");
  await page.keyboard.type("接得住");
  await expect(page.locator(".ProseMirror p").first()).toContainText("接得住");
});

test("142 审计：代码块里按 Tab 是缩进，制表符落盘留得住", async ({ page }) => {
  await 打开文档(page, "```js\nlet a = 1;\n```\n");
  await setMode(page, "edit");
  await page.waitForSelector('[data-testid="pm-code-block"]');
  await placeCaret(page, '[data-testid="pm-code-block"] code', -1);

  await page.keyboard.press("Enter"); // 代码块内回车 = 换行（newlineInCode）
  await page.keyboard.press("Tab");
  await page.keyboard.type("let b = 2;");
  await expect.poll(() => 焦点在(page)).toContain("ProseMirror");

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  const 制表符 = String.fromCharCode(9);
  expect(await savedOf(page)).toContain("let a = 1;\n" + 制表符 + "let b = 2;");
});

test("142 审计：代码块里选中一段按 Tab，不许把选中的字换成制表符", async ({ page }) => {
  await 打开文档(page, "```js\nlet a = 1;\nlet b = 2;\n```\n");
  await setMode(page, "edit");
  await page.waitForSelector('[data-testid="pm-code-block"]');
  /*
   * review 抓的这条：`tr.insertText("\t")` 不传区间走的是 `replaceSelection`，
   * 选区非空时会把**整段选中内容换成一个制表符** ——
   * 从别处整段复制代码粘进来、顺手按个 Tab 就静默丢字。
   * 现在选区非空一律让开（链尾的 swallowTab 接住事件：焦点不丢、内容也不丢）。
   */
  await page.evaluate(() => {
    const code = document.querySelector('[data-testid="pm-code-block"] code');
    const t = code?.firstChild;
    if (!t) throw new Error("代码块里没有文字节点");
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, "let a = 1;".length);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+s");
  // 什么都不该发生：不脏、两行代码都在、也没多出制表符
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  const 保存后 = await savedOf(page);
  expect(保存后).toContain("let a = 1;");
  expect(保存后).toContain("let b = 2;");
  expect(保存后).not.toContain(String.fromCharCode(9));
});

test("142 审计：以引用块结尾，末尾那一行在引用块**外面**", async ({ page }) => {
  await 打开文档(page, "正文。\n\n> 引用的话。\n");
  await setMode(page, "edit");
  await page.waitForSelector(".ProseMirror blockquote");

  expect(await 顶层块(page)).toEqual(["p", "blockquote", "p"]);
  await page.locator(".ProseMirror > p:last-child").click();
  await expect.poll(() => 光标所在顶层块(page)).toBe("p");
  await page.keyboard.type("出得去");
  // 不是变成引用块的第二段（实测原来点下方打字就落进引用块里）
  await expect(page.locator(".ProseMirror blockquote")).toHaveText("引用的话。");

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  expect(await savedOf(page)).toBe("正文。\n\n> 引用的话。\n\n出得去\n");
});

test("142 审计：全选删干净之后，文档是一个能直接打字的段落", async ({ page }) => {
  await 打开文档(page, "整篇都要删掉。\n");
  await setMode(page, "edit");
  await page.locator(".ProseMirror p").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");

  /*
   * 这一条原本红得很难看：PM 的自动填空用的是 `ContentMatch.defaultType`，
   * 这张 schema 排到第一的是 `opaque_block` —— 删干净之后文档变成一块
   * 「此内容编辑模式不修改」，打不了字也删不掉，只能关标签重开。
   * 判据因此写成形状，而不是「能打字」而已。
   */
  expect(await 顶层块(page), "删干净之后不许剩下占位块或空壳").toEqual(["p"]);
  await expect(page.locator('[data-testid="opaque-block"]')).toHaveCount(0);
  await expect.poll(() => 焦点在(page)).toContain("ProseMirror");
  await page.keyboard.type("重写的开头");
  await expect(page.locator(".ProseMirror")).toContainText("重写的开头");

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  expect(await savedOf(page)).toBe("重写的开头\n");
});

