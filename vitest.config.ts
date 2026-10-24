import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    env: { DATABASE_URL: "file:./test.db" },
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
  },
});
