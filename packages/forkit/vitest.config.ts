import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // No anvil, no network.
        test: { name: "unit", include: ["test/vitest.smoke.ts", "test/unit/**/*.vitest.ts"] },
      },
      {
        // Needs anvil on PATH; forks a local anvil, so no network. Each test boots a fresh upstream
        // with its own genesis, so "block 0" differs run to run: never record it. The cache tests
        // pass `cache` explicitly, which wins over the env.
        test: {
          name: "anvil",
          env: { FORKIT_CACHE: "off" },
          include: ["test/anvil/**/*.vitest.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Needs anvil and a real RPC (public by default; override with FORKIT_RPC_URL_<chainId>).
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.vitest.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
