import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { ForkitReporter } from "../../src/reporter/index.ts";

// site/tools/build-assets.ts: the Base → Arbitrum Across e2e, replayed offline, with forkit's
// reporter. An offline replay cannot read decimals() or symbol(), so name and scale USDC here.
// USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
const USDC = { symbol: "USDC", decimals: 6 };

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["test/e2e/base-arbitrum-across.vitest.ts"],
    setupFiles: ["./src/reporter/setup.ts"],
    reporters: [
      "default",
      new ForkitReporter({
        tokens: {
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": USDC, // Base
          "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": USDC, // Arbitrum One
        },
      }),
    ],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
