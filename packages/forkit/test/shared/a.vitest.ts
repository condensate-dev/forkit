import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foundry } from "viem/chains";
import { expect, test } from "vitest";
import { attachSharedFork, SHARED_FORKS_ENV } from "../../src/index.ts";
import { sharedContract } from "./contract.ts";

sharedContract("a", "7");

test("a bad option throws before the shared fork's lease is taken", async () => {
  await expect(attachSharedFork({ chain: foundry, traces: "sometimes" as "off" })).rejects.toThrow(
    /traces must be/,
  );
  // Another file may hold the lease right now; it just must not be this process.
  const { dir } = JSON.parse(process.env[SHARED_FORKS_ENV] ?? "{}") as { dir: string };
  const owner = join(dir, "lease", "owner");
  expect(existsSync(owner) ? readFileSync(owner, "utf8") : "").not.toBe(String(process.pid));
});
