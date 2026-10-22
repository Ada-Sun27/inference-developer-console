import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    // Integration tests share one database, so run files one at a time.
    fileParallelism: false,
  },
});
