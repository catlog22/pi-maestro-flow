import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    alias: {
      "node:test": resolve(__dirname, "test/shims/node-test.ts"),
      "node:assert/strict": resolve(__dirname, "test/shims/node-assert.ts"),
    },
  },
});
