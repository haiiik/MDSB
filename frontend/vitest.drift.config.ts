import { defineConfig } from "vitest/config";

/** 漂移报告专用配置：跑 scripts/ 下的诊断脚本，不混进 pnpm test */
export default defineConfig({
  test: {
    include: ["scripts/**/*.report.ts"],
    environment: "node",
  },
});
