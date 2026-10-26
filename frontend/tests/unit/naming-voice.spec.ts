import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 闸门：称呼口径（2026-10-26 定）。
 *
 * **仓库里（会被公开出去的）不许用那个第三人称指需求方**：
 * 源码注释、测试注释、安装脚本、公开文档一律写成无人称的客观陈述
 * （「已定口径」「要求：」「肉眼看到」「待确认」），
 * 需要指到人时写昵称 `xuange`，且只出现在不入库的地方（工单、内部文档、桌面脚本、记忆）。
 *
 * 为什么要有这道闸：这个字**不会自己消失** —— 全仓 371 处是一次脚本改完的，
 * 但以后每次写注释都可能顺手再来一个；等下次再清就是第二次全仓扫。
 * 口径写在工单里没人读，写在闸里才会红。
 *
 * **禁字刻意用 \u 转义而不是字面汉字**（同 i18n 那道闸的教训：字面汉字写的范围
 * 会被工具链吞掉一截，且判据坏了不报错）。所以「判据的判据」那条 it 用
 * `String.fromCharCode` 现搭一个字面串过一遍扫描器 —— 转义写坏了它先红。
 */
const BANNED = "\u5979";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/** 扫这些目录（仓库根的相对路径）；不入库的本机目录只挑有注释意义的 */
const DIRS = [
  "frontend/src",
  "frontend/tests",
  "frontend/bindings",
  "frontend/scripts",
  "internal",
  "build/windows",
  "assets",
  "docs",
  "samples",
];

/** 仓库根上的散文件（*.go / *.nsi / *.md / 配置） */
const ROOT_FILES = () =>
  fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(go|md|nsi|json|yaml|yml|txt|ps1)$/i.test(e.name))
    .map((e) => e.name);

const SKIP_DIR = new Set(["node_modules", "dist", "bin", "screenshots", ".git", "uploads"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|vue|css|scss|go|nsi|md|json|html|yaml|yml|txt|ps1|ini)$/i;

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** 把一棵目录摊平成「文本文件」清单 */
function listFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      listFiles(path.join(dir, e.name), acc);
    } else if (TEXT_EXT.test(e.name)) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/** 找出文件里的禁字；行号 1 基 */
function scan(file: string, needle = BANNED): Hit[] {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(needle)) return [];
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    let from = line.indexOf(needle);
    while (from >= 0) {
      hits.push({ file: path.relative(ROOT, file).replace(/\\/g, "/"), line: i + 1, text: line.trim().slice(0, 120) });
      from = line.indexOf(needle, from + needle.length);
    }
  });
  return hits;
}

function scanAll(): Hit[] {
  const files: string[] = [];
  for (const d of DIRS) files.push(...listFiles(path.join(ROOT, d)));
  for (const f of ROOT_FILES()) files.push(path.join(ROOT, f));
  return files.flatMap((f) => scan(f));
}

it("仓库里不出现那个第三人称（称呼口径：入库的一律无人称，要指人写 xuange）", () => {
  const bad = scanAll();
  expect(
    bad.map((h) => `${h.file}:${h.line}  ${h.text}`).slice(0, 40),
    `这些行还在用第三人称指需求方。改法：陈述口径就删主语（「已定口径：…」「要求：…」），` +
      `确实要点名到人，就写到不入库的工单里（入库文件里写 xuange 也别用那个第三人称字）。\n` +
      `共 ${bad.length} 处${bad.length > 40 ? "（只列前 40）" : ""}：\n`,
  ).toEqual([]);
});

it("判据的判据：扫描器真能抓到那个字（转义写坏了这条先红）", () => {
  const 禁字 = String.fromCharCode(0x5979);
  expect(BANNED, "BANNED 的转义必须正好是那个字").toBe(禁字);

  // 拿一个临时文件正面喂给扫描器：判据坏了（转义写错、行号算错）这里先红，
  // 而不是等下一次真有人写进仓库才发现「全绿而什么都没守」。
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdstar-naming-")), "样本.ts");
  const 内容 = `// 199：${禁字}说「这里要一颗按钮」\nexport const a = 1;\n// 再来一处：${禁字}的口径\n`;
  fs.writeFileSync(tmp, 内容, "utf8");
  try {
    const 命中 = scan(tmp);
    expect(命中.length, "两处禁字都要抓到").toBe(2);
    expect(命中.map((h) => h.line), "行号要指到真正那两行").toEqual([1, 3]);
    expect(命中[0].text).toContain(禁字);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }

  // 反面：仓库里的真实文件现在必须是干净的（这条红了就是有人新写进去了）
  expect(scanAll().map((h) => `${h.file}:${h.line}`), "仓库里不该再有这个字").toEqual([]);
});

