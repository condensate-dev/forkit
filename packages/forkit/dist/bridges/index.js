/**
 * `@condensate/forkit/bridges`: simulated relayers and solvers for cross-chain tests on a
 * multi-chain fork. `bridge.across(f)`, `bridge.relay(f)`, or `bridge.custom(f, {...})` for any
 * other bridge; then `await b.settle()` fills every pending deposit and `b.fills` lists them.
 */
import { across } from "./across.js";
import { custom } from "./core.js";
import { relay } from "./relay.js";
export { ACROSS_DEFAULT_RELAYER, ACROSS_MULTICALL_HANDLER, ACROSS_SPOKE_POOLS, acrossFee, acrossOutputAmount, spokePoolAbi, } from "./across.js";
export { DEFAULT_RELAY_SOLVER, RelayFillError, } from "./relay.js";
export { RELAY_DEPOSITORY, RELAY_NATIVE, RELAY_RECEIVER, RELAY_ROUTER, relayDepositoryAbi, relayReceiverAbi, relayRouterAbi, } from "./relay-contracts.js";
export { encodeRelayOrderCall, fillFromQuote, } from "./relay-plan.js";
export { across, custom, relay };
export const bridge = { across, relay, custom };
//# sourceMappingURL=index.js.map