import { describe, expect, it } from "vitest";
import {
  applyLabelEdit,
  diagramType,
  findTextSpans,
  labelToEditableHtml,
  preWrapMermaid,
  scanMermaidLabels,
  wrapLabel,
  wrapLabelLines,
  type LabelSpan,
} from "../../src/kernel/mermaidLabels";

/**
 * 125：Mermaid 标签解析 / 折行 / 改字写回 —— 纯函数接缝，不起浏览器。
 *
 * 「渲染前自己折行」与「双击改字」都压在这份解析上，所以判据写成
 * **源码切片必须逐字节等于 span 说的那个区间** —— 偏移错一位就会写坏用户的图。
 */

/** 假字宽：中文 16、英文字母 8、空格 4、其它 16。断行位置因此完全可预测 */
const measure = (s: string) =>
  [...s].reduce((a, ch) => a + (/[A-Za-z0-9.,:;!?()\[\]{}'"/\\%#&*+=<>_$-]/.test(ch) ? 8 : ch === " " ? 4 : 16), 0);

const spanOf = (src: string, i = 0): LabelSpan => {
  const spans = scanMermaidLabels(src);
  expect(spans.length, `源码里该认出标签：${src}`).toBeGreaterThan(i);
  return spans[i];
};

describe("scanMermaidLabels：认出标签、且区间逐字节对得上", () => {
  const cases: [string, string, string][] = [
    ["A[开始]", "A", "开始"],
    ["B{二级单位会签：设备管理主管}", "B", "二级单位会签：设备管理主管"],
    ["C(圆角)", "C", "圆角"],
    ["D((圆形))", "D", "圆形"],
    ["E[[子程序]]", "E", "子程序"],
    ["F[(数据库)]", "F", "数据库"],
    ["G([准备])", "G", "准备"],
    ["H{{判断}}", "H", "判断"],
    ["I[/平行四边形/]", "I", "平行四边形"],
    ["J>旗形]", "J", "旗形"],
  ];
  for (const [src, id, text] of cases) {
    it(`${src} → 节点 ${id} 的标签是「${text}」`, () => {
      const s = spanOf(src);
      expect([s.kind, s.id, s.text]).toEqual(["node", id, text]);
      // 偏移正确性：按 span 说的位置切，切出来的就是这个字
      expect(src.slice(s.from, s.to)).toBe(text);
      expect(src.slice(s.bodyFrom, s.bodyTo)).toBe(text);
    });
  }

  it("连线标签 |…| 也认，且 id 按源码顺序编号", () => {
    const src = "A[开始] -->|退回重报| B[提交]\nB -->|通过| C[归档]";
    const spans = scanMermaidLabels(src);
    const edges = spans.filter((s) => s.kind === "edge");
    expect(edges.map((e) => e.text)).toEqual(["退回重报", "通过"]);
    expect(edges.map((e) => e.id)).toEqual(["edge#0", "edge#1"]);
    for (const e of edges) expect(src.slice(e.from, e.to)).toBe(e.text);
  });

  it("带引号的标签里，结束定界符算文字（A[\"文本 ] 也算\"] 不能被切坏）", () => {
    const src = 'A["文本 ] 也算"]';
    const s = spanOf(src);
    expect(s.quoted).toBe(true);
    expect(s.text).toBe("文本 ] 也算");
    expect(src.slice(s.from, s.to)).toBe("文本 ] 也算");
    // 可替换区含外层引号，写回时引号跟着一起换
    expect(src.slice(s.bodyFrom, s.bodyTo)).toBe('"文本 ] 也算"');
  });

  it("双层定界符先试长的：A[[x]] 的文字是 x 不是 [x", () => {
    expect(spanOf("A[[x]]").text).toBe("x");
    expect(spanOf("D((圆形))").text).toBe("圆形");
  });

  it("标签内部的括号不另起一个标签", () => {
    const spans = scanMermaidLabels("A[备(注)]");
    expect(spans.length).toBe(1);
    expect(spans[0].text).toBe("备(注)");
  });

  it("不跨行：没闭合的那条不认，下一行照常认", () => {
    const spans = scanMermaidLabels("A[没闭合\nB[x]");
    expect(spans.map((s) => s.id)).toEqual(["B"]);
  });

  it("`%%{init}%%` 指令与注释行不当标签（花括号不是标签）", () => {
    expect(scanMermaidLabels('%%{init: {"theme":"dark"}}%%\nA[图]')).toHaveLength(1);
    expect(scanMermaidLabels("%% 注释 {不是标签}\nB[图]")).toHaveLength(1);
  });

  it("中文节点 id 也认（PRD 里真有人这么写）", () => {
    const s = spanOf("设备[会签]");
    expect(s.id).toBe("设备");
    expect(s.text).toBe("会签");
  });

  it("空标签不当文字（A[] 不参与折行也不被当成可改的一段）", () => {
    const spans = scanMermaidLabels("A[] -->|提示| B[x]");
    expect(spans.map((s) => s.text)).toEqual(["提示", "x"]);
  });

  it("箭头里的 `>` 不是旗形标签的起始符（第一版就错认在这儿）", () => {
    // `-->|文字|` 的 `>` 前面是 `--`，恰好落在 id 字符集里；
    // 不加「id 必须含字母/数字/汉字」这条，整段 `|文字| B[归档]` 会被当成一个标签，
    // 改字时就会把连线与下一个节点一起吞掉。
    const src = "A[开始] -->|退回| B[归档]";
    const spans = scanMermaidLabels(src);
    expect(spans.map((s) => [s.kind, s.id, s.text])).toEqual([
      ["node", "A", "开始"],
      ["edge", "edge#0", "退回"],
      ["node", "B", "归档"],
    ]);
    // 旗形写法本身还是要认的（`A>文字]` 是合法 mermaid）
    expect(scanMermaidLabels("A>旗形]")[0].text).toBe("旗形");
    // 粗箭头 `==>` / 虚线 `-.->` 同理不能错认
    expect(scanMermaidLabels("A[甲] ==>|粗| B[乙]").map((s) => s.text)).toEqual(["甲", "粗", "乙"]);
    expect(scanMermaidLabels("A[甲] -.->|虚| B[乙]").map((s) => s.text)).toEqual(["甲", "虚", "乙"]);
  });
});

describe("preWrapMermaid：折行只动标签，幂等，且不超宽", () => {
  const LONG = "二级单位会签：设备管理主管确认并出具意见后归档办结";

  it("折出来的每一行宽度都不超过 maxWidth", () => {
    const rows = wrapLabelLines(LONG, 48, measure);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(measure(r)).toBeLessThanOrEqual(48);
  });

  it("折行不丢字：把 <br/> 去掉就是原文", () => {
    const wrapped = wrapLabel(LONG, 48, measure);
    expect(wrapped.replace(/<br\/>/g, "")).toBe(LONG);
  });

  it("幂等：折过的再折一次不变（先按已有 <br> 分段）", () => {
    const once = wrapLabel(LONG, 48, measure);
    expect(wrapLabel(once, 48, measure)).toBe(once);
    // 三种写法都当换行认：mermaid 文档里 <br>、<br/>、<br /> 都常见
    expect(wrapLabel("甲<br>乙<br />丙", 48, measure).replace(/<br\/>/g, "")).toBe("甲乙丙");
  });

  it("短的标签一个字都不动（不为了折而折）", () => {
    const src = "A[开始] -->|通过| B[归档]";
    expect(preWrapMermaid(src, { maxWidth: 200, measure })).toBe(src);
  });

  it("整份源码：只有标签里多了 <br/>，标签外逐字节不变", () => {
    const src =
      "flowchart TD\n  A[" + LONG + "] -->|" + LONG.slice(0, 12) + "| B[结束]\n  %% 注释\n  B --> C[" + LONG + "]\n";
    const out = preWrapMermaid(src, { maxWidth: 64, measure });
    expect(out.replace(/<br\/>/g, "")).toBe(src); // 除了插入的换行，什么都没改
    expect(out).not.toBe(src);
    // 标签外的骨架逐字节还在
    expect(out).toContain("flowchart TD\n  A[");
    expect(out).toContain("] -->|");
    expect(out).toContain("| B[结束]\n  %% 注释\n");
  });

  it("英文按词断，不在词中间断行；行首不留空格", () => {
    const rows = wrapLabelLines("device management supervisor confirmed", 40, measure);
    for (const r of rows) expect(r.startsWith(" ")).toBe(false);
    expect(rows.join("")).toContain("management");
    expect(rows.every((r) => measure(r) <= 40)).toBe(true);
  });

  it("单个超长单元（长 URL）按字硬切，绝不溢出", () => {
    const rows = wrapLabelLines("https://example.com/very/long/path/name.png", 40, measure);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => measure(r) <= 40)).toBe(true);
    expect(rows.join("")).toBe("https://example.com/very/long/path/name.png");
  });
});

describe("labelToEditableHtml：编辑区显示的是源码文字，不是渲染产物", () => {
  it("用户自己写的 <br> 保留成活换行", () => {
    expect(labelToEditableHtml("第一行<br>第二行")).toBe("第一行<br>第二行");
    expect(labelToEditableHtml("第一行<br/>第二行")).toBe("第一行<br>第二行");
  });

  it("其余尖括号一律转义（contenteditable 里不许出现活的标签）", () => {
    expect(labelToEditableHtml('含 <img onerror="x"> 的文字')).toBe(
      "含 &lt;img onerror=\"x\"&gt; 的文字"
    );
    expect(labelToEditableHtml("a & b")).toBe("a &amp; b");
  });

  it("我们渲染时插的折行不会以「用户换行」的身份回到编辑区（这条是 125 的真缺陷）", () => {
    // 渲染输入被 preWrapMermaid 插过 <br/>，但 span.text 是**源码原文**（没有那些 <br/>），
    // 所以编辑区里不该出现换行；取消时也就不会把 <br/> 写回源码
    const src = "A[" + "二级单位会签：设备管理主管确认并出具意见后归档办结" + "]";
    const s = spanOf(src);
    expect(labelToEditableHtml(s.text)).not.toContain("<br>");
    expect(applyLabelEdit(src, s, s.text).ok).toBe(true);
  });
});

describe("applyLabelEdit：只换那一段文字，写不进去就拒绝", () => {
  it("改中文标签：定界符与其余源码一个字符都不动", () => {
    const src = "A[开始] -->|退回重报| B[归档]";
    const s = spanOf(src, 1); // 第一个是节点「开始」，第二个才是连线标签
    const r = applyLabelEdit(src, s, "退回修改");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.src).toBe("A[开始] -->|退回修改| B[归档]");
  });

  it("新文字里有会提前结束标签的字符 → 自动加引号保住它", () => {
    const src = "A[开始]";
    const r = applyLabelEdit(src, spanOf(src), "文本 ] 含右括号");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.src).toBe('A["文本 ] 含右括号"]');
      expect(r.quoted).toBe(true);
      // 加完引号后它仍然是个合法标签：再扫一次，文字没变
      expect(spanOf(r.src).text).toBe("文本 ] 含右括号");
    }
  });

  it("双引号 + 结束符同时出现：没法安全表示，拒绝并说明（不猜）", () => {
    const r = applyLabelEdit("A[开始]", spanOf("A[开始]"), '含 " 和 ] 的文字');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("源码模式");
  });

  it("空文字拒绝（多半是误操作，图里没有空节点）", () => {
    const r = applyLabelEdit("A[开始]", spanOf("A[开始]"), "   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不能是空的");
  });

  it("Shift+Enter 的换行落成 <br/>（和折行同一套表示）", () => {
    const r = applyLabelEdit("A[开始]", spanOf("A[开始]"), "第一行\n第二行");
    expect(r.ok && r.src).toBe("A[第一行<br/>第二行]");
  });

  it("改完再扫一次：只有那一个 span 变了，别的 span 位置与文字不变", () => {
    const src = "A[开始] -->|退回| B[归档]";
    const before = scanMermaidLabels(src);
    const r = applyLabelEdit(src, before[0], "起步");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = scanMermaidLabels(r.src);
    expect(after.map((s) => s.text)).toEqual(["起步", "退回", "归档"]);
    expect(after.slice(1).map((s) => s.id)).toEqual(before.slice(1).map((s) => s.id));
  });
});

/* ------------------------------------------------------------------ 126 */

/** 126 贴的两张图（原样，只把无关的行删掉） */
const ER_SRC = `erDiagram
    采购申请 ||--o{ 验收单 : "发起验收"
    验收单 ||--|{ 设备清单行 : "逐行填报"
    验收单 ||--o| 附件 : "设备验收总结"
    采购申请 {
        string apply_no PK "采购申请编号"
        string apply_name "采购申请名称"
        decimal project_amount "立项金额"
    }
    验收单 {
        string order_no PK "验收单编号"
        enum status "草稿/驳回/审核中"
    }`;

const STATE_SRC = `stateDiagram-v2
    [*] --> 草稿: 保存草稿
    草稿 --> 审核中: 提交
    审核中 --> 已完成: 审批通过
    note right of 审核中: 提交环节阻断
    state "验收单终态" as FIN
    FIN --> [*]`;

describe("diagramType：按第一行有效内容分派", () => {
  it("四种图各归各位，认不出的不当 flowchart", () => {
    expect(diagramType(ER_SRC)).toBe("er");
    expect(diagramType(STATE_SRC)).toBe("state");
    expect(diagramType("flowchart TD\n  A[x]")).toBe("flowchart");
    expect(diagramType("graph LR\n  A[x]")).toBe("flowchart");
    expect(diagramType("pie\n  \"甲\" : 1")).toBe("other");
    // `%%{init}%%` 指令行不能把类型带偏
    expect(diagramType('%%{init: {"theme":"dark"}}%%\nerDiagram\n  A ||--o{ B : "x"')).toBe("er");
  });

  it("认不出的图类型扫不出任何标签（拿 flowchart 语法去猜别的图 = 会写坏）", () => {
    expect(scanMermaidLabels('pie\n  "甲" : 1')).toEqual([]);
    expect(scanMermaidLabels("sequenceDiagram\n  A->>B: 你好")).toEqual([]);
  });
});

describe("erDiagram：关系标签与属性行能改，实体名是标识符不给改", () => {
  it("三条关系标签按源码顺序成为 edge（渲染产物里 .edgeLabels > g 就是按这个顺序）", () => {
    const edges = scanMermaidLabels(ER_SRC).filter((s) => s.kind === "edge");
    expect(edges.map((s) => s.text)).toEqual(["发起验收", "逐行填报", "设备验收总结"]);
    for (const e of edges) expect(ER_SRC.slice(e.from, e.to)).toBe(e.text);
  });

  it("属性行四列各是一条 span，偏移逐字节对得上", () => {
    // 只看 `string apply_no PK "采购申请编号"` 这一行范围内的 span（"string" 在别的行也有，
    // 按文字全局筛会把三行混在一起 —— 上一版就是这么误判成「多出了 4 条」）
    const lineStart = ER_SRC.indexOf("string apply_no");
    const lineEnd = ER_SRC.indexOf("\n", lineStart);
    const 第一行 = scanMermaidLabels(ER_SRC)
      .filter((s) => s.kind === "text" && s.from >= lineStart && s.to <= lineEnd)
      .sort((a, b) => a.from - b.from);
    expect(第一行.map((s) => [s.id, s.text])).toEqual([
      ["attr-type", "string"],
      ["attr-name", "apply_no"],
      ["attr-keys", "PK"],
      ["attr-comment", "采购申请编号"],
    ]);
    for (const s of 第一行) expect(ER_SRC.slice(s.from, s.to)).toBe(s.text);
  });

  it("没有键标记的属性行不会把注释当成键（`string apply_name \"采购申请名称\"`）", () => {
    const row = scanMermaidLabels(ER_SRC).filter((s) => s.kind === "text" && ["apply_name", "采购申请名称"].includes(s.text));
    expect(row.map((s) => s.id)).toEqual(["attr-name", "attr-comment"]);
  });

  it("实体名解析得出来但标成 id（不给就地改）", () => {
    const ids = scanMermaidLabels(ER_SRC).filter((s) => s.kind === "id");
    expect(new Set(ids.map((s) => s.text))).toEqual(new Set(["采购申请", "验收单"]));
  });

  it("改注释：只换那一处，引号保住它", () => {
    const target = spanOf(ER_SRC.replace("采购申请编号", "编号"), 0);
    void target;
    const s = scanMermaidLabels(ER_SRC).find((x) => x.text === "立项金额")!;
    const r = applyLabelEdit(ER_SRC, s, "立项金额（含税）");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.src).toContain('"立项金额（含税）"');
      expect(r.src).not.toContain('"立项金额"');
      // 其余逐字节不动
      expect(r.src.replace("立项金额（含税）", "立项金额")).toBe(ER_SRC);
    }
  });

  it("属性名里打空格会被拒绝（会把一行拆成两个 token）", () => {
    const s = scanMermaidLabels(ER_SRC).find((x) => x.text === "apply_no" && x.id === "attr-name")!;
    const r = applyLabelEdit(ER_SRC, s, "apply no");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不带空格");
  });

  it("ER 里换行被拒绝（属性行是单行语法，不像 flowchart 能塞 <br/>）", () => {
    const s = scanMermaidLabels(ER_SRC).find((x) => x.text === "立项金额")!;
    expect(s.multiline).toBe(false);
    const r = applyLabelEdit(ER_SRC, s, "第一行\n第二行");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("只能写一行");
  });

  it("preWrapMermaid 不动 ER / state（只折 flowchart）", () => {
    expect(preWrapMermaid(ER_SRC, { maxWidth: 40, measure })).toBe(ER_SRC);
    expect(preWrapMermaid(STATE_SRC, { maxWidth: 40, measure })).toBe(STATE_SRC);
  });
});

describe("stateDiagram-v2：迁移标签、状态描述、note 正文能改", () => {
  it("迁移标签按源码顺序成为 edge", () => {
    const edges = scanMermaidLabels(STATE_SRC).filter((s) => s.kind === "edge");
    expect(edges.map((s) => s.text)).toEqual(["保存草稿", "提交", "审批通过"]);
    for (const e of edges) expect(STATE_SRC.slice(e.from, e.to)).toBe(e.text);
  });

  it("`state \"…\" as X` 的描述与 note 正文是 text span", () => {
    const texts = scanMermaidLabels(STATE_SRC).filter((s) => s.kind === "text");
    expect(texts.map((s) => [s.id, s.text])).toEqual([
      ["note", "提交环节阻断"],
      ["state-desc", "验收单终态"],
    ]);
  });

  it("裸状态名（草稿 / 审核中）是标识符，不给改", () => {
    const ids = scanMermaidLabels(STATE_SRC).filter((s) => s.kind === "id").map((s) => s.text);
    expect(ids).toContain("草稿");
    expect(ids).toContain("审核中");
  });

  it("改迁移标签：只动冒号后面那一段", () => {
    const s = scanMermaidLabels(STATE_SRC).filter((x) => x.kind === "edge")[1];
    const r = applyLabelEdit(STATE_SRC, s, "提交送审");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.src).toContain("草稿 --> 审核中: 提交送审");
      expect(r.src.replace("提交送审", "提交")).toBe(STATE_SRC);
    }
  });
});

/**
 * 127：通用倒查 —— 「屏幕上这行字在源码里只出现一次」这条判据。
 *
 * 这是**没有类型专属解析器的二十来种图**共用的一条路，所以偏移算错一位就是写坏用户的图，
 * 判据一律写成 `src.slice(from, to) === 那行字` 这种逐字对法。
 */
describe("findTextSpans：渲染文字 → 源码候选", () => {
  it("整行就是那行字（mindmap / journey 的缩进节点）", () => {
    const src = "mindmap\n  root((审批))\n    提交\n";
    const hits = findTextSpans(src, "提交");
    expect(hits).toHaveLength(1);
    expect(src.slice(hits[0].from, hits[0].to)).toBe("提交");
    // 缩进行：区间要落在去掉缩进后的那个词上，不是行首
    expect(src.slice(hits[0].from - 5, hits[0].from)).toBe("\n    ");
  });

  it("行内裸着的一段（sequence 的消息文字）", () => {
    const src = "sequenceDiagram\n  甲->>乙: 提交申请\n";
    const hits = findTextSpans(src, "提交申请");
    expect(hits).toHaveLength(1);
    expect(src.slice(hits[0].from, hits[0].to)).toBe("提交申请");
  });

  it("带引号的字面量：命中的是引号里那段，可替换区含引号", () => {
    const src = 'pie title 占比\n  "草稿" : 34\n';
    const hits = findTextSpans(src, "草稿");
    expect(hits).toHaveLength(1);
    expect(hits[0].quoted).toBe(true);
    expect(src.slice(hits[0].from, hits[0].to)).toBe("草稿");
    expect(src.slice(hits[0].bodyFrom, hits[0].bodyTo)).toBe('"草稿"');
  });

  it("出现两次 = 两个候选，调用方据此拒绝（不改坏图优先于能改）", () => {
    const src = "sequenceDiagram\n  甲->>乙: 重复\n  乙->>甲: 重复\n";
    expect(findTextSpans(src, "重复")).toHaveLength(2);
  });

  it("类名这种被别处引用的标识符也是两个候选 → 拒绝", () => {
    const src = "classDiagram\n  class 审批单 {\n    +编号 String\n  }\n  审批单 --> 员工 : 归属\n";
    expect(findTextSpans(src, "审批单")).toHaveLength(2);
    expect(findTextSpans(src, "+编号 String")).toHaveLength(1);
    expect(findTextSpans(src, "归属")).toHaveLength(1);
  });

  it("源码里根本没有的字（饼图百分比是算出来的）→ 零候选", () => {
    const src = 'pie title 占比\n  "草稿" : 34\n';
    expect(findTextSpans(src, "67%")).toEqual([]);
    expect(findTextSpans(src, "")).toEqual([]);
  });

  it("围栏里的行不参与查找：注释里的字撞不上正文的标签", () => {
    const src = "gantt\n  title 排期\n  写草稿 : a1, 3d\n";
    expect(findTextSpans(src, "写草稿")).toHaveLength(1);
    // mermaid 源码里的 ``` 段落（文档块）不是标签来源：那行「开始」不该算进候选
    const withBlock = "flowchart TD\n  A[开始] --> B[结束]\n```\n  开始\n```\n";
    expect(findTextSpans(withBlock, "开始")).toHaveLength(1);
  });

  it("改完只有那一处变：写回用的仍是同一个区间", () => {
    const src = "sequenceDiagram\n  甲->>乙: 提交申请\n";
    const hit = findTextSpans(src, "提交申请")[0];
    const r = applyLabelEdit(src, hit, "递交申请单");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.src).toBe("sequenceDiagram\n  甲->>乙: 递交申请单\n");
  });
});
