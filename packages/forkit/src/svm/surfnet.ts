/**
 * The surfnet lifecycle: boot `surfpool start` headless on free ports, forked from an RPC (or
 * offline), wait until its startup reports ready, and stop it with a ceiling.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import { freePort } from "../anvil.ts";
import { ForkitError } from "../errors.ts";
import { redactUrl } from "../rpc.ts";
import { createCheats, type SurfnetCheats } from "./cheats.ts";
import { SurfnetBootError } from "./errors.ts";
import { jsonRpc } from "./rpc.ts";
import { assertSurfpoolInstalled, resolveSurfpoolBinary } from "./surfpool.ts";

/** Solana's public mainnet-beta RPC: the fork source when nothing else is configured. */
export const DEFAULT_SVM_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_SURFNET_BOOT_TIMEOUT_MS = 60_000;
export const DEFAULT_SURFNET_STOP_TIMEOUT_MS = 10_000;

export interface SurfnetOptions {
  /**
   * The RPC to fork from. Accounts are fetched from it on demand, the first time the surfnet
   * reads them, at that RPC's current state. Default: `FORKIT_SVM_RPC_URL`, else Solana's public
   * mainnet-beta RPC (rate limited; use your own for anything but a quick try).
   */
  rpcUrl?: string;
  /** Run with no fork source at all (`surfpool start --offline`). `rpcUrl` must be unset. */
  offline?: boolean;
  /** The surfpool binary. Default: `FORKIT_SURFPOOL_BIN`, else `surfpool` on PATH. */
  surfpoolBinary?: string;
  /** Slot time in milliseconds (`--slot-time`). surfpool's default is 400. */
  slotTimeMs?: number;
  /** Extra `surfpool start` flags, appended after forkit's own. */
  args?: readonly string[];
  /** Ceiling for boot until ready. Default 60 s. */
  bootTimeoutMs?: number;
  /** Ceiling for a graceful stop before the process is killed. Default 10 s. */
  stopTimeoutMs?: number;
}

/** What `surfnet_getSurfnetInfo` reports about startup, as surfpool 1.6 serializes it. */
export interface SurfnetStartupStatus {
  phase: "planning" | "cloningRemoteAccounts" | "executingRunbooks" | "ready" | "failed" | string;
  planSealed: boolean;
  tasks: readonly { task: string; state: string; error: string | null }[];
  error: string | null;
}

export interface SurfnetInfo {
  runbookExecutions: readonly unknown[];
  startup: SurfnetStartupStatus;
}

/** A running surfnet's endpoints, clients and lifecycle; {@link Surfnet} adds the cheatcodes. */
export interface SurfnetBase {
  /** HTTP JSON-RPC endpoint, `http://127.0.0.1:<port>`. */
  readonly rpcUrl: string;
  /** WebSocket endpoint for subscriptions. */
  readonly wsUrl: string;
  /** Where accounts are forked from, with secrets masked; `"offline"` when there is none. */
  readonly source: string;
  /** The surfpool version that is running. */
  readonly surfpoolVersion: string;
  /** A `@solana/kit` RPC client for the standard Solana methods. */
  readonly rpc: Rpc<SolanaRpcApi>;
  /** A `@solana/kit` subscriptions client over {@link Surfnet.wsUrl}. */
  readonly rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** A raw JSON-RPC call, for surfpool's own `surfnet_*` methods. */
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
  /** `surfnet_getSurfnetInfo`: startup phase and runbook executions. */
  info(): Promise<SurfnetInfo>;
  /** Stop surfpool. Idempotent; kills it if it does not exit within `stopTimeoutMs`. */
  stop(): Promise<void>;
}

/** A running surfnet, with its cheatcodes ({@link SurfnetCheats}). */
export interface Surfnet extends SurfnetBase, SurfnetCheats {}

/** The fork source: `"offline"`, the option, `FORKIT_SVM_RPC_URL`, or the public mainnet RPC. */
export function resolveSurfnetSource(
  options: Pick<SurfnetOptions, "rpcUrl" | "offline">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (options.offline === true) {
    if (options.rpcUrl !== undefined) {
      throw new ForkitError(
        "forkit: pass either `rpcUrl` or `offline: true` to surfnet(), not both.",
      );
    }
    return undefined;
  }
  if (options.rpcUrl !== undefined && options.rpcUrl !== "") return options.rpcUrl;
  const fromEnv = env.FORKIT_SVM_RPC_URL;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_SVM_RPC_URL;
}

interface Ports {
  rpc: number;
  ws: number;
  studio: number;
}

/**
 * The `surfpool start` arguments. Exported for tests. Headless (no TUI), no Studio, no project
 * deploys (forkit never reads the user's txtx.yml or Anchor.toml), every listener on a port the
 * OS handed out. The fork URL is not here: it goes in through the environment, so an RPC key
 * never shows in `ps`.
 */
export function surfpoolArgs(
  options: SurfnetOptions,
  ports: Ports,
  logDir: string,
  offline: boolean,
): string[] {
  return [
    "start",
    "--no-tui",
    "--no-studio",
    "--no-deploy",
    "--host",
    "127.0.0.1",
    "--port",
    String(ports.rpc),
    "--ws-port",
    String(ports.ws),
    // Studio is off, but surfpool 1.6 still binds its API server on this port.
    "--studio-port",
    String(ports.studio),
    "--log-path",
    logDir,
    ...(offline ? ["--offline"] : []),
    ...(options.slotTimeMs === undefined ? [] : ["--slot-time", String(options.slotTimeMs)]),
    ...(options.args ?? []),
  ];
}

/** The last bytes surfpool printed, for error messages. ANSI colours stripped. */
class OutputTail {
  static readonly LIMIT = 16_384;
  #text = "";
  push(chunk: Buffer | string): void {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes.
    const clean = String(chunk).replace(/\u001b\[[0-9;]*m/g, "");
    this.#text = (this.#text + clean).slice(-OutputTail.LIMIT);
  }
  toString(): string {
    return this.#text.trim();
  }
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** A test process that exits without stopping its surfnets must not leave surfpool running. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of live) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PORT_IN_USE = /address already in use|os error (48|98)/i;
const BOOT_ATTEMPTS = 3;
const POLL_MS = 100;
const TERM_RETRY_MS = 500;

class Exited extends Error {}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  return signal !== null ? `was killed by ${signal}` : `exited with code ${code}`;
}

class RunningSurfnet implements SurfnetBase {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly source: string;
  readonly surfpoolVersion: string;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  readonly #child: ChildProcess;
  readonly #exited: Promise<void>;
  readonly #stopTimeoutMs: number;
  readonly #workDir: string;
  #stopping: Promise<void> | undefined;

  constructor(init: {
    ports: Ports;
    source: string;
    surfpoolVersion: string;
    child: ChildProcess;
    exited: Promise<void>;
    stopTimeoutMs: number;
    workDir: string;
  }) {
    this.rpcUrl = `http://127.0.0.1:${init.ports.rpc}`;
    this.wsUrl = `ws://127.0.0.1:${init.ports.ws}`;
    this.source = init.source;
    this.surfpoolVersion = init.surfpoolVersion;
    this.rpc = createSolanaRpc(this.rpcUrl);
    this.rpcSubscriptions = createSolanaRpcSubscriptions(this.wsUrl);
    this.#child = init.child;
    this.#exited = init.exited;
    this.#stopTimeoutMs = init.stopTimeoutMs;
    this.#workDir = init.workDir;
  }

  request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    return jsonRpc<T>(this.rpcUrl, method, params);
  }

  async info(): Promise<SurfnetInfo> {
    const response = await this.request<{ value: SurfnetInfo }>("surfnet_getSurfnetInfo");
    return response.value;
  }

  stop(): Promise<void> {
    this.#stopping ??= stopChild(this.#child, this.#exited, this.#stopTimeoutMs).finally(() => {
      rmSync(this.#workDir, { recursive: true, force: true });
    });
    return this.#stopping;
  }
}

/**
 * SIGTERM, repeated, then SIGKILL once `ceilingMs` passes, so a wedged surfpool cannot hang the
 * suite. Why repeated: surfpool 1.6 installs its graceful-shutdown handler late, after its Studio
 * API server (actix) has installed one of its own. A SIGTERM that lands in between only stops
 * that API server and the process keeps running; the next one reaches the real handler.
 */
async function stopChild(child: ChildProcess, exited: Promise<void>, ceilingMs: number) {
  const deadline = Date.now() + ceilingMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(Math.min(TERM_RETRY_MS, deadline - Date.now()))]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(2_000)]);
  }
  live.delete(child);
}

/** One boot attempt on fresh ports. Throws {@link Exited} when surfpool exits during boot. */
async function bootOnce(
  options: SurfnetOptions,
  binary: string,
  surfpoolVersion: string,
  forkUrl: string | undefined,
  deadline: number,
): Promise<{ surfnet: Surfnet; tail: OutputTail }> {
  const ports: Ports = { rpc: await freePort(), ws: await freePort(), studio: await freePort() };
  // surfpool writes logs and state under its working directory: keep that out of the user's repo.
  const workDir = mkdtempSync(join(tmpdir(), "forkit-surfnet-"));
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SURFPOOL_DATASOURCE_RPC_URL;
  if (forkUrl !== undefined) env.SURFPOOL_DATASOURCE_RPC_URL = forkUrl;
  const args = surfpoolArgs(options, ports, join(workDir, "logs"), forkUrl === undefined);
  const child = spawn(binary, args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
  live.add(child);
  installExitHook();
  const tail = new OutputTail();
  child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));
  let exitedWith: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitedWith = exitDescription(code, signal);
      live.delete(child);
      resolve();
    });
    child.once("error", (error) => {
      exitedWith = `could not start: ${error.message}`;
      live.delete(child);
      resolve();
    });
  });
  const surfnet = new RunningSurfnet({
    ports,
    source: forkUrl === undefined ? "offline" : redactUrl(forkUrl),
    surfpoolVersion,
    child,
    exited,
    stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_SURFNET_STOP_TIMEOUT_MS,
    workDir,
  });
  try {
    for (;;) {
      if (exitedWith !== undefined) throw new Exited(exitedWith);
      const info = await surfnet.info().catch(() => undefined);
      if (info?.startup.phase === "ready") {
        const cheats = createCheats(surfnet.rpc, (method, params) =>
          surfnet.request(method, params),
        );
        return { surfnet: Object.assign(surfnet, cheats), tail };
      }
      if (info?.startup.phase === "failed") {
        throw new SurfnetBootError(
          `forkit: surfpool reported a failed startup: ${info.startup.error ?? "no reason given"}`,
        );
      }
      if (Date.now() > deadline) {
        throw new SurfnetBootError(
          `forkit: surfpool was not ready within ${options.bootTimeoutMs ?? DEFAULT_SURFNET_BOOT_TIMEOUT_MS} ms (raise bootTimeoutMs; a slow fork RPC is the usual cause).`,
        );
      }
      await Promise.race([sleep(POLL_MS), exited]);
    }
  } catch (error) {
    await surfnet.stop();
    if (error instanceof Exited) {
      // Give the pipes a moment to flush the reason surfpool printed before it exited.
      await sleep(50);
    }
    throw Object.assign(error as Error, { tail });
  }
}

/**
 * Boot a surfnet: `surfpool start`, headless, forked from `rpcUrl` (see
 * {@link SurfnetOptions.rpcUrl}) or offline. Resolves once surfpool's startup reports ready.
 *
 * ```ts
 * const s = await surfnet({ rpcUrl: process.env.SOLANA_RPC_URL });
 * const { value } = await s.rpc.getBalance(address("…")).send();
 * await s.stop();
 * ```
 */
export async function surfnet(options: SurfnetOptions = {}): Promise<Surfnet> {
  const binary = resolveSurfpoolBinary(options.surfpoolBinary);
  const surfpoolVersion = assertSurfpoolInstalled(binary);
  const forkUrl = resolveSurfnetSource(options);
  const bootMs = options.bootTimeoutMs ?? DEFAULT_SURFNET_BOOT_TIMEOUT_MS;
  const deadline = Date.now() + bootMs;
  const source = forkUrl === undefined ? "offline" : redactUrl(forkUrl);
  for (let attempt = 1; ; attempt++) {
    try {
      return (await bootOnce(options, binary, surfpoolVersion, forkUrl, deadline)).surfnet;
    } catch (error) {
      // surfpool can echo the fork URL in its errors: mask it like everywhere else.
      const raw = String((error as { tail?: OutputTail }).tail ?? "");
      const tail = forkUrl === undefined ? raw : raw.split(forkUrl).join(source);
      // freePort() releases its port before surfpool binds it, so another process can take it
      // in between. Rare; boot again on fresh ports.
      if (error instanceof Exited && PORT_IN_USE.test(tail) && attempt < BOOT_ATTEMPTS) continue;
      const reason =
        error instanceof Exited
          ? `forkit: surfpool ${error.message} before it was ready.`
          : (error as Error).message;
      throw new SurfnetBootError(
        [
          reason,
          `  fork source: ${source}`,
          `  binary: ${binary} (${surfpoolVersion})`,
          tail === "" ? "  (surfpool printed nothing)" : `  surfpool output:\n${indent(tail)}`,
        ].join("\n"),
        { cause: error },
      );
    }
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .slice(-30)
    .map((line) => `    ${line}`)
    .join("\n");
}
