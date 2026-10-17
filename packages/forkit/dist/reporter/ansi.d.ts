/**
 * Plain ANSI styling with the usual opt-outs: `NO_COLOR` (https://no-color.org), `FORCE_COLOR`,
 * `TERM=dumb`, CI logs and non-TTY streams all get plain text.
 */
type Env = Readonly<Record<string, string | undefined>>;
/**
 * Whether to colour output written to `stream`. `NO_COLOR` wins, then `FORCE_COLOR`; otherwise
 * colour only an interactive terminal that is not a CI log or `TERM=dumb`.
 */
export declare function shouldColor(stream?: {
    isTTY?: boolean;
} | undefined, env?: Env): boolean;
export interface Palette {
    bold(text: string): string;
    dim(text: string): string;
    red(text: string): string;
    green(text: string): string;
    yellow(text: string): string;
    cyan(text: string): string;
    magenta(text: string): string;
}
export declare function palette(color: boolean): Palette;
/** `text` without ANSI escapes. */
export declare function stripAnsi(text: string): string;
export {};
//# sourceMappingURL=ansi.d.ts.map