/**
 * Packed-install smoke test: `bun run test:pack`. What `npm install @condensate_dev/forkit` gets, run
 * the way a user runs it, outside this workspace:
 *
 * 1. `npm pack` (prepack builds dist/) and install the tarball into a fresh temp project, with
 *    the runners at the versions this repo tests.
 * 2. Every runner imports forkit from node_modules: node:test and jest load it with plain Node
 *    (which refuses to strip TypeScript under node_modules), vitest and bun:test through their
 *    own loaders. Each checks the main entry and its own adapter.
 * 3. Every subpath export resolves, and a TypeScript consumer typechecks against the published
 *    declarations (moduleResolution nodenext, strict).
 * 4. The `forkit` bin starts `forkit explore` over a run record and serves the explorer UI.
 *
 * Needs network access for npm. No anvil: nothing here boots a fork.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  devDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};
// The workspace root's TypeScript: the version this repo typechecks with.
const TSC = join(PKG, "../../node_modules/.bin/tsc");
const FIXTURE = join(PKG, "test/fixtures/explore/showcase.json");

function sh(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} (in ${cwd}) exited with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const work = mkdtempSync(join(tmpdir(), "forkit-pack-"));
const app = join(work, "app");
const failures: string[] = [];
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`✗ ${name}\n${error instanceof Error ? error.message : String(error)}`);
  }
};

try {
  // 1. Pack and install.
  sh("npm", ["pack", "--pack-destination", work], PKG);
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack wrote no tarball");
  mkdirSync(app);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "forkit-pack-smoke", private: true, type: "module" }),
  );
  const dev = manifest.devDependencies;
  sh(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      join(work, tarball),
      `viem@${manifest.dependencies.viem}`,
      `vitest@${dev.vitest}`,
      `jest@${dev.jest}`,
      `@jest/globals@${dev["@jest/globals"]}`,
      `@types/node@${dev["@types/node"]}`,
    ],
    app,
  );
  const packed = sh("tar", ["-tzf", join(work, tarball)], work);
  check("the tarball ships dist/, the explorer UI and the README", () => {
    for (const path of [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/explore/cli.js",
      "package/dist/explore/ui/index.html",
      "package/README.md",
    ]) {
      if (!packed.includes(path)) throw new Error(`missing ${path}`);
    }
  });

  // 2. Every runner, from node_modules.
  const importsMain =
    'import { fork, expectRevert, label } from "@condensate_dev/forkit";\n' +
    "const main = [fork, expectRevert, label].every((f) => typeof f === 'function');\n";
  writeFileSync(
    join(app, "node.test.js"),
    `${importsMain}import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { describeFork, itFork } from "@condensate_dev/forkit/node";\ntest("imports", () => { assert.ok(main); assert.equal(typeof describeFork, "function"); assert.equal(typeof itFork, "function"); });\n`,
  );
  check("node:test imports forkit and its adapter", () => {
    sh("node", ["--test", "node.test.js"], app);
  });

  writeFileSync(
    join(app, "jest.test.js"),
    `${importsMain}import { expect, test } from "@jest/globals";\nimport { describeFork, itFork } from "@condensate_dev/forkit/jest";\ntest("imports", () => { expect(main).toBe(true); expect(typeof describeFork).toBe("function"); expect(typeof itFork).toBe("function"); });\n`,
  );
  writeFileSync(
    join(app, "jest.config.js"),
    'export default { testEnvironment: "node", transform: {}, testMatch: ["**/jest.test.js"] };\n',
  );
  check("jest imports forkit and its adapter", () => {
    sh("npx", ["jest"], app, { NODE_OPTIONS: "--experimental-vm-modules" });
  });

  writeFileSync(
    join(app, "vitest.test.js"),
    `${importsMain}import { expect, test } from "vitest";\nimport { describeFork, itFork } from "@condensate_dev/forkit/vitest";\ntest("imports", () => { expect(main).toBe(true); expect(typeof describeFork).toBe("function"); expect(typeof itFork).toBe("function"); });\n`,
  );
  check("vitest imports forkit and its adapter", () => {
    sh("npx", ["vitest", "run", "vitest.test.js"], app);
  });

  writeFileSync(
    join(app, "bun.test.js"),
    `${importsMain}import { expect, test } from "bun:test";\nimport { describeFork, itFork } from "@condensate_dev/forkit/bun";\ntest("imports", () => { expect(main).toBe(true); expect(typeof describeFork).toBe("function"); expect(typeof itFork).toBe("function"); });\n`,
  );
  check("bun:test imports forkit and its adapter", () => {
    sh("bun", ["test", "./bun.test.js"], app);
  });

  // 3. Every subpath resolves; the declarations typecheck in a strict nodenext consumer.
  const runnerOnly = new Set(["./vitest", "./bun", "./jest", "./reporter/bun", "./reporter/setup"]);
  const plain = Object.keys(manifest.exports).filter((k) => !runnerOnly.has(k));
  writeFileSync(
    join(app, "subpaths.mjs"),
    plain
      .map((k, i) => `import * as m${i} from "@condensate_dev/forkit${k.slice(1)}";`)
      .join("\n") + `\nconsole.log("${plain.length} subpaths");\n`,
  );
  check(`the plain subpaths load under Node (${plain.join(", ")})`, () => {
    sh("node", ["subpaths.mjs"], app);
  });

  writeFileSync(
    join(app, "consumer.ts"),
    `import type { Address } from "viem";
import { base } from "viem/chains";
import { type Fork, expectBalanceChange, fork, NATIVE } from "@condensate_dev/forkit";
import { describeFork, itFork } from "@condensate_dev/forkit/vitest";
import { bridge } from "@condensate_dev/forkit/bridges";
import { bundler } from "@condensate_dev/forkit/4337";
import { forceApprove, PERMIT2, type SignedPermit, signPermit, testAccount } from "@condensate_dev/forkit/payments";
import { formatRun } from "@condensate_dev/forkit/reporter";
export async function consumer(alice: Address): Promise<bigint> {
  const f: Fork<typeof base> = await fork({ chain: base, blockNumber: 1n });
  await f.dealNative(alice, 1n);
  const block: bigint = await f.client.getBlockNumber();
  await expectBalanceChange(f.client, NATIVE, alice, 0n, async () => {});
  void [describeFork, itFork, bridge, bundler, formatRun];
  await f.stop();
  return block;
}
export async function payments(f: Fork<typeof base>, token: Address): Promise<SignedPermit> {
  const owner = testAccount("alice");
  const { reset }: { reset: boolean } = await forceApprove(f, { token, owner: owner.address, spender: PERMIT2, amount: 1n });
  void reset;
  return signPermit(f.client, { token, owner, spender: PERMIT2, value: 1n, deadline: 1n });
}
`,
  );
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }),
  );
  check("a strict nodenext TypeScript consumer typechecks against dist/*.d.ts", () => {
    sh(TSC, ["-p", "tsconfig.json"], app);
  });

  // 4. The bin serves the explorer.
  check("npx forkit explore serves the UI from the installed package", () => {
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const child = spawn("npx", ["forkit", "explore", FIXTURE, "--port", String(port)], {
      cwd: app,
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 30_000;
      let html = "";
      while (Date.now() < deadline && !html.includes("<html")) {
        const r = spawnSync("curl", ["-sf", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
        html = r.stdout ?? "";
        if (!html.includes("<html")) spawnSync("sleep", ["0.5"]);
      }
      if (!html.includes("<html")) throw new Error("forkit explore did not serve its UI in 30 s");
    } finally {
      child.kill();
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} packed-install check(s) failed.`);
  process.exit(1);
}
console.log("\npacked install: every check passed.");
