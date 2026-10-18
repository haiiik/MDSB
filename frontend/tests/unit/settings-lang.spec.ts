import { describe, expect, it } from "vitest";
import { resolveInitialLang, type Settings } from "../../src/state/settings";

/**
 * 首启语言那条链的判据（135）：
 * 存过的值 > 安装器那一页选的值 > 中文。
 * 三条各验一遍，尤其"用户在设置里改过之后，装的时候选什么都不作数"这一条 ——
 * 她定的口径是「设置里可切，且切过一次就以它为准」。
 */
describe("resolveInitialLang：安装期语言 → 首启初值", () => {
  const stored = (lang?: string): Partial<Settings> => (lang === undefined ? {} : { lang });

  it("什么都没存过、也没装过 → 中文", () => {
    expect(resolveInitialLang(null, "")).toBe("zh");
    expect(resolveInitialLang({}, "")).toBe("zh");
  });

  it("没存过设置 → 用安装器选的语言", () => {
    expect(resolveInitialLang(null, "en")).toBe("en");
    expect(resolveInitialLang({}, "en")).toBe("en");
    expect(resolveInitialLang(null, "zh")).toBe("zh");
  });

  it("存过的值最大：装的时候选英文，用户在设置里改成中文之后仍然是中文", () => {
    expect(resolveInitialLang(stored("zh"), "en")).toBe("zh");
    expect(resolveInitialLang(stored("en"), "zh")).toBe("en");
  });

  it("存值是坏字符串 → 当成没存过，回落到安装器/默认，不照单全收", () => {
    expect(resolveInitialLang(stored("fr"), "en")).toBe("en");
    expect(resolveInitialLang(stored("fr"), "")).toBe("zh");
    expect(resolveInitialLang(stored(""), "en")).toBe("en");
    expect(resolveInitialLang(stored("EN"), "zh")).toBe("en"); // 大小写不敏感，但仍是合法码
  });
});
