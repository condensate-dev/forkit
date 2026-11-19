/**
 * `@condensate_dev/forkit/bridges`: simulated relayers and solvers for cross-chain tests on a
 * multi-chain fork. `bridge.across(f)`, `bridge.acrossPrefunded(f, {...})`, `bridge.cctp(f)`, `bridge.oft(f, {...})`,
 * `bridge.relay(f)`, or
 * `bridge.custom(f, {...})` for any other bridge; then `await b.settle()` fills every pending
 * deposit and `b.fills` lists them.
 * `bridge.run([...])` settles simulators on an interval, for a long-running stack.
 */
import { across } from "./across.ts";
import { acrossPrefunded } from "./across-prefunded.ts";
import { cctp } from "./cctp.ts";
import { custom } from "./core.ts";
import { oft } from "./layerzero.ts";
import { relay } from "./relay.ts";
import { runBridges } from "./run.ts";

export {
  ACROSS_DEFAULT_RELAYER,
  ACROSS_MULTICALL_HANDLER,
  ACROSS_SPOKE_POOLS,
  type AcrossDeposit,
  type AcrossDepositArgs,
  type AcrossDepositEvent,
  type AcrossFailedFill,
  type AcrossFeeConfig,
  type AcrossFill,
  type AcrossFillDetails,
  type AcrossOptions,
  acrossFee,
  acrossOutputAmount,
  spokePoolAbi,
} from "./across.ts";
export {
  ACROSS_PREFUNDED_ADAPTER_BASE,
  type AcrossPrefundedArgs,
  AcrossPrefundedError,
  type AcrossPrefundedFillDetails,
  type AcrossPrefundedOptions,
  type AcrossPrefundedOrder,
  type AcrossPrefundedSimulator,
  acrossPrefundedAdapterAbi,
  acrossPrefundingStoredEvent,
} from "./across-prefunded.ts";
export {
  CCTP_DOMAINS,
  CCTP_TOKEN_MESSENGER_V2,
  CCTP_TOKEN_MESSENGERS_V1,
  type CctpDeposit,
  type CctpDepositArgs,
  CctpError,
  type CctpFailedFill,
  type CctpFill,
  type CctpFillDetails,
  type CctpOptions,
  type CctpV1DepositArgs,
  type CctpV2DepositArgs,
  cctpDefaultFee,
  cctpDepositForBurnV1Event,
  cctpDepositForBurnV2Event,
  cctpTokenMessengerAbi,
  cctpTokenMinterAbi,
  decodeCctpDeposit,
} from "./cctp.ts";
export type {
  BridgeSimulator,
  BridgeSimulatorOptions,
  CustomBridgeOptions,
  Deposit,
  FailedFill,
  Fill,
  FillContext,
  FillResult,
  MultiFork,
  UnforkedDestination,
} from "./core.ts";
export {
  type FailedJournalEntry,
  type FilledJournalEntry,
  type FillJournalDeposit,
  type FillJournalEntry,
  fillJournalFile,
  type JsonValue,
  type UnforkedJournalEntry,
} from "./journal.ts";
export {
  decodeOftPacket,
  decodeOftSent,
  LAYERZERO_EIDS,
  LAYERZERO_ENDPOINT_V2,
  lzComposeSentEvent,
  lzEndpointAbi,
  lzOAppAbi,
  lzPacketSentEvent,
  OFT_DEFAULT_EXECUTOR,
  type OftDeposit,
  OftError,
  type OftFailedFill,
  type OftFill,
  type OftFillDetails,
  type OftOptions,
  type OftPacket,
  type OftSentArgs,
  oftPacketFor,
  oftReceivedEvent,
  oftSentEvent,
} from "./layerzero.ts";
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
export { type RunBridgesOptions, runBridges, type Settleable } from "./run.ts";
export { across, acrossPrefunded, cctp, custom, oft, relay };

export const bridge = {
  across,
  acrossPrefunded,
  cctp,
  oft,
  relay,
  custom,
  run: runBridges,
} as const;
