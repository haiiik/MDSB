import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, roundTrip, serialize } from "../../src/kernel/roundtrip";

/**
 * round-trip 夹具台。
 *
 * 约定：`tests/fixtures/` 下每个 `.md` 自动成为一条用例，新增夹具不需要改代码。
 * 若某类内容在往返后**期望被规范化**（例如 M2 决定统一列表符号为 `-`），
 * 在同目录放一个 `<同名>.roundtrip.md` 写期望结果即可，测试会改用它比对。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures");

const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".md") && !f.endsWith(".roundtrip.md"))
  .sort();

function expectedOf(name: string, source: string): string {
  const override = join(fixtureDir, basename(name, ".md") + ".roundtrip.md");
  return existsSync(override) ? readFileSync(override, "utf8") : source;
}

describe("夹具目录", () => {
  it("至少覆盖 5 类内容元素，防止目录被清空后静默全绿", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });
});

describe.each(fixtures)("round-trip %s", (name) => {
  const md = readFileSync(join(fixtureDir, name), "utf8");
  const expected = expectedOf(name, md);

  it("parse -> serialize 回到期望的 Markdown", () => {
    expect(roundTrip(md)).toBe(expected);
  });

  it("幂等：再往返一次结果不变", () => {
    const once = roundTrip(md);
    expect(roundTrip(once)).toBe(once);
  });

  it("parse 不吞内容：serialize 后长度与期望一致", () => {
    const doc = parse(md);
    expect(serialize(doc).length).toBe(expected.length);
  });
});
