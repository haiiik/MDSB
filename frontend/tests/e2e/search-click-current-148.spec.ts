import { expect, test, type Page } from "@playwright/test";
import { freshSession, gotoApp, setMode } from "./mockApp";

/**
 * 148：她「查找功能，点击查找到的高亮块时，查找条中的 5 / 98，要定位到对应数字」。
 *
 * 三档都要成立（高亮分别由 PM 装饰 / CM 装饰 / CSS Custom Highlight 画，
 * 认点的办法各不一样，所以判据也按各档自己的形状去点）。
 * 反向那条同样要紧：点在**没有高亮的地方**不该改计数。
 */

const 六处 = ["# 六处对照", "", ...Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段里有 指标 一词。`), ""].join("\n\n");

let path = "";

async function 打开(page: Page, mode: "read" | "edit" | "source") {
  path = "/demo/点高亮-" + mode + "-" + test.info().title.replace(/[^\w一-龥]+/g, "-") + ".md";
  await freshSession(page);
  await gotoApp(page);
  await page.evaluate(
    ([p, c]) => {
      (window as unknown as { __hpMockSeedFile?: (a: string, b: string) => void }).__hpMockSeedFile!(p, c);
      (window as unknown as { __hpMockPickPath?: string }).__hpMockPickPath = p;
    },
    [path, 六处]
  );
  await page.getByTestId("tab-open").click();
  await expect(page.getByTestId("document-root")).toBeVisible();
  if (mode !== "read") await setMode(page, mode);
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("指标");
  await expect(page.getByTestId("search-count")).toHaveText("1 / 6");
  await page.waitForTimeout(300);
}

const 计数 = (page: Page) => page.getByTestId("search-count").innerText();

/**
 * 第 n 处命中中心的屏幕坐标。
 * 编辑 / 源码档的高亮是真 DOM 元素，直接量元素；
 * **阅读档不能拿 `CSS.highlights` 那个集合按下标取** —— 那里头当前项是被挑出去单独画的
 * （`hp-search` 只装"非当前"的那些），下标与命中序号差一个，
 * 第一版就被这个骗过一次：点第 4 处却报"点了第 5 处"。所以自己按文字找第 n 个出现位置。
 */
const 第n处坐标 = (page: Page, n: number, 选择器: string | null) =>
  page.evaluate(
    ([nn, sel]) => {
      if (sel) {
        const el = document.querySelectorAll(sel)[nn];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      const 根 = document.querySelector(".hp-doc");
      if (!根) return null;
      const w = document.createTreeWalker(根, NodeFilter.SHOW_TEXT);
      let 见 = 0;
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        const 文 = (t as Text).data ?? "";
        let 位 = 文.indexOf("指标");
        while (位 >= 0) {
          if (见 === nn) {
            const r = document.createRange();
            r.setStart(t, 位);
            r.setEnd(t, 位 + 2);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }
          见++;
          位 = 文.indexOf("指标", 位 + 2);
        }
      }
      return null;
    },
    [n, 选择器] as [number, string | null]
  );

for (const [档, 选择器] of [
  ["read", null],
  ["edit", ".ProseMirror .hp-search"],
  ["source", ".cm-content .hp-search"],
] as const) {
  test(`点第 4 处高亮 → 计数走到 4 / 6（${档} 档）`, async ({ page }) => {
    await 打开(page, 档);
    const 点 = await 第n处坐标(page, 3, 选择器);
    expect(点, "第 4 处高亮找不到（前提不成立）").toBeTruthy();
    await page.mouse.click(点!.x, 点!.y);
    await page.waitForTimeout(300);
    expect(await 计数(page), "点了第 4 处，计数却没跟过去").toBe("4 / 6");
    // 当前项的标记也要跟着换人（不然她不知道现在算的是哪一处）。
    /*
     * 阅读档不能拿"当前项在全部高亮里的下标"判 —— 那里头当前项被单独画进
    `hp-search-current`，**不在 `hp-search` 集合里**，按下标找永远是 -1。
     * 所以统一改成：当前项的矩形 == 她点的那一处的矩形。
     */
    const 当前矩形 = await page.evaluate(() => {
      const el = document.querySelector(".hp-search--current");
      if (el) {
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), t: Math.round(r.top) };
      }
      const 当前 = CSS.highlights.get("hp-search-current");
      const 第一条 = 当前 ? Array.from(当前)[0] : undefined;
      if (!第一条) return null;
      const r = 第一条.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top) };
    });
    expect(当前矩形, "没有当前项的标记了").toBeTruthy();
    expect(Math.abs(当前矩形!.l - Math.round(点!.x)), "当前项的标记没跟着换").toBeLessThanOrEqual(40);
    /* 竖直方向容 14px：命中矩形取的是文字行盒，当前项标记取的是元素盒，两者本来就差半个行高 */
    expect(Math.abs(当前矩形!.t - Math.round(点!.y)), "当前项的标记没跟着换").toBeLessThanOrEqual(14);
  });
}

test("点在没有任何高亮的地方 → 计数不该动", async ({ page }) => {
  await 打开(page, "edit");
  const 空白 = await page.evaluate(() => {
    const p = document.querySelectorAll(".ProseMirror p")[0];
    const r = p.getBoundingClientRect();
    return { x: r.right - 4, y: r.top + r.height / 2 };
  });
  await page.mouse.click(空白.x, 空白.y);
  await page.waitForTimeout(300);
  expect(await 计数(page)).toBe("1 / 6");
});
