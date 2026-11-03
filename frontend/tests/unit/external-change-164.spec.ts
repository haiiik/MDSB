import { expect, it } from "vitest";
import { 变了之后怎么办, 指纹变了吗 } from "../../src/kernel/externalChange";

/**
 * 164（要求：「新增文件自动刷新功能，应对其他工具改了文件」）。
 *
 * 这两步判断是整颗功能的全部口径，钉死在这里；
 * "什么时候去问、问完界面上长什么样"由 E2E 与真壳判据量（那边跑的是真的 2 秒轮询）。
 *
 * 为什么分两步：`stat` 的指纹变了 ≠ 内容变了。少了第二步，
 * 别的工具把同样的字节重写一遍（格式化器、git checkout、云盘同步）就会弹一次假提示，
 * 而我们自己 `Ctrl+S` 之后 mtime 必然变 —— 第二步顺带把这条自激挡掉，
 * 不用在保存链路上再挂一个"别忘了更新基准"的钩子。
 */

const A = { size: 100, mtime: 1000 };

it("第一步：还没记过基准 → 记一下（刚打开 / 刚切过来 / 未命名档换了路径都走这一支）", () => {
  expect(指纹变了吗(null, A)).toBe("no-baseline");
});

it("第一步：stat 读不到 → 文件没了（被删、改名、盘没挂载）", () => {
  expect(指纹变了吗(A, null)).toBe("unreadable");
  // 没记过基准时"unreadable"不当成"没了"：连是哪一份都对不上，先记下来再说
  expect(指纹变了吗(null, null)).toBe("no-baseline");
});

it("第一步：size 与 mtime 都一样 → 没动（这是绝大多数轮询的答案，必须便宜）", () => {
  expect(指纹变了吗(A, { size: 100, mtime: 1000 })).toBe("unchanged");
});

it("第一步：只有 mtime 变（重写了一样的字节）或只有 size 变（改了字但长度凑巧一样）都算变了", () => {
  expect(指纹变了吗(A, { size: 100, mtime: 2000 })).toBe("changed");
  expect(指纹变了吗(A, { size: 101, mtime: 1000 })).toBe("changed");
});

it("第二步：盘上内容与我们以为落盘的那份逐字节相同 → 什么都不做（不弹提示、不重载）", () => {
  expect(变了之后怎么办("# 一样\n", "# 一样\n", false)).toBe("identical");
  // 脏不脏都不弹：改的是"我们没保存的编辑"，与盘上那份是不是新的无关
  expect(变了之后怎么办("# 一样\n", "# 一样\n", true)).toBe("identical");
});

it("第二步：内容真的变了，且没有未保存编辑 → 静默重载", () => {
  expect(变了之后怎么办("# 别的工具改的\n", "# 我们打开时的\n", false)).toBe("reload");
});

it("第二步：内容变了而这一篇有未保存编辑 → 问一声（**绝不静默盖掉没保存的东西**）", () => {
  expect(变了之后怎么办("# 别的工具改的\n", "# 我们打开时的\n", true)).toBe("ask");
});

it("第二步：指纹变了但这份已经读不到了 → 交给调用方按「没了」提示", () => {
  expect(变了之后怎么办(null, "# 任何", true)).toBe("unreadable");
  expect(变了之后怎么办(null, "# 任何", false)).toBe("unreadable");
});
