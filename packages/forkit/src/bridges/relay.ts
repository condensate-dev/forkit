import { NotImplementedError } from "../errors.ts";
import type { BridgeSimulator, MultiFork } from "./core.ts";

/** Relay solver simulator (milestone 5b, in progress). */
export function relay(_f: MultiFork, _options?: unknown): BridgeSimulator {
  throw new NotImplementedError("bridge.relay", 5);
}
