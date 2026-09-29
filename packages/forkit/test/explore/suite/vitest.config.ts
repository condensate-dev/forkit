// The small fork suite test/anvil/explore-record.vitest.ts runs with FORKIT_RECORD=1. Two files,
// so two workers record into one run.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.suite.ts"],
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
