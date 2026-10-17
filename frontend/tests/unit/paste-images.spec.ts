import { describe, expect, it } from "vitest";
import {
  ASSETS_DIR,
  imageExt,
  imageStamp,
  planImage,
  sha256Hex,
} from "../../src/kernel/paste/images";

/**
 * 116：剪贴板图片落盘的**纯规则**层。
 *
 * 命名、序号、去重这三件事一定要用可控的时钟与可控的「已存在集合」来测：
 * 放进真文件系统里测，就变成了「看这一秒运气红不红」。
 * 真的写盘在 Go（`internal/service/file_service_test.go`）与 host 层，插进文档在 E2E。
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0b]); // 只差一个字节

const at = (s: string) => new Date(s);
const fixed = at("2026-10-15T09:30:12");

describe("扩展名与时间戳", () => {
  it("认识的 mime 都给扩展名，jpeg 统一成 jpg", () => {
    expect(imageExt("image/png")).toBe("png");
    expect(imageExt("image/jpeg")).toBe("jpg");
    expect(imageExt("IMAGE/GIF")).toBe("gif");
    expect(imageExt("image/webp")).toBe("webp");
  });

  it("mime 缺失时按文件名兜底（剪贴板里的截图常常只给名字）", () => {
    expect(imageExt("", "屏幕快照 2026-10-15.png")).toBe("png");
    expect(imageExt("application/octet-stream", "a.JPG")).toBe("jpg");
  });

  it("不是图片就返回 null —— 宁可不写，也不要造一个打不开的引用", () => {
    expect(imageExt("text/plain", "a.txt")).toBeNull();
    expect(imageExt("", "")).toBeNull();
  });

  it("时间戳是本地历法的 YYYYMMDD-HHMMSS", () => {
    expect(imageStamp(fixed)).toBe("20261015-093012");
    expect(imageStamp(at("2026-01-09T07:05:03"))).toBe("20260109-070503");
  });
});

describe("内容哈希", () => {
  it("同样的字节得到同样的 hash，改一个字节就不一样", async () => {
    expect(await sha256Hex(PNG)).toBe(await sha256Hex(new Uint8Array(PNG)));
    expect(await sha256Hex(PNG)).not.toBe(await sha256Hex(PNG2));
    expect(await sha256Hex(PNG)).toHaveLength(16);
  });
});

describe("落点规划（命名 / 序号 / 去重）", () => {
  /** 假文件系统：给一组「已经存在的路径」，其余都能写 */
  const mk = (existing: Iterable<string>) => {
    const set = new Set(existing);
    return {
      exists: async (rel: string) => set.has(rel),
      add: (rel: string) => set.add(rel),
      list: () => [...set],
    };
  };

  it("新图 → assets/<时间戳>-1.png", async () => {
    const fs = mk([]);
    const plan = await planImage({
      ext: "png",
      hash: "aa",
      now: fixed,
      known: new Map(),
      exists: fs.exists,
    });
    expect(plan).toEqual({ relPath: `${ASSETS_DIR}/20261015-093012-1.png`, reused: false });
  });

  it("同一秒连续两张不同的图 → 序号是 -1、-2，谁也不覆盖谁", async () => {
    const fs = mk([]);
    const first = await planImage({ ext: "png", hash: "aa", now: fixed, known: new Map(), exists: fs.exists });
    fs.add(first.relPath);
    const second = await planImage({ ext: "png", hash: "bb", now: fixed, known: new Map(), exists: fs.exists });
    expect(second.relPath).toBe(`${ASSETS_DIR}/20261015-093012-2.png`);
    fs.add(second.relPath);
    expect(new Set(fs.list())).toHaveLength(2); // 两个不同的文件，谁也没被覆盖
  });

  it("同一张图（hash 命中且文件还在）→ 复用旧路径，不新增文件", async () => {
    const rel = `${ASSETS_DIR}/20261015-093000-1.png`;
    const fs = mk([rel]);
    const plan = await planImage({
      ext: "png",
      hash: "aa",
      now: at("2026-10-15T09:31:00"), // 过了一分钟也照样复用，不看时间只看字节
      known: new Map([["aa", rel]]),
      exists: fs.exists,
    });
    expect(plan).toEqual({ relPath: rel, reused: true });
    expect(fs.list()).toHaveLength(1);
  });

  it("索引里有记录但文件已被用户删掉 → 当新图重落一份，绝不留指向空气的引用", async () => {
    const gone = `${ASSETS_DIR}/20261015-090000-1.png`;
    const fs = mk([]);
    const plan = await planImage({
      ext: "png",
      hash: "aa",
      now: fixed,
      known: new Map([["aa", gone]]),
      exists: fs.exists,
    });
    expect(plan.reused).toBe(false);
    expect(plan.relPath).toBe(`${ASSETS_DIR}/20261015-093012-1.png`);
  });

  it("同一秒的第 3 号位已被占用（用户自己往 assets 里放了同名图）→ 顺延到 -4", async () => {
    const stamp = "20261015-093012";
    const fs = mk([`${ASSETS_DIR}/${stamp}-1.png`, `${ASSETS_DIR}/${stamp}-2.png`, `${ASSETS_DIR}/${stamp}-3.png`]);
    const plan = await planImage({ ext: "png", hash: "zz", now: fixed, known: new Map(), exists: fs.exists });
    expect(plan.relPath).toBe(`${ASSETS_DIR}/${stamp}-4.png`);
  });

  it("序号被占满 999 个 → 抛错停手，不写重复引用", async () => {
    const stamp = "20261015-093012";
    const full = Array.from({ length: 999 }, (_, i) => `${ASSETS_DIR}/${stamp}-${i + 1}.png`);
    const fs = mk(full);
    await expect(
      planImage({ ext: "png", hash: "aa", now: fixed, known: new Map(), exists: fs.exists })
    ).rejects.toThrow(/999/);
  });
});

describe("文档还没保存过时拒绝落盘（Q3 默认做法）", () => {
  it("活动标签没有路径 → 抛「先保存」，而且是在动宿主之前抛（不留下半张图）", async () => {
    const { tabs } = await import("../../src/state/documents");
    const { savePastedImage } = await import("../../src/state/images");
    tabs.list = [];
    tabs.activeId = null;
    const file = new File([PNG], "截图.png", { type: "image/png" });
    await expect(savePastedImage(file)).rejects.toThrow(/还没有保存过/);
  });
});
