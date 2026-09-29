import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The child run of ../reporter.vitest.ts: the fixture suite, the forkit setup file and reporter.
export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    include: ["test/anvil/reporter/suite.fixture.ts"],
    setupFiles: ["./src/reporter/setup.ts"],
    reporters: ["default", "./src/reporter/index.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
