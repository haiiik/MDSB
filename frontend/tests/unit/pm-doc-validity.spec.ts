import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hpSchema } from "../../src/kernel/pm/schema";
import { mdastToDoc } from "../../src/kernel/pm/mdastToDoc";

/**
 * 文档合法性：每一篇夹具转成 ProseMirror 文档后都必须通过 `doc.check()`。
 *
 * 为什么单独有这一份：`node.create()` **不校验子内容**，
 * 所以非法结构（例如给 `marks: ""` 的 code_block 挂上 code mark）
 * 可以安静地活很久——直到某次 `setNodeMarkup` 触发重新校验才抛
 * "Invalid content for node type code_block"。
 * 109 的语言下拉就是这么炸的，而根因在 102 的映射里。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures");
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".md") && !f.endsWith(".roundtrip.md"))
  .sort();

it("至少 5 份夹具，防止目录被清空后静默全绿", () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(5);
});

it.each(fixtures)("%s 转出的 PM 文档通过 check()", (name) => {
  const md = readFileSync(join(fixtureDir, name), "utf8");
  const doc = mdastToDoc(md, hpSchema);
  // check() 有问题时返回错误字符串，没问题返回 undefined
  expect(doc.check()).toBeUndefined();
});

it("code_block 的内容不得携带任何 mark", () => {
  const doc = mdastToDoc("```sql\nSELECT 1;\n```\n", hpSchema);
  const code = doc.child(0);
  expect(code.type.name).toBe("code_block");
  code.forEach((child) => expect(child.marks.length).toBe(0));
});

it("改属性（语言下拉走的路径）不会因非法内容而抛", () => {
  const doc = mdastToDoc("```sql\nSELECT 1;\n```\n", hpSchema);
  const next = doc.child(0).type.create(
    { ...doc.child(0).attrs, language: "python" },
    doc.child(0).content,
    doc.child(0).marks
  );
  // createChecked 会真的校验，非法内容在这里就会抛
  expect(() => doc.child(0).type.createChecked({ ...doc.child(0).attrs, language: "python" }, doc.child(0).content)).not.toThrow();
  expect(next.attrs.language).toBe("python");
});
