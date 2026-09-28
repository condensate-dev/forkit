import { NotImplementedError } from "../errors.ts";
import type { BridgeSimulator, MultiFork } from "./core.ts";

/** Across relayer simulator (milestone 5b, in progress). */
export function across(_f: MultiFork, _options?: unknown): BridgeSimulator {
  throw new NotImplementedError("bridge.across", 5);
}
