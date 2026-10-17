/**
 * GitHub-install smoke test: `bun run test:github-install`. forkit is not on npm; users pin a
 * commit. This installs that pin with pnpm into a fresh project, outside this workspace, and
 * imports the EVM entry and the Solana entry from node_modules with plain Node:
 *
 *   pnpm add "github:condensate-dev/forkit#<sha>&path:/packages/forkit" @solana/kit viem
 *
 * The package lives in packages/forkit, hence `&path:`. Nothing is built on install (dist/ is
 * committed), so pnpm needs no `allowBuilds` entry for it.
 *
 * The pin is FORKIT_INSTALL_SPEC if set (e.g. a `git+file://` URL for a local check), else
 * `github:condensate-dev/forkit#<FORKIT_INSTALL_SHA or HEAD>&path:/packages/forkit`; the commit
 * must be pushed. Needs pnpm and network access.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

function sh(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} (in ${cwd}) exited with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const sha = process.env.FORKIT_INSTALL_SHA || sh("git", ["rev-parse", "HEAD"], PKG).trim();
const spec =
  process.env.FORKIT_INSTALL_SPEC || `github:condensate-dev/forkit#${sha}&path:/packages/forkit`;

const app = mkdtempSync(join(tmpdir(), "forkit-github-install-"));
try {
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({ name: "forkit-github-install", private: true, type: "module" }, null, 2)}\n`,
  );
  console.log(`pnpm add ${spec}`);
  const kit = manifest.devDependencies["@solana/kit"];
  const viem = manifest.dependencies.viem;
  if (kit === undefined || viem === undefined)
    throw new Error("package.json lost @solana/kit or viem");
  sh("pnpm", ["add", spec, `@solana/kit@${kit}`, `viem@${viem}`], app);

  const installed = join(app, "node_modules/@condensate/forkit");
  for (const file of ["dist/index.js", "dist/svm/index.js", "dist/svm/index.d.ts"]) {
    if (!existsSync(join(installed, file))) throw new Error(`the installed package has no ${file}`);
  }

  // Plain Node, as a user's script or node:test would load it.
  writeFileSync(
    join(app, "check.mjs"),
    `import * as evm from "@condensate/forkit";
import * as svm from "@condensate/forkit/svm";
const missing = [];
for (const [name, mod, key] of [["@condensate/forkit", evm, "fork"], ["@condensate/forkit", evm, "assertAnvilInstalled"], ["@condensate/forkit/svm", svm, "surfnet"], ["@condensate/forkit/svm", svm, "createSurfnetAdapter"]]) {
  if (typeof mod[key] !== "function") missing.push(name + " " + key);
}
if (typeof svm.SURFPOOL_VERSION !== "string") missing.push("@condensate/forkit/svm SURFPOOL_VERSION");
if (missing.length > 0) { console.error("missing exports: " + missing.join(", ")); process.exit(1); }
console.log("imported @condensate/forkit and @condensate/forkit/svm (surfpool " + svm.SURFPOOL_VERSION + ")");
`,
  );
  process.stdout.write(sh("node", ["check.mjs"], app));
  console.log("✓ github install");
} finally {
  rmSync(app, { recursive: true, force: true });
}
