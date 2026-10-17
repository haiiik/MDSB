import { defineConfig } from "vitest/config";

// 重新钉住期望值：跑 scripts 下的 *.pin.ts，会改写 tests/fixtures 里的 .roundtrip.md
export default defineConfig({
  test: {
    include: ["scripts/**/*.pin.ts"],
    environment: "node",
  },
});
