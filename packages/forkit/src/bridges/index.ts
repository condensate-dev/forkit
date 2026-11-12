/**
 * `@condensate_dev/forkit/bridges`: simulated relayers and solvers for cross-chain tests on a
 * multi-chain fork. `bridge.across(f)`, `bridge.relay(f)`, or `bridge.custom(f, {...})` for any
 * other bridge; then `await b.settle()` fills every pending deposit and `b.fills` lists them.
 */
import { across } from "./across.ts";
import { custom } from "./core.ts";
import { relay } from "./relay.ts";

export {
  ACROSS_DEFAULT_RELAYER,
  ACROSS_MULTICALL_HANDLER,
  ACROSS_SPOKE_POOLS,
  type AcrossDeposit,
  type AcrossDepositArgs,
  type AcrossDepositEvent,
  type AcrossFeeConfig,
  type AcrossFill,
  type AcrossFillDetails,
  type AcrossOptions,
  acrossFee,
  acrossOutputAmount,
  spokePoolAbi,
} from "./across.ts";
export type {
  BridgeSimulator,
  CustomBridgeOptions,
  Deposit,
  Fill,
  FillContext,
  FillResult,
  MultiFork,
} from "./core.ts";
export {
  DEFAULT_RELAY_SOLVER,
  type RelayFillDetails,
  RelayFillError,
  type RelayOptions,
  type RelaySimulator,
} from "./relay.ts";
export {
  RELAY_DEPOSITORY,
  RELAY_NATIVE,
  RELAY_RECEIVER,
  RELAY_ROUTER,
  relayDepositoryAbi,
  relayReceiverAbi,
  relayRouterAbi,
} from "./relay-contracts.ts";
export {
  encodeRelayOrderCall,
  type FillFromQuoteOptions,
  fillFromQuote,
  type RelayCall,
  type RelayDepositArgs,
  type RelayDepositKind,
  type RelayFee,
  type RelayFill,
  type RelayQuoteLike,
} from "./relay-plan.ts";
export { across, custom, relay };

export const bridge = { across, relay, custom } as const;
