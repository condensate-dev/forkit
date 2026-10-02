import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ForkitError } from "../errors.ts";

/** alto (`@pimlico/alto`) is not installed where forkit or the project can resolve it. */
export class AltoNotFoundError extends ForkitError {
  override name = "AltoNotFoundError";

  constructor(detail: string, cause?: unknown) {
    super(
      [
        `forkit: ${detail}`,
        "@condensate_dev/forkit/4337 runs Pimlico's alto bundler, an optional peer dependency. Install it with:",
        "  npm i -D @pimlico/alto   (or bun add -d / pnpm add -D / yarn add -D)",
        "or pass altoBinary: the path to alto's CLI (…/@pimlico/alto/esm/cli/alto.js) or an alto executable.",
      ].join("\n"),
      cause === undefined ? undefined : { cause },
    );
  }
}

/** The bundler could not start, or does not serve what was asked for. */
export class BundlerBootError extends ForkitError {
  override name = "BundlerBootError";
}

/** How to launch alto: a command and the arguments before alto's own flags. */
export interface AltoCommand {
  command: string;
  args: string[];
}

/** Node for running alto's CLI: this process when it is Node, else `node` from PATH (bun, deno). */
function nodeBinary(): string {
  return process.versions.bun === undefined && process.versions.node !== undefined
    ? process.execPath
    : "node";
}

/**
 * Find alto. An explicit `altoBinary` wins: a `.js`/`.mjs` path runs under Node, anything else
 * runs as an executable. Otherwise `@pimlico/alto` is resolved from forkit, then from the working
 * directory's project, and its CLI (`esm/cli/alto.js`, the package's `bin`) runs under Node.
 */
export function resolveAlto(altoBinary?: string): AltoCommand {
  if (altoBinary !== undefined) {
    return /\.m?js$/.test(altoBinary)
      ? { command: nodeBinary(), args: [altoBinary] }
      : { command: altoBinary, args: [] };
  }
  const bases = [import.meta.url, pathToFileURL(join(process.cwd(), "package.json")).href];
  let lastError: unknown;
  for (const base of bases) {
    let entry: string;
    try {
      entry = createRequire(base).resolve("@pimlico/alto");
    } catch (error) {
      lastError = error;
      continue;
    }
    // The package entry is esm/index.js; its bin is esm/cli/alto.js.
    const cli = join(dirname(entry), "cli", "alto.js");
    if (!existsSync(cli)) {
      throw new AltoNotFoundError(
        `found @pimlico/alto at ${entry}, but not its CLI at ${cli}. This alto layout is not one forkit knows.`,
      );
    }
    return { command: nodeBinary(), args: [cli] };
  }
  throw new AltoNotFoundError("could not resolve @pimlico/alto.", lastError);
}

/** A flag value: arrays are comma-joined, booleans are written out (`--safe-mode false`). */
export type AltoFlagValue = string | number | boolean | readonly string[];

/**
 * Render alto flags. Keys are alto's own kebab-case flag names without the dashes, as listed by
 * `alto --help` (e.g. `"rpc-url"`, `"safe-mode"`); `undefined` values are skipped.
 */
export function renderAltoFlags(
  flags: Readonly<Record<string, AltoFlagValue | undefined>>,
): string[] {
  return Object.entries(flags).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) {
      throw new ForkitError(
        `forkit: alto flag ${JSON.stringify(key)} is not a kebab-case flag name (write "rpc-url", not "--rpc-url" or "rpcUrl").`,
      );
    }
    const rendered = Array.isArray(value) ? value.join(",") : String(value);
    return [`--${key}`, rendered];
  });
}

/** A running alto process, with its recent output kept for error messages. */
export interface AltoProcess {
  readonly child: ChildProcess;
  /** The last lines alto printed (stdout and stderr), oldest first. */
  output(): string;
  /** Resolves with the exit code (or signal) once the process is gone. */
  readonly exited: Promise<string>;
  /** SIGTERM, then SIGKILL after `timeoutMs`. Idempotent; never rejects. */
  stop(timeoutMs: number): Promise<void>;
}

const KEPT_LINES = 200;

/** Start alto. Output goes to `onLine` as it arrives and is kept for {@link AltoProcess.output}. */
export function spawnAlto(
  alto: AltoCommand,
  flags: readonly string[],
  onLine: (line: string) => void,
): AltoProcess {
  const child = spawn(alto.command, [...alto.args, ...flags], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const lines: string[] = [];
  const take = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      lines.push(line);
      if (lines.length > KEPT_LINES) lines.shift();
      onLine(line);
    }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);

  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => {
      lines.push(`forkit: could not start ${alto.command}: ${error.message}`);
      resolve(`spawn error: ${error.message}`);
    });
    child.once("exit", (code, signal) => resolve(signal ?? `exit code ${code}`));
  });

  // Never leave an alto behind if the test process exits without stopping it.
  const killOnExit = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  process.once("exit", killOnExit);

  let stopping: Promise<void> | undefined;
  return {
    child,
    output: () => lines.join("\n"),
    exited,
    stop(timeoutMs: number) {
      stopping ??= (async () => {
        process.removeListener("exit", killOnExit);
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const outcome = await Promise.race([exited, timedOut]).finally(() => clearTimeout(timer));
        if (outcome === "timeout") {
          killOnExit();
          await exited;
        }
      })();
      return stopping;
    },
  };
}
