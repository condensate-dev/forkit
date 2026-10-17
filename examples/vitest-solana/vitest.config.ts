import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every first read of an account goes to the fork source over the network.
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});
