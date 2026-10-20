import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./vitest.integration.setup.ts"],
    // Integration tests share one real Postgres; run files sequentially so
    // concurrent test files don't race on overlapping cleanup.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
