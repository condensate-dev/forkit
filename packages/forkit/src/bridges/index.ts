/**
 * `@condensate/forkit/bridges`: simulated relayers and solvers for cross-chain tests on a
 * multi-chain fork. `bridge.across(f)`, `bridge.relay(f)`, or `bridge.custom(f, {...})` for any
 * other bridge; then `await b.settle()` fills every pending deposit and `b.fills` lists them.
 */
import { across } from "./across.ts";
import { custom } from "./core.ts";
import { relay } from "./relay.ts";

export type {
  BridgeSimulator,
  CustomBridgeOptions,
  Deposit,
  Fill,
  FillContext,
  FillResult,
  MultiFork,
} from "./core.ts";
export { across, custom, relay };

export const bridge = { across, relay, custom } as const;
