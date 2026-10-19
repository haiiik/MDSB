import { existsSync, readdirSync, rmSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import wails from "@wailsio/runtime/plugins/vite";

/**
 * 138：把 KaTeX 字体里**重复的旧格式**从构建产物里摘掉。
 *
 * 事实（本机实测，`katex@0.16.47`）：dist/fonts 里 20 个家族各发三种格式 ——
 * woff2 共 296KB、woff 与 ttf 合计 876KB。同一批字形发三份，我们这儿有两份永远用不上：
 * 交付面只有 WebView2（Chromium 分支，woff2 自 2015 年起就支持），
 * 而 KaTeX 的 `src` 列表把 woff2 排在最前，浏览器取到就不再看后面的。
 * 这 876KB 是**嵌进 exe 的**（`go:embed all:frontend/dist`），安装包跟着一起胖。
 *
 * **不是一刀切删扩展名**：只有「同一个家族名确实有 .woff2」时才删它的 .woff/.ttf。
 * 哪天 KaTeX 少发了某个 woff2，这里就自动留下那份兜底的，不会静默掉字形 ——
 * 而真壳里的判据在 `hp-desktop-verify.mjs` 第 17 段：`document.fonts.check("1em KaTeX_Main")`
 * 加上「块级分数必须明显高于一行正文」，字体没到就红，不会让这 876KB 的便宜白占。
 */
function pruneLegacyFontFormats(outDir: string): Plugin {
  return {
    name: "hp-prune-legacy-font-formats",
    apply: "build",
    closeBundle() {
      const dir = outDir + "/assets";
      if (!existsSync(dir)) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return; // 读不动就当没这回事：构建不该因为清理失败而失败
      }
      const modern = new Set(
        names.filter((f) => f.endsWith(".woff2")).map((f) => familyOf(f))
      );
      let freed = 0;
      for (const f of names) {
        if (!/\.(woff|ttf)$/.test(f)) continue;
        if (!modern.has(familyOf(f))) continue; // 没有对应 woff2 的家族，旧的留着
        try {
          rmSync(`${dir}/${f}`);
          freed++;
        } catch {
          /* 被占用就跳过，不影响构建 */
        }
      }
      if (freed) console.log(`[hp] 构建产物里清掉 ${freed} 个重复格式的旧字体（woff/ttf），woff2 全留着`);
    },
  };
}

/**
 * Vite 落出来的名字是 `KaTeX_<家族>-<变体>-<hash>.<ext>`，**hash 里也可能带 `-`**
 * （本机实测：`KaTeX_Caligraphic-Regular-CTRA-rTL.woff`）。
 * 所以不能"砍掉最后一个 `-` 段"当家族名 —— 第一版那么写，40 个里只清掉 31 个。
 * 第二版用 `[A-Za-z]+` 又漏了带数字的 `KaTeX_Size1/2/3/4`（8 个没清掉），
 * 家族段必须允许数字。按 `KaTeX_词-词` 这两段取才是稳的。
 */
function familyOf(name: string): string {
  const m = /^(KaTeX_[A-Za-z0-9]+-[A-Za-z0-9]+)/.exec(name);
  return m ? m[1] : name.replace(/\.[a-z0-9]+$/i, "");
}

// base: './' —— Wails 内嵌资源以相对路径提供，打包后 index.html 才能取到 assets
export default defineConfig({
  plugins: [vue(), wails("./bindings"), pruneLegacyFontFormats("dist")],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
