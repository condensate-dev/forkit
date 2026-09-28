/** Base class for every error forkit throws. */
export class ForkitError extends Error {
  override name = "ForkitError";
}

/** Thrown by every API that a later milestone implements. */
export class NotImplementedError extends ForkitError {
  override name = "NotImplementedError";
  readonly api: string;
  readonly milestone: number;

  constructor(api: string, milestone: number) {
    super(`forkit: ${api} is not implemented yet (planned for milestone ${milestone})`);
    this.api = api;
    this.milestone = milestone;
  }
}

/** anvil is not installed, or not on PATH. Thrown at collection time, never skipped. */
export class AnvilNotFoundError extends ForkitError {
  override name = "AnvilNotFoundError";

  constructor(binary: string, cause?: unknown) {
    super(
      [
        `forkit: could not run \`${binary} --version\`. forkit needs foundry's anvil on PATH.`,
        "Install it with:",
        "  curl -L https://foundry.paradigm.xyz | bash && foundryup",
        "A fork suite that cannot run is a broken environment, not a skipped test.",
      ].join("\n"),
      { cause },
    );
  }
}

/** anvil failed to boot, or did not become ready in time. */
export class ForkBootError extends ForkitError {
  override name = "ForkBootError";
}

/** A balance write did not produce the requested balance. */
export class DealError extends ForkitError {
  override name = "DealError";
}
