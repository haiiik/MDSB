import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, placeCaret, setMode } from "./mockApp";

/**
 * 116：剪贴板图片 → 落盘 `assets/` + 正文插入相对路径。
 *
 * 命名 / 序号 / 去重的**规则**在 `tests/unit/paste-images.spec.ts` 里用可控时钟钉过了；
 * 这里验的是接上真编辑器与真宿主之后那条**链路**：
 * 剪贴板里的字节真的变成了一张图、文件真的在 mock 文件系统里、
 * 落盘的引用能被阅读模式解析、失败的时候什么都不留。
 */

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
const PNG_OTHER = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 99]; // 只差最后一个字节

let path = "";
let dir = "";

async function seedAndOpen(page: Page, doc: string, filePath: string) {
  path = filePath;
  dir = path.slice(0, path.lastIndexOf("/"));
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [filePath, doc]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  await setMode(page, "edit");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const savedOf = (page: Page) =>
  page.evaluate(
    (p) => (window as unknown as { __hpMockReadFile?: (a: string) => string | null }).__hpMockReadFile!(p),
    path
  );

/** mock 文件系统里某个前缀下现有的文件（文本 + 二进制合并列出） */
const listFiles = (page: Page, prefix: string) =>
  page.evaluate((p) => (window as unknown as { __hpMockListFiles?: (a?: string) => string[] }).__hpMockListFiles!(p), prefix);

const pasteImage = (page: Page, bytes: number[], name = "截图.png", mime = "image/png") =>
  page.evaluate(
    ([b, n, m]) =>
      (window as unknown as { __hpMockPaste?: (x: unknown) => void }).__hpMockPaste!({
        files: [{ name: n, bytes: b, mime: m }],
      }),
    [bytes, name, mime]
  );

const seedBinary = (page: Page, p: string, bytes: number[]) =>
  page.evaluate(
    ([x, b]) => (window as unknown as { __hpMockSeedBinary?: (a: string, c: number[]) => void }).__hpMockSeedBinary!(x, b),
    [p, bytes]
  );

const binaryOf = (page: Page, p: string) =>
  page.evaluate(
    (x) => (window as unknown as { __hpMockReadBinary?: (a: string) => number[] | null }).__hpMockReadBinary!(x),
    p
  );

/** 正文里引用的那张图（相对路径），从落盘文本里抠出来 */
function refsIn(md: string): string[] {
  return [...md.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)].map((m) => m[1]);
}

/**
 * 编辑器里的图片。
 *
 * 必须排除 `.ProseMirror-separator`：PM 给每个行内叶子节点后面都补一个透明 `<img>`
 * 当分隔符，不过滤的话「粘一张图」永远数出两张（第一次就这么假红的）。
 */
const editedImages = (page: Page) =>
  page.locator(".ProseMirror img:not(.ProseMirror-separator)");

test("粘一张截图：文件落到文档同级 assets/，正文插入相对路径", async ({ page }) => {
  await seedAndOpen(page, "# 图\n\n正文段落。\n\n末段不动。\n", "/demo/粘贴图片-1.md");
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await pasteImage(page, PNG);

  // 先确认界面上真的出来了一张图（不是只写了文件）
  await expect(editedImages(page)).toHaveCount(1);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const refs = refsIn(saved);
  expect(refs).toHaveLength(1);
  // spec 的命名口径：assets/YYYYMMDD-HHMMSS-n.png
  expect(refs[0]).toMatch(/^assets\/\d{8}-\d{6}-1\.png$/);
  // 块外逐字节不动
  expect(saved).toContain("# 图\n\n");
  expect(saved).toContain("末段不动。\n");

  const files = await listFiles(page, `${dir}/assets/`);
  expect(files).toHaveLength(1);
  expect(files[0].endsWith(refs[0])).toBe(true);
  // 写进去的是剪贴板那批字节，不是空文件
  expect(await binaryOf(page, files[0])).toEqual(PNG);
});

test("同一张图粘两次：磁盘上只有一个文件，正文两处引用同一路径", async ({ page }) => {
  await seedAndOpen(page, "# 图\n\n正文段落。\n\n末段不动。\n", "/demo/粘贴图片-2.md");
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await pasteImage(page, PNG);
  await expect(editedImages(page)).toHaveCount(1);
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await pasteImage(page, PNG);
  await expect(editedImages(page)).toHaveCount(2);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  const refs = refsIn(saved);
  expect(refs).toHaveLength(2);
  expect(refs[0]).toBe(refs[1]); // 去重命中，复用同一个文件
  const files = await listFiles(page, `${dir}/assets/`);
  expect(files).toHaveLength(1);
});

test("同一秒里换一张不同的图：序号顺延，谁也不覆盖谁", async ({ page }) => {
  await seedAndOpen(page, "# 图\n\n正文段落。\n\n末段不动。\n", "/demo/粘贴图片-3.md");
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await pasteImage(page, PNG);
  await expect(editedImages(page)).toHaveCount(1);
  await page.keyboard.press("Control+s");

  const first = refsIn(await savedOf(page))[0];
  // 把「-2 号位」预先占掉（模拟同一秒里已经有别人的图），第三张必须让到 -3
  const stamp = first.match(/(\d{8}-\d{6})/)![1];
  await seedBinary(page, `${dir}/assets/${stamp}-2.png`, [1, 2, 3]);

  await placeCaret(page, ".ProseMirror p", -1, 0);
  await pasteImage(page, PNG_OTHER);
  await expect(editedImages(page)).toHaveCount(2);
  await page.keyboard.press("Control+s");

  const refs = refsIn(await savedOf(page));
  const second = refs[1].match(/(\d{8}-\d{6})-(\d+)\.png/)![1];
  const secondSeq = Number(refs[1].match(/-(\d+)\.png/)![1]);
  /*
   * 命名是 `YYYYMMDD-HHMMSS-n`，**序号只在同一秒内顺延**。
   * 4 worker 并行时这一条曾在秒边界上假红：抓 `stamp` 与第二次粘贴之间跨了一秒，
   * 产品按新那一秒出 `-1` 是对的，用例却硬押 `-3`。
   * 所以判据按「是否还在同一秒」分支：同一秒 → 必须让到 -3（-1 自己占了、-2 被占位）；
   * 换了秒 → 从 -1 重新开始。两种都要「不覆盖任何人」。
   */
  if (second === stamp) {
    expect(secondSeq).toBe(3);
  } else {
    expect(secondSeq).toBe(1);
  }
  const files = await listFiles(page, `${dir}/assets/`);
  expect(files).toHaveLength(3);
  // 被占位的那张字节没被动过（不覆盖）
  expect(await binaryOf(page, `${dir}/assets/${stamp}-2.png`)).toEqual([1, 2, 3]);
});

test("文档目录含中文与空格时，相对引用照样能被阅读模式解析", async ({ page }) => {
  await seedAndOpen(page, "# 图\n\n正文段落。\n", "/demo/粘贴 图片 目录/中文 路径.md");
  await placeCaret(page, ".ProseMirror p", -1, 0);
  await pasteImage(page, PNG, "屏幕快照.png", "image/png");
  await expect(editedImages(page)).toHaveCount(1);
  // 编辑模式里也要解析成可用 URL（相对路径直接放进 <img src> 是打不开的）
  await expect(editedImages(page)).toHaveAttribute("src", /^(https?:|data:|blob:|\/hp-file)/);
  await page.keyboard.press("Control+s");

  const saved = await savedOf(page);
  expect(refsIn(saved)[0]).toMatch(/^assets\/.+\.png$/); // 正文里写的是相对路径，不是绝对路径
  expect(saved).not.toContain("/demo/");

  const files = await listFiles(page, `${dir}/`);
  expect(files.some((f) => /assets\/.+\.png$/.test(f))).toBe(true);
  await setMode(page, "read");
  await expect(page.locator(".hp-doc img")).toHaveCount(1);
});

test("光标在代码块里粘图 → 说清楚原因，且不留下指向空气的引用", async ({ page }) => {
  await seedAndOpen(page, "# 图\n\n```js\nconst a = 1;\n```\n\n末段不动。\n", "/demo/粘贴图片-5.md");
  await page.locator(".ProseMirror pre code").click();
  /**
   * **等选区真的落到代码块里再粘。**
   *
   * `handlePaste` 读的是 `state.selection`，而"点击 → PM 把选区收进来"之间隔着一帧；
   * 机器不忙时赶得上，忙的时候就输了 —— 输了之后选区还在**文档开头**（标题那一段容得下图片），
   * 于是图被插在围栏外面，判据报「图片数 1 ≠ 0」，
   * 看着像"schema 拒绝逻辑失效"，其实是测试 paste 早了。空机上单跑也会红，
   * 说明这不是并行才有的问题（2026-10-19 就是这样查了半天）。
   */
  await expect
    .poll(() =>
      page.evaluate(() => {
        const n = window.getSelection()?.anchorNode ?? null;
        const el = n ? (n.nodeType === 3 ? n.parentElement : (n as HTMLElement)) : null;
        return !!el && !!el.closest(".hp-codebox pre code");
      })
    )
    .toBe(true);
  await pasteImage(page, PNG);

  // 109 的代码块是 NodeView，行内只收纯文本：PM 的默认做法会把块从光标处劈开
  // （第一版实测就是这样：`const ` 留在围栏里、图片和后半句变成一个普通段落）。
  // 现在在 handlePaste 里同步问 schema，容不下就直接拒绝。
  await expect(editedImages(page)).toHaveCount(0);
  await expect(page.getByTestId("open-error")).toContainText("放不下图片");
  await expect(page.locator(".ProseMirror pre code")).toHaveText("const a = 1;");
  const files = await listFiles(page, `${dir}/assets/`);
  expect(files).toHaveLength(0); // 拒绝发生在落盘之前：宁可不写文件，也不写一个没有引用的文件
});
