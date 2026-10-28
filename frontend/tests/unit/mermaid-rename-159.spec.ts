import { describe, expect, it } from "vitest";

import {
  aliasTextOf,
  applyAliasSet,
  applyIdentifierRename,
  findTextSpans,
  pairSpansByOrder,
  renameTargetOf,
  scanIdentifierOccurrences,
  scanMermaidLabels,
} from "../../src/kernel/mermaidLabels";

/**
 * 159 片 1：Mermaid「一起改名」与「只改显示（别名）」的纯函数判据。
 *
 * 这三条口径是这颗功能的全部风险所在，都跟"会不会把用户的图改坏"直接相关：
 * ① **改名只动标识符语法位**，显示文字里出现的同名一个字节都不许动
 *    （`B[读 A 的值]` 里那个 A 是内容，不是引用）；
 * ② **别名一律就地改写，绝不追加第二份**（实测：重复声明在 state 会出两个框、
 *    ER 第一个赢、class 与 sequence 最后一个赢 —— 追加等于把图改坏）；
 * ③ **拿不准就拒绝**，拒绝时源码逐字节不变，并说清为什么。
 */

describe("159①：标识符语法位", () => {
  it("flowchart：声明头与边两端算，标签正文里的同名不算", () => {
    const src = "flowchart LR\n  A[起步] --> B[读 A 的值]\n  B --> C[A 的下游]";
    const at = scanIdentifierOccurrences(src, "A");
    // 只有第一行的声明头 `A` 和第三行没有？`C[A 的下游]` 是 C 的标签，不算 A 的位置
    expect(at.map((s) => src.slice(s.from, s.to)), "标签正文必须被排除").toEqual(["A"]);
    const b = scanIdentifierOccurrences(src, "B");
    expect(b.length, "B 出现在声明头与第一条边的右端 = 2 处").toBe(2);
  });

  it("flowchart：改名一次覆盖全部引用位，正文原样", () => {
    const src = "flowchart LR\n  A[起步] --> B[读 A 的值]\n  B --> A";
    const r = applyIdentifierRename(src, "A", "START");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count, "声明头 + 孤立引用 = 2 处").toBe(2);
    expect(r.src).toBe("flowchart LR\n  START[起步] --> B[读 A 的值]\n  B --> START");
  });

  it("flowchart：长名字里含同名不算命中（按整词，不按子串）", () => {
    const src = "flowchart LR\n  ADMIN[管理员] --> A[普通]";
    const at = scanIdentifierOccurrences(src, "A");
    expect(at.map((s) => src.slice(s.from, s.to))).toEqual(["A"]);
  });

  it("汉字名字：字符区间写坏了这条先红（判据的判据）", () => {
    const src = "flowchart LR\n  起步[开始] --> 检查[查 起步 的值]\n  检查 --> 起步";
    const r = applyIdentifierRename(src, "起步", "受理");
    expect(r.ok && r.src, "标识符字符集必须含汉字，且标签正文照旧不碰").toBe(
      "flowchart LR\n  受理[开始] --> 检查[查 起步 的值]\n  检查 --> 受理"
    );
  });

  it("注释行与被引号包住的内容都不碰", () => {
    const src = 'flowchart LR\n  %% A 是旧写法，别改\n  A["A 自己也叫 A"] --> B';
    const r = applyIdentifierRename(src, "A", "C");
    expect(r.ok && r.src).toBe('flowchart LR\n  %% A 是旧写法，别改\n  C["A 自己也叫 A"] --> B');
    expect(r.ok && "count" in r && r.count).toBe(1);
  });
});


describe("159①：ER", () => {
  const src = [
    "erDiagram",
    '  CUSTOMER ||--o{ ORDER : "下单"',
    "  CUSTOMER {",
    "    string customer_id PK",
    "    string name",
    "  }",
  ].join("\n");

  it("块头与关系行两端算标识符位，属性行不算", () => {
    const at = scanIdentifierOccurrences(src, "CUSTOMER");
    expect(at.length, "关系行左端 + 块头 = 2 处").toBe(2);
    const r = applyIdentifierRename(src, "CUSTOMER", "CLIENT");
    expect(r.ok && r.src).toBe(
      [
        "erDiagram",
        '  CLIENT ||--o{ ORDER : "下单"',
        "  CLIENT {",
        "    string customer_id PK",
        "    string name",
        "  }",
      ].join("\n")
    );
  });

  it("关系标签里写着实体名也不动", () => {
    const labeled = 'erDiagram\n  CUSTOMER ||--o{ ORDER : "CUSTOMER 下单"';
    const r = applyIdentifierRename(labeled, "CUSTOMER", "CLIENT");
    expect(r.ok && r.src).toBe('erDiagram\n  CLIENT ||--o{ ORDER : "CUSTOMER 下单"');
  });
});

describe("159①：state", () => {
  const src = [
    "stateDiagram-v2",
    '  [*] --> Idle',
    '  state "等待中" as Idle',
    "  Idle --> Run : 启动",
    "  Run --> Idle : 停止",
    "  note right of Idle : 这里写着 Idle 也没用",
  ].join("\n");

  it("状态名的每一处语法位都算，迁移标签与 note 正文不算", () => {
    const at = scanIdentifierOccurrences(src, "Idle");
    expect(at.length, "首次出现 + as Idle + 两条迁移 + note of = 5 处").toBe(5);
    const r = applyIdentifierRename(src, "Idle", "WAIT");
    expect(r.ok && r.src).toBe(
      [
        "stateDiagram-v2",
        "  [*] --> WAIT",
        '  state "等待中" as WAIT',
        "  WAIT --> Run : 启动",
        "  Run --> WAIT : 停止",
        "  note right of WAIT : 这里写着 Idle 也没用",
      ].join("\n")
    );
  });
});

describe("159②：别名就地改写，绝不追加第二份", () => {
  it("ER：已有独立别名行 → 替换那一段，跑两次只有一份", () => {
    const src = 'erDiagram\n  CUSTOMER["客户"]\n  CUSTOMER ||--o{ ORDER : "下单"';
    const 一次 = applyAliasSet(src, "CUSTOMER", "顾客");
    expect(一次.ok).toBe(true);
    if (!一次.ok) return;
    expect(一次.src).toBe('erDiagram\n  CUSTOMER["顾客"]\n  CUSTOMER ||--o{ ORDER : "下单"');
    expect(一次.created, "已有别名就不算新建").toBe(false);
    const 二次 = applyAliasSet(一次.src, "CUSTOMER", "买家");
    expect(二次.ok && 二次.src).toBe('erDiagram\n  CUSTOMER["买家"]\n  CUSTOMER ||--o{ ORDER : "下单"');
    expect(二次.ok && "created" in 二次 && 二次.created).toBe(false);
  });

  it("ER：没有别名时只新建一条独立语句，不挂到关系行尾巴上", () => {
    const src = "erDiagram\n  CUSTOMER ||--o{ ORDER : 下单";
    const r = applyAliasSet(src, "CUSTOMER", "客户");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.src.split("CUSTOMER[\"").length - 1, "别名语句恰好一份").toBe(1);
    // 关系行本身一个字节不许变（挂上去就是 Parse error）
    expect(r.src).toContain('CUSTOMER ||--o{ ORDER : 下单');
  });

  it("state：已有 `state \"…\" as X` 就地改描述；没有则新建一条", () => {
    const 有 = 'stateDiagram-v2\n  state "等待" as Idle\n  Idle --> Run : 启动';
    const r1 = applyAliasSet(有, "Idle", "排队中");
    expect(r1.ok && r1.src).toBe('stateDiagram-v2\n  state "排队中" as Idle\n  Idle --> Run : 启动');
    expect(r1.ok && "created" in r1 && r1.created).toBe(false);

    const 无 = "stateDiagram-v2\n  Idle --> Run : 启动";
    const r2 = applyAliasSet(无, "Idle", "等待中");
    expect(r2.ok && r2.src).toContain('state "等待中" as Idle');
    expect(r2.ok && "created" in r2 && r2.created).toBe(true);
  });

  it("sequence：已有 `participant X as 名` 改那一名；没有则补一条 participant", () => {
    const 有 = "sequenceDiagram\n  participant A as 甲\n  A->>B: 发消息";
    const r1 = applyAliasSet(有, "A", "报销单");
    expect(r1.ok && r1.src).toBe("sequenceDiagram\n  participant A as 报销单\n  A->>B: 发消息");
    expect(r1.ok && "created" in r1 && r1.created).toBe(false);
  });
});

describe("159③：拿不准就拒绝，且一个字都不改", () => {
  const src = "flowchart LR\n  A[起步] --> B";

  it("新名字不是合法标识符（含空格、定界符）→ 拒", () => {
    for (const bad of ["A B", "A[", "A]", "A{B}", '"A"']) {
      const r = applyIdentifierRename(src, "A", bad);
      expect(r.ok, `「${bad}」必须被拒`).toBe(false);
      if (!r.ok) expect(r.reason.length, "拒绝要给得出理由").toBeGreaterThan(0);
    }
  });

  it("新名字已经作为别的标识符存在 → 拒（撞车会把两条线并成一条）", () => {
    const r = applyIdentifierRename("flowchart LR\n  A[起步] --> B\n  B --> C", "A", "C");
    expect(r.ok).toBe(false);
  });

  it("源码里根本没有这个标识符 → 拒，并说找不到", () => {
    const r = applyIdentifierRename(src, "NOPE", "X");
    expect(r.ok).toBe(false);
  });

  it("没标识符可改的图类型（journey 等）如实拒绝，不猜", () => {
    const r = applyIdentifierRename("journey\n  title 我的旅程\n  旅程: 5: 甲", "甲", "乙");
    expect(r.ok).toBe(false);
  });

  it("全图类型都不许把标签正文里的同名改掉：改名前后逐字节只差标识符", () => {
    const before = 'erDiagram\n  CUSTOMER ||--o{ ORDER : "CUSTOMER 与 ORDER 都提到"';
    const r = applyIdentifierRename(before, "CUSTOMER", "CLIENT");
    expect(r.ok && r.src).toBe('erDiagram\n  CLIENT ||--o{ ORDER : "CUSTOMER 与 ORDER 都提到"');
  });
});

/**
 * 159 片 2 的纯函数层：双击的那一处**背后有没有标识符**。
 *
 * 界面按这张表决定摆几颗键（不可用的那颗干脆不摆），所以这一层判错 = 界面上摆错键，
 * 也 = 「一起改名」改错东西。三条口径：
 * ① 节点标签（flowchart `A[起步]`）背后是 `A`，但改的是名字、不是这段文字 → `self: false`；
 * ② 双击的那段字本身就是标识符（ER 实体头、state 状态名）→ `self: true`，
 *    这时「只改显示」走别名那条路（`applyAliasSet`），不是把标识符本身换掉；
 * ③ 边标签、ER 属性行、note 正文这类**背后没有标识符**的一律 `null` —— 界面只给一颗键。
 */
describe("159②：双击位置背后的标识符", () => {
  const flow = "flowchart LR\n  A[起步] --> B[读 A 的值]\n  B --> A";
  const label = (src: string, text: string) => {
    const s = scanMermaidLabels(src).find((x) => x.text === text);
    if (!s) throw new Error(`夹具里没有这段标签：${text}`);
    return s;
  };

  it("flowchart 节点标签 → 给得出节点名与处数，self=false（改的是名字不是文字）", () => {
    const r = renameTargetOf(flow, label(flow, "起步"));
    expect(r).not.toBeNull();
    expect(r!.id).toBe("A");
    // 声明头的 A + `B --> A` 的 A = 2 处；`B[读 A 的值]` 那个 A 在标签正文里，不算
    expect(r!.count, "处数只能数标识符语法位").toBe(2);
    expect(r!.self).toBe(false);
  });

  it("flowchart 边标签 `A -->|起步| B` → null（边上没有自己的标识符）", () => {
    const src = "flowchart LR\n  A -->|起步| B";
    const r = renameTargetOf(src, label(src, "起步"));
    expect(r).toBeNull();
  });

  it("ER 实体头 `CUSTOMER {` → self=true（双击的就是标识符本身）", () => {
    const src = 'erDiagram\n  CUSTOMER {\n    string 编号 PK\n  }\n  CUSTOMER ||--o{ ORDER : "下单"';
    const r = renameTargetOf(src, label(src, "CUSTOMER"));
    expect(r).not.toBeNull();
    expect(r!.id).toBe("CUSTOMER");
    expect(r!.self).toBe(true);
    expect(r!.count, "块头 + 关系行两端各一处").toBe(2);
  });

  it("ER 带别名的实体头 `CUSTOMER[\"客户\"]` → 名字取定界符前面那段，不是整串", () => {
    const src = 'erDiagram\n  CUSTOMER["客户"] {\n    string 编号\n  }\n  CUSTOMER ||--o{ ORDER : "下单"';
    const r = renameTargetOf(src, label(src, 'CUSTOMER["客户"]'));
    expect(r, "整串带括号不是合法标识符，要认前面那段名字").not.toBeNull();
    expect(r!.id).toBe("CUSTOMER");
    expect(r!.self).toBe(true);
  });

  it("state 的 `state \"描述\" as S2` → 背后是 S2，self=false", () => {
    const src = 'stateDiagram-v2\n  state "等待受理" as S2\n  S2 --> S3 : go';
    const s = scanMermaidLabels(src).find((x) => x.text === "等待受理")!;
    const r = renameTargetOf(src, s);
    expect(r).not.toBeNull();
    expect(r!.id).toBe("S2");
    expect(r!.self).toBe(false);
  });

  it("sequence 的 `participant A as 报销单` → 背后是 A（走通用倒查那条路也要认得出）", () => {
    const src = "sequenceDiagram\n  participant A as 报销单\n  A->>B: 提交";
    const g = findTextSpans(src, "报销单");
    expect(g.length, "夹具本身要能定位到一段").toBe(1);
    const r = renameTargetOf(src, g[0]);
    expect(r).not.toBeNull();
    expect(r!.id).toBe("A");
    expect(r!.self).toBe(false);
  });

  it("ER 属性行（类型名 / 属性名 / 键标记）→ null：那是另一个命名空间，不跟着实体改名", () => {
    const src = 'erDiagram\n  CUSTOMER {\n    string 编号 PK "客户编号"\n  }';
    for (const text of ["string", "编号", "PK"]) {
      const s = scanMermaidLabels(src).find((x) => x.text === text);
      if (!s) continue;
      expect(renameTargetOf(src, s), `${text} 不该给出改名键`).toBeNull();
    }
  });

  it("state 迁移标签 `S2 --> S3 : go` → null（那是文字，不是标识符）", () => {
    const src = "stateDiagram-v2\n  S2 --> S3 : go";
    const r = renameTargetOf(src, label(src, "go"));
    expect(r).toBeNull();
  });

  it("图类型不认识（journey / pie）→ 一律 null，界面不摆第二颗键", () => {
    const src = "journey\n  title 我的旅程\n  写草稿: 5: 甲";
    const s = findTextSpans(src, "写草稿")[0];
    expect(s, "夹具要拿得到").toBeTruthy();
    expect(renameTargetOf(src, s)).toBeNull();
  });

  it("名字在这一版源码里已经找不到标识符位 → null（别摆一颗点下去必然拒绝的键）", () => {
    const src = "flowchart LR\n  A[起步]";
    const s = { ...label(src, "起步"), id: "GONE" };
    expect(renameTargetOf(src, s)).toBeNull();
  });
});

/**
 * 双击标识符时，编辑区里摆的必须是**显示名**，不是那串源码 token ——
 * 否则用户改完落盘的是「别名里塞着一整串带括号的名字」。
 */
describe("159②：编辑区里摆的是显示名", () => {
  const er = (token: string) => {
    const src = `erDiagram\n  ${token} {\n    string 编号\n  }`;
    const s = scanMermaidLabels(src).find((x) => x.kind === "id");
    if (!s) throw new Error(`夹具没解析出实体头：${token}`);
    return s;
  };

  it('带引号别名 `CUSTOMER["客户"]` → 剥出 客户', () => {
    const s = er('CUSTOMER["客户"]');
    expect(aliasTextOf(s, "CUSTOMER")).toBe("客户");
  });

  it('不带引号别名 `CUSTOMER[客户]` → 也剥出 客户', () => {
    const s = er("CUSTOMER[客户]");
    expect(aliasTextOf(s, "CUSTOMER")).toBe("客户");
  });

  it("还没有别名 → 摆名字本身（用户输入的新文字就是第一个显示名）", () => {
    const s = er("CUSTOMER");
    expect(aliasTextOf(s, "CUSTOMER")).toBe("CUSTOMER");
  });

  it("名字与别名两条路互不污染：剥出来的那段不含方括号", () => {
    const s = er('ORDER["订单 主表"]');
    const text = aliasTextOf(s, "ORDER");
    expect(text).toBe("订单 主表");
    expect(text.includes("[")).toBe(false);
  });
});

/**
 * 159 片 3：同一段文字出现在多处时的「第 k 个元素 ↔ 第 k 个区间」配对。
 * 两条自证缺一不可：数量相等、**逐对文字相同** —— 后者专防"mermaid 换了渲染顺序"，
 * 顺序一乱就整组退回不给改，而不是把改动写到别的那一处上。
 */
describe("159③：多处同文的配对", () => {
  const src = "sequenceDiagram\n  甲->>乙: 重复\n  乙->>甲: 重复";
  const pool = findTextSpans(src, "重复");

  it("夹具：源码里正好两处", () => {
    expect(pool.length).toBe(2);
  });

  it("数量相等且逐对文字相同 → 一一对上（第二处给第二个区间）", () => {
    const 配 = pairSpansByOrder(["重复", "重复"], pool);
    expect(配.length).toBe(2);
    expect(配[0]).toBe(pool[0]);
    expect(配[1]).toBe(pool[1]);
    expect(src.slice(配[1]!.from, 配[1]!.to)).toBe("重复");
    expect(pool[0].from, "两处区间不是同一个").not.toBe(pool[1].from);
  });

  it("数量不等 → 整组 null（宁可少认，不可错认）", () => {
    expect(pairSpansByOrder(["重复"], pool)).toEqual([null]);
    expect(pairSpansByOrder(["重复", "重复", "重复"], pool)).toEqual([null, null, null]);
    expect(pairSpansByOrder([], [])).toEqual([]);
  });

  it("顺序被打乱（逐对文字对不上）→ 整组 null，不写错地方", () => {
    const 乱 = [pool[1], pool[0]];
    const texts = ["甲说的那句", "重复"];
    const 假 = [
      { ...pool[1], text: "重复" },
      { ...pool[0], text: "甲说的那句" },
    ];
    expect(pairSpansByOrder(texts, 假)).toEqual([null, null]);
    expect(乱.length).toBe(2);
  });
});
