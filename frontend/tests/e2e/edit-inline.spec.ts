import { expect, test, type Page } from "@playwright/test";
import { gotoApp, setMode } from "./mockApp";

/**
 * 106：标题与行内标记编辑。
 *
 * 靶心不是「能不能加粗」（那是 113 的工具栏与输入规则），而是
 * **在已有标记里改字时，标记本身不许被改坏**：
 * 星号数量、URL、title、相邻别的标记，全都得原样回来。
 *
 * 写这批用例时踩到的坑：**`End` 跳到的是「块尾」不是「标记尾」**。
 * 第一版全部用 `click(标记) + End + type`，结果字全落在段落末尾，
 * 四条一起红。改成点进标记内部直接输入，断言只押不变量
 * （字符落进标记里 + 标记外逐字节不动），不再依赖光标精确落点。
 */

const PATH = "/demo/标记边界.md";

const DOC = [
  "# 标记边界",
  "",
  "这是 **粗体词** 与 `行内码` 与 [文字](https://e.com \"标题\") 混排的一段。",
  "",
  "第二段 **也有粗体** 和 ~~删除线~~。",
  "",
  "末段不动。",
  "",
].join("\n");

async function seedAndOpen(page: Page, doc = DOC) {
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
}

async function savedOf(page: Page): Promise<string> {
  return page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    PATH
  );
}

/**
 * 未被编辑的段落必须原样存在，标题永远不该被动。
 * `skip` 传本条用例**故意改过**的那一行的开头，避免把自己也断言成「不变」。
 */
function othersIntact(saved: string, ...skip: string[]) {
  expect(saved.split("\n")[0]).toBe("# 标记边界");
  const keep = [
    "这是 **粗体词** 与 `行内码` 与 [文字](https://e.com \"标题\") 混排的一段。",
    "第二段 **也有粗体** 和 ~~删除线~~。",
    "末段不动。",
  ].filter((p) => !skip.some((s) => p.startsWith(s)));
  for (const p of keep) expect(saved).toContain(p);
}

test("在粗体里打字：新字落在标记内部，星号仍是两个", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror strong").first().click();
  await page.keyboard.type("X");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const firstLine = saved.split("\n").find((l) => l.startsWith("这是 "))!;
  // X 落在 ** 之间（而不是跑到段尾变成 `**粗体词**…X`）
  expect(firstLine).toMatch(/\*\*[^*]*X[^*]*\*\*/);
  // 这一行原文只有一对粗体 = 4 个星号，编辑后不该变多
  expect((firstLine.match(/\*/g) ?? []).length).toBe(4);
  // 行内码与链接原样
  expect(firstLine).toContain("`行内码`");
  expect(firstLine).toContain('[文字](https://e.com "标题")');
  othersIntact(saved, "这是");
});

test("改链接文字：URL 与 title 一个字节都不许变", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror a").first().click();
  await page.keyboard.type("Y");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  // 点击落点在文字中间，所以 Y 可能落在任意位置 —— 只押真正的不变量：
  // Y 仍在方括号内，而 `](URL "title")` 尾巴逐字节不变。
  expect(saved).toMatch(/\[文.?Y.?字\]\(https:\/\/e\.com "标题"\)/);
  expect(saved).toContain('(https://e.com "标题")');
  expect(saved).not.toContain("<https://e.com"); // 没被改写成自动链接形式
  expect(saved).not.toMatch(/\(https:\/\/e\.com\)/); // title 没被丢掉
  othersIntact(saved, "这是");
});

test("删除线里改字：波浪号仍是两个一对", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror s").first().click();
  await page.keyboard.type("字");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const line = saved.split("\n").find((l) => l.startsWith("第二段"))!;
  expect(line).toMatch(/~~[^~]*字[^~]*~~/); // 字落在 ~~ 之间
  expect((line.match(/~/g) ?? []).length).toBe(4); // 没有变成 ~ 单个或 ~~~
  expect(line).toContain("**也有粗体**"); // 同段粗体没被牵连
  othersIntact(saved, "第二段");
});

test("行内代码里加星号：仍是字面星号，不产生新粗体", async ({ page }) => {
  const codeDoc = "# 码\n\n看 `a **b** c` 这段码，外面 **真粗**。\n";
  await seedAndOpen(page, codeDoc);
  await page.locator(".ProseMirror code").first().click();
  await page.keyboard.type("Z");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const line = saved.split("\n").find((l) => l.startsWith("看"))!;
  // Z 落在反引号之内
  expect(line).toMatch(/`[^`]*Z[^`]*`/);
  // 码内 4 个星号 + 外面粗体 4 个 = 8 个，一个没多（多出来就说明星号被当成标记了）
  expect((line.match(/\*/g) ?? []).length).toBe(8);
  expect(line).toContain("**真粗**");
});

test("标题改字：井号数量与层级不变", async ({ page }) => {
  await seedAndOpen(page);
  await page.locator(".ProseMirror h1").click();
  await page.keyboard.press("End");
  await page.keyboard.type("二级");
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(saved.split("\n")[0]).toBe("# 标记边界二级");
  expect(saved).toBe(DOC.replace("# 标记边界", "# 标记边界二级"));
});
