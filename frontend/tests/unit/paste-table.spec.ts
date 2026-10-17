import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { parseMd, serializeMd } from "../../src/kernel/md";
import { clipboardToMdast, looksLikeTable, tsvToMdast } from "../../src/kernel/paste/clipboard";
import { htmlToMdast } from "../../src/kernel/paste/htmlToMdast";
import { docToMdast } from "../../src/kernel/pm/docToMdast";
import { mdastRootToNodes, mdastToDoc } from "../../src/kernel/pm/mdastToDoc";
import { mergePastedTable, placePastedBlocks } from "../../src/kernel/pm/tableCommands";
import { hpSchema } from "../../src/kernel/pm/schema";

/**
 * 115：外部表格粘贴 → 合法 GFM 表格（US-34）。
 *
 * 三条接缝分别测：
 * ① TSV 兜底（Excel 只给 plain 那条路）；② MIME 优先级选择器；
 * ③ 光标在表格里时「并入这张表」的合并规则（补列不丢字、粘进来的行降级成数据行）。
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "paste");

/** serializeMd 结尾带换行，按「表格行数」数就要先去掉尾部空行 */
const tableLines = (md: string): string[] => md.split("\n").filter((l) => l.trim().startsWith("|"));

const strip = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(strip);
  if (n && typeof n === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(n as object).sort()) {
      if (k === "position" || k === "spread") continue;
      o[k] = strip((n as Record<string, unknown>)[k]);
    }
    return o;
  }
  return n;
};

describe("TSV 兜底夹具", () => {
  const fixtures = readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".tsv"))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(fixtureDir, f), "utf8") }));

  it("至少 3 份 .tsv 夹具", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  describe.each(fixtures)("转换 %s", (fx) => {
    const root = () => tsvToMdast(fx.text);
    const md = () => serializeMd(root() as never);

    it("与钉住的 .md 一致", () => {
      const path = join(fixtureDir, fx.name.replace(/\.tsv$/, ".md"));
      expect(existsSync(path), "缺少期望文件 " + path).toBe(true);
      expect(md()).toBe(readFileSync(path, "utf8"));
    });

    it("是合法表格：每行格数相同、有分隔行", () => {
      const lines = md().split("\n").filter((l) => l.trim().startsWith("|"));
      const counts = lines.map((l) => l.split("|").length - 2);
      expect(new Set(counts).size).toBe(1);
      expect(lines[1]).toMatch(/^\|[\s:-]+(\|[\s:-]+)+\|$/);
    });

    it("再解析一次结构不变", () => {
      expect(strip(parseMd(md()))).toEqual(strip(root()));
    });
  });

  it("短行补空格子，绝不丢字（甲乙丙 / 1 2 → 三列，第三格空）", () => {
    const out = serializeMd(tsvToMdast("甲\t乙\t丙\n1\t2\n") as never);
    expect(out).toContain("丙");
    expect(tableLines(out)).toHaveLength(3); // 表头 + 分隔 + 一行数据
    expect(tableLines(out)[2].split("|").map((c) => c.trim()).filter(Boolean)).toEqual(["1", "2"]);
  });

  it("含制表符才算表；普通句子不算", () => {
    expect(looksLikeTable("甲\t乙")).toBe(true);
    expect(looksLikeTable("就是一句普通的话")).toBe(false);
    expect(looksLikeTable("\t\t")).toBe(false); // 只有空白，不算
  });
});

describe("MIME 优先级", () => {
  it("html 与 text 同时存在时用 html（信息更全）", () => {
    const root = clipboardToMdast({
      html: "<table><tr><th>甲</th></tr><tr><td>1</td></tr></table>",
      text: "甲\t乙\n1\t2",
    })!;
    const out = serializeMd(root as never);
    expect(out).toContain("| 甲 |");
    expect(out).not.toContain("乙"); // plain 那份的第二列没被用
  });

  it("只有 plain 且含制表符时走 TSV 兜底", () => {
    const out = serializeMd(clipboardToMdast({ text: "甲\t乙\n1\t2" }) as never);
    expect(tableLines(out)).toHaveLength(3);
    expect(out).toContain("| 甲 | 乙 |");
  });

  it("普通文字返回 null（交回 PM 默认插入，不触发转换）", () => {
    expect(clipboardToMdast({ text: "就是一句话" })).toBeNull();
    expect(clipboardToMdast({})).toBeNull();
  });
});

describe("粘贴的表格并入光标所在的表（115 的 UI 约定）", () => {
  /** 造一张 2 列 3 行的宿主表，光标放进第 row 行第 col 列 */
  const hostState = (row: number, col: number): EditorState => {
    const doc = mdastToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n");
    let seen = -1;
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos >= 0) return false;
      if (n.type.name === "table_cell" || n.type.name === "table_header") {
        seen++;
        if (seen === row * 2 + col) pos = p + 1;
      }
      return true;
    });
    const base = EditorState.create({ doc, schema: hpSchema });
    return base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(pos))));
  };

  const pastedNodes = (md: string): PMNode[] => mdastRootToNodes(parseMd(md).children);

  const tableOf = (doc: PMNode): PMNode => {
    let hit: PMNode | null = null;
    doc.descendants((n) => {
      if (!hit && n.type.name === "table") hit = n;
      return true;
    });
    return hit!;
  };

  const rowsOf = (t: PMNode): string[][] => {
    const out: string[][] = [];
    t.forEach((r) => {
      const cells: string[] = [];
      r.forEach((c) => cells.push(c.textContent));
      out.push(cells);
    });
    return out;
  };

  it("插在光标所在行下面，列数一致时不补格", () => {
    const state = hostState(1, 0); // 「1」那一行
    const tr = mergePastedTable(state, pastedNodes("| X | Y |\n| --- | --- |\n")[0]);
    expect(tr).not.toBeNull();
    expect(rowsOf(tableOf(tr!.doc))).toEqual([
      ["A", "B"],
      ["1", "2"],
      ["X", "Y"],
      ["3", "4"],
    ]);
  });

  it("列数不一致：两边都补到最大列数，谁的内容都不丢", () => {
    const state = hostState(1, 0);
    const wide = mdastRootToNodes(
      parseMd("| P | Q | R |\n| --- | --- | --- |\n").children
    )[0];
    const rows = rowsOf(tableOf(mergePastedTable(state, wide)!.doc));
    expect(rows).toEqual([
      ["A", "B", ""],
      ["1", "2", ""],
      ["P", "Q", "R"],
      ["3", "4", ""],
    ]);
  });

  it("粘进来的表头行降级成数据行（宿主第一行仍是唯一表头）", () => {
    const state = hostState(1, 0);
    const pasted = pastedNodes("| H1 | H2 |\n| --- | --- |\n| a | b |\n")[0];
    const table = tableOf(mergePastedTable(state, pasted)!.doc);
    const types: string[][] = [];
    table.forEach((r) => {
      const row: string[] = [];
      r.forEach((c) => row.push(c.type.name));
      types.push(row);
    });
    expect(types[0]).toEqual(["table_header", "table_header"]); // 宿主表头
    expect(types[2]).toEqual(["table_cell", "table_cell"]); // 粘进来的那行已降级
    expect(types.flat().filter((t) => t === "table_header")).toHaveLength(2); // 全文只有这一行表头
  });

  it("光标不在表格里 → 返回 null，走整块插入", () => {
    const doc = mdastToDoc("段落。\n");
    const base = EditorState.create({ doc, schema: hpSchema });
    const state = base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(1))));
    expect(mergePastedTable(state, pastedNodes("| A |\n| --- |\n")[0])).toBeNull();
  });

  it("合并后的文档仍然合法（doc.check 过）", () => {
    const state = hostState(2, 1);
    const tr = mergePastedTable(state, pastedNodes("| X | Y | Z |\n| --- | --- | --- |\n")[0])!;
    expect(tr.doc.check()).toBeUndefined();
    // 光标落在新插入的那一行里
    expect(tr.selection.$from.parent.textContent).toBe("Y"); // 光标保住宿主那一列（col 1）
  });
});

describe("粘贴的非行内内容不许劈开宿主表（桌面实测抓出来的缺陷）", () => {
  const HOST = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";

  /** 造一张 2 列 4 行的宿主表，光标放进第 row 行第 col 格 */
  const cellState = (row: number, col: number): EditorState => {
    const doc = mdastToDoc(HOST);
    let seen = -1;
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos >= 0) return false;
      if (n.type.name === "table_cell" || n.type.name === "table_header") {
        seen++;
        if (seen === row * 2 + col) pos = p + 1;
      }
      return true;
    });
    const base = EditorState.create({ doc, schema: hpSchema });
    return base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(pos))));
  };

  const nodesOf = (md: string) => mdastRootToNodes(parseMd(md).children);
  const tablesIn = (doc: PMNode) => {
    let n = 0;
    doc.forEach((b) => {
      if (b.type.name === "table") n++;
    });
    return n;
  };
  const hostRows = (doc: PMNode): string[][] => {
    let table: PMNode | null = null;
    doc.forEach((b) => {
      if (!table && b.type.name === "table") table = b;
    });
    const out: string[][] = [];
    (table as PMNode).forEach((r) => {
      const cells: string[] = [];
      r.forEach((c) => cells.push(c.textContent));
      out.push(cells);
    });
    return out;
  };

  it("粘多块（标题+段落+列表+表）→ 表不劈开，整组落在表下面", () => {
    const state = cellState(1, 0);
    const tr = placePastedBlocks(
      state,
      nodesOf(
        "## 小标题\n\n带**粗体**的一段。\n\n- 列表甲\n- 列表乙\n\n| 科室 | 受理量 |\n| --- | --- |\n| 采油 | 1,234 |\n"
      )
    )!;
    expect(tr.doc.check()).toBeUndefined();
    expect(tablesIn(tr.doc)).toBe(2); // 宿主表 + 粘进来的表，宿主表没被切成两张
    expect(hostRows(tr.doc)).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
    const md = serializeMd(docToMdast(tr.doc) as never);
    // 顺序：宿主表 → 粘的块
    expect(md.indexOf("| 3")).toBeLessThan(md.indexOf("## 小标题"));
    expect(md).toContain("- 列表乙");
    expect(md).toContain("1,234");
  });

  it("全是段落 → 行内投进当前格子，段落之间是 <br>（表格一字不动）", () => {
    const state = cellState(1, 0);
    const tr = placePastedBlocks(state, nodesOf("甲\n\n乙\n"))!;
    expect(tablesIn(tr.doc)).toBe(1);
    // 光标在「1」前面（空选区 = 插入，不替换），所以那格变成「甲<br>乙1」
    const md = serializeMd(docToMdast(tr.doc) as never);
    expect(md).toContain("甲<br>乙1"); // Q2 口径：单元格换行 = <br>，不是空格、也不是 hard_break 变出的空格
    expect(md).not.toContain("## ");
    expect(md).toContain("| 3");
  });

  it("粘贴的表格里单元格有多段落 → `<br>` 不能丢（rawOf 无源时的 fallback）", () => {
    const html =
      "<table><tr><td>项目</td><td>备注</td></tr>" +
      "<tr><td>多行</td><td><p>第一行</p><p>第二行</p></td></tr></table>";
    const doc = mdastToDoc("占位段落。\n");
    const table = mdastRootToNodes(htmlToMdast(html).children)[0];
    const withTable = doc.type.create(doc.attrs, [table]);
    const md = serializeMd(docToMdast(withTable) as never);
    // 曾经这里写成「第一行第二行」挤成一格：粘贴的块没有源区间，raw 取成空串就没了
    expect(md).toContain("第一行<br>第二行");
  });

  it("粘一张表 + 一段说明 → 不并（不是一张表），整组照样落表下面", () => {
    const state = cellState(1, 1);
    const tr = placePastedBlocks(state, nodesOf("| X | Y |\n| --- | --- |\n\n说明。\n"))!;
    expect(tablesIn(tr.doc)).toBe(2);
    expect(hostRows(tr.doc)).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("格子内选中了文字再粘多块 → 选区删掉，但仍不许劈表", () => {
    const doc = mdastToDoc("| AB | B |\n| --- | --- |\n| 1 | 2 |\n");
    let seen = -1;
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos >= 0) return false;
      if (n.type.name === "table_cell" || n.type.name === "table_header") {
        seen++;
        if (seen === 2) pos = p + 1;
      }
      return true;
    });
    const base = EditorState.create({ doc, schema: hpSchema });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(doc, pos + 1, pos + 2)) // 选中「1」
    );
    const tr = placePastedBlocks(state, nodesOf("## 标题\n"))!;
    expect(tablesIn(tr.doc)).toBe(1);
    expect(hostRows(tr.doc)).toEqual([["AB", "B"], ["", "2"]]);
  });

  it("光标不在表格里 → 返回 null（走原来的整块插入路径）", () => {
    const doc = mdastToDoc("段落。\n");
    const base = EditorState.create({ doc, schema: hpSchema });
    const state = base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(1))));
    expect(placePastedBlocks(state, nodesOf("## 标题\n"))).toBeNull();
  });

  it("回归钉子：直接 replaceSelection 就会劈表（所以必须有上面那条）", () => {
    const state = cellState(1, 0);
    const nodes = nodesOf("## 小标题\n\n| 科室 | 受理量 |\n| --- | --- |\n| 采油 | 1,234 |\n");
    const naive = state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0));
    // 注意 doc.check() 是过的 —— 非法结构不是这里的判据，**表被切成两张**才是
    expect(naive.doc.check()).toBeUndefined();
    expect(tablesIn(naive.doc)).toBeGreaterThan(2);
  });
});

describe("Excel / Word 表格 HTML 的对齐与跨格", () => {

  it("Excel 只把对齐写在 style 里，也要认（唯一的 style 例外）", () => {
    const out = serializeMd(
      htmlToMdast(
        "<table><tr><td style='text-align:right'>数</td><td style='text-align:center'>中</td><td>默</td></tr></table>"
      ) as never
    );
    const sep = out.split("\n")[1];
    expect(sep).toContain("-:");
    expect(sep).toContain(":-:");
    // 其余 style 内容一律不进结果
    expect(out).not.toContain("style");
  });

  it("含跨格的表格不并（GFM 表达不了跨格），走整块插入", () => {
    const doc = mdastToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const base = EditorState.create({ doc, schema: hpSchema });
    const state = base.apply(base.tr.setSelection(TextSelection.near(doc.resolve(doc.content.size - 3))));
    const spanTable = hpSchema.nodes.table.create(
      { align: [null, null] },
      Fragment.from([
        hpSchema.nodes.table_row.create(
          null,
          Fragment.from(hpSchema.nodes.table_cell.create({ colspan: 2 }, Fragment.from(hpSchema.nodes.paragraph.create())))
        ),
      ])
    );
    expect(mergePastedTable(state, spanTable)).toBeNull();
  });
});
