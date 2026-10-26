import { describe, expect, it } from "vitest";

import {
  applyAliasSet,
  applyIdentifierRename,
  scanIdentifierOccurrences,
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
