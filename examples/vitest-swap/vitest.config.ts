import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A cold run fetches fork state over the network; a replayed one takes a few seconds.
    testTimeout: 60_000,
  },
});
