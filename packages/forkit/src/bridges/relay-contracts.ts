/**
 * Relay's on-chain contracts that the simulator touches: addresses and the minimal ABIs.
 *
 * Every fact here comes from Relay's public docs or verified source:
 * - Chain metadata (depository, relayReceiver, erc20Router per chain): Relay's public chains API,
 *   https://api.relay.link/chains, which the docs' address tables are generated from
 *   (https://docs.relay.link/references/protocol/depository/addresses and
 *   https://docs.relay.link/references/api/api_resources/contract-addresses).
 * - RelayDepository: https://docs.relay.link/references/protocol/contracts/evm-depository, source at
 *   https://github.com/relayprotocol/relay-depository (packages/ethereum-vm/src/RelayDepository.sol),
 *   verified as `RelayDepository` at e.g. https://basescan.org/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31
 *   and https://arbiscan.io/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31 (Sourcify exact match).
 * - RelayReceiver: https://github.com/relayprotocol/relay-periphery (src/receiver/RelayReceiver.sol),
 *   verified at https://basescan.org/address/0xa5f565650890fba1824ee0f21ebbbf660a179934 and
 *   https://etherscan.io/address/0xa5f565650890fba1824ee0f21ebbbf660a179934.
 * - RelayRouterV3 (`multicall`): https://github.com/relayprotocol/relay-periphery (src/RelayRouter.sol,
 *   src/common/Multicall3.sol), verified as `RelayRouterV3` at
 *   https://arbiscan.io/address/0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f; listed as the "v3 Router
 *   (Cancun)" in https://docs.relay.link/references/api/api_resources/contract-addresses.
 */
import { type Address, parseAbi, parseAbiItem } from "viem";

/** Native currency, as Relay's quotes and the depository's `token` args spell it. */
export const RELAY_NATIVE: Address = "0x0000000000000000000000000000000000000000";

/**
 * RelayDepository, the live deposit target of Relay quotes (`protocol.v2.paymentDetails.depository`).
 * Same address on Ethereum, Optimism, Base and Arbitrum (api.relay.link/chains, `protocol.v2.depository`).
 */
export const RELAY_DEPOSITORY: Address = "0x4cd00e387622c35bddb9b4c962c136462338bc31";

/**
 * RelayReceiver, Relay's older deposit target: it forwards `msg.value` to its solver and emits
 * `FundsForwardedWithData(data)`. Still deployed (api.relay.link/chains, `contracts.relayReceiver`), but
 * current quotes deposit into the depository instead, so the simulator watches it only on request.
 */
export const RELAY_RECEIVER: Address = "0xa5f565650890fba1824ee0f21ebbbf660a179934";

/**
 * RelayRouterV3, the destination contract that runs a fill's calls with itself as `msg.sender`
 * (api.relay.link/chains, `contracts.erc20Router`; also the `extraData` of a quote's order output).
 */
export const RELAY_ROUTER: Address = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";

/** Chains (Ethereum, Optimism, Base, Arbitrum) where the addresses above were checked. */
export const RELAY_CHAINS: readonly number[] = [1, 10, 8453, 42161];

/** Relay's chain slugs (`protocol.v2.orderData.output.chainId`) for those chains, from api.relay.link/chains. */
export const RELAY_CHAIN_SLUGS: Readonly<Record<string, number>> = {
  ethereum: 1,
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
};

/** Depository events (RelayDepository.sol). Neither indexes its args: `id` is in the log data. */
export const relayNativeDepositEvent = parseAbiItem(
  "event RelayNativeDeposit(address from, uint256 amount, bytes32 id)",
);
export const relayErc20DepositEvent = parseAbiItem(
  "event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
);
/** RelayReceiver's event: `data` is the forwarded calldata (the request id, for Relay's own quotes). */
export const fundsForwardedWithDataEvent = parseAbiItem("event FundsForwardedWithData(bytes data)");

/** The depository's deposit functions, for tests and callers that build deposits by hand. */
export const relayDepositoryAbi = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
  "function depositErc20(address depositor, address token, bytes32 id)",
  "event RelayNativeDeposit(address from, uint256 amount, bytes32 id)",
  "event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
]);

/** RelayReceiver's deposit entry point (it also accepts any calldata through its fallback). */
export const relayReceiverAbi = parseAbi([
  "function forward(bytes data) payable",
  "event FundsForwardedWithData(bytes data)",
]);

/** RelayRouterV3's multicall: each call runs with the router as `msg.sender`. */
export const relayRouterAbi = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function multicall(Call3Value[] calls, address refundTo, address nftRecipient, bytes metadata) payable returns (Result[] returnData)",
]);
