import { type ChildProcess } from "node:child_process";
import { ForkitError } from "../errors.ts";
/** alto (`@pimlico/alto`) is not installed where forkit or the project can resolve it. */
export declare class AltoNotFoundError extends ForkitError {
    name: string;
    constructor(detail: string, cause?: unknown);
}
/** The bundler could not start, or does not serve what was asked for. */
export declare class BundlerBootError extends ForkitError {
    name: string;
}
/** How to launch alto: a command and the arguments before alto's own flags. */
export interface AltoCommand {
    command: string;
    args: string[];
}
/**
 * Find alto. An explicit `altoBinary` wins: a `.js`/`.mjs` path runs under Node, anything else
 * runs as an executable. Otherwise `@pimlico/alto` is resolved from forkit, then from the working
 * directory's project, and its CLI (`esm/cli/alto.js`, the package's `bin`) runs under Node.
 */
export declare function resolveAlto(altoBinary?: string): AltoCommand;
/** A flag value: arrays are comma-joined, booleans are written out (`--safe-mode false`). */
export type AltoFlagValue = string | number | boolean | readonly string[];
/**
 * Render alto flags. Keys are alto's own kebab-case flag names without the dashes, as listed by
 * `alto --help` (e.g. `"rpc-url"`, `"safe-mode"`); `undefined` values are skipped.
 */
export declare function renderAltoFlags(flags: Readonly<Record<string, AltoFlagValue | undefined>>): string[];
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
/** Start alto. Output goes to `onLine` as it arrives and is kept for {@link AltoProcess.output}. */
export declare function spawnAlto(alto: AltoCommand, flags: readonly string[], onLine: (line: string) => void): AltoProcess;
//# sourceMappingURL=alto.d.ts.map