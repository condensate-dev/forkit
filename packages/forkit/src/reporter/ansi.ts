/**
 * Plain ANSI styling with the usual opt-outs: `NO_COLOR` (https://no-color.org), `FORCE_COLOR`,
 * `TERM=dumb`, CI logs and non-TTY streams all get plain text.
 */

type Env = Readonly<Record<string, string | undefined>>;

const set = (value: string | undefined) => value !== undefined && value !== "";
const truthy = (value: string | undefined) => set(value) && value !== "0" && value !== "false";

/**
 * Whether to colour output written to `stream`. `NO_COLOR` wins, then `FORCE_COLOR`; otherwise
 * colour only an interactive terminal that is not a CI log or `TERM=dumb`.
 */
export function shouldColor(
  stream: { isTTY?: boolean } | undefined = process.stdout,
  env: Env = process.env,
): boolean {
  if (set(env.NO_COLOR)) return false;
  if (env.FORCE_COLOR !== undefined) return truthy(env.FORCE_COLOR) || env.FORCE_COLOR === "";
  if (truthy(env.CI) || env.TERM === "dumb") return false;
  return stream?.isTTY === true;
}

export interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

const code =
  (open: number, close: number) =>
  (text: string): string =>
    text === "" ? text : `\u001b[${open}m${text}\u001b[${close}m`;

const PLAIN: Palette = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  cyan: (t) => t,
  magenta: (t) => t,
};

const COLOR: Palette = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  cyan: code(36, 39),
  magenta: code(35, 39),
};

export function palette(color: boolean): Palette {
  return color ? COLOR : PLAIN;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

/** `text` without ANSI escapes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
