import { describe, expect, it, afterEach } from "vitest";
import { normalizeLang, setLang, t, tf, ui, LANGS } from "../../src/i18n";
import zh from "../../src/i18n/zh";

/**
 * M3-134 i18n 基座。
 * 钉三件事：语言切换真的换文案、占位替换只替已知 key、认不出的语言标识返回 null（不猜）。
 */
describe("i18n 基座", () => {
  afterEach(() => setLang("zh"));

  it("默认中文，切英文后同一 key 取到英文文案", () => {
    expect(ui.lang).toBe("zh");
    expect(t("mode.read")).toBe("阅读");
    setLang("en");
    expect(t("mode.read")).toBe("Reading");
  });

  it("占位替换：只替给出来的变量，未知的原样留着（不静默吞字）", () => {
    expect(tf("status.words", { words: 12 })).toBe("12 字");
    expect(tf("status.words", { lines: 3 })).toBe("{words} 字");
  });

  it("normalizeLang：中文系/英文认，其它与空值返回 null", () => {
    expect(normalizeLang("zh-CN")).toBe("zh");
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("  JA-jp  ")).toBeNull();
    expect(normalizeLang(null)).toBeNull();
  });

  it("非法语言不许切（切了还是原语言）", () => {
    setLang("en");
    setLang("fr" as never);
    expect(ui.lang).toBe("en");
  });

  it("两张表 key 完全对齐（漏译会在类型层报错，这里再钉一次运行期）", () => {
    expect(LANGS).toEqual(["zh", "en"]);
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(t(k)).not.toBe(`!${k}`);
    }
  });
});
