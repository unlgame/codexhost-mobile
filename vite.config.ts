import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { viteDevServerConfig } from "./server/dev-mode.js";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: viteDevServerConfig,
  build: {
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    // dist/ 和 npm-dist/ 是构建产物：里面会有编译出来的 *.test.js，
    // 不加排除的话 vitest 会把同一批测试当源码和产物各跑一遍
    //（数字虚高，而且改测试时容易只改一边）。
    exclude: [
      "tests/e2e/**",
      "node_modules/**",
      "dist/**",
      "npm-dist/**",
    ],
  },
});
