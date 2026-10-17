import { parseMd, serializeMd } from "./md";

/**
 * round-trip 接缝：`md 文本 → mdast → md 文本`。
 *
 * 这是 spec §5.1 点名的最高风险面 —— 序列化不忠实会**静默损坏用户文档**。
 * 夹具台（tests/unit/roundtrip.spec.ts）逐条比对，M2 的每次块级改动都收敛到这里验证。
 */

export type Doc = ReturnType<typeof parseMd>;

export function parse(md: string): Doc {
  return parseMd(md);
}

export function serialize(doc: Doc): string {
  return serializeMd(doc);
}

/** 一次往返：parse -> serialize */
export function roundTrip(md: string): string {
  return serialize(parse(md));
}
