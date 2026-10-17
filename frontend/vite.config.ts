import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import wails from "@wailsio/runtime/plugins/vite";

// base: './' —— Wails 内嵌资源以相对路径提供，打包后 index.html 才能取到 assets
export default defineConfig({
  plugins: [vue(), wails("./bindings")],
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
