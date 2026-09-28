/**
 * The parts of Across's SpokePool ABI the relayer simulator uses, and the SpokePool address table.
 *
 * ABI source: across-protocol/contracts, `contracts/interfaces/V3SpokePoolInterface.sol` and
 * `contracts/spoke-pools/SpokePool.sol`,
 * https://github.com/across-protocol/contracts/blob/master/contracts/interfaces/V3SpokePoolInterface.sol
 * Checked on chain in September 2026 for Ethereum, Optimism, Base and Arbitrum: the recent deposit
 * logs of each SpokePool proxy are all `FundsDeposited` (none `V3FundsDeposited`), and the
 * implementation behind it (the ERC-1967 slot) has both `fillRelay` (selector 0xdeff4b24) and
 * `fillV3Relay` (0x2e378115).
 */
import type { Address } from "viem";
import { parseAbi } from "viem";

/**
 * Across SpokePool per chain id. Source: Across docs, "Chains & Contracts",
 * https://docs.across.to/reference/contract-addresses (mirrors
 * https://github.com/across-protocol/contracts/blob/master/broadcast/deployed-addresses.json).
 */
export const ACROSS_SPOKE_POOLS: Readonly<Record<number, Address>> = {
  // Ethereum: https://etherscan.io/address/0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5
  1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  // Optimism: https://optimistic.etherscan.io/address/0x6f26Bf09B1C792e3228e5467807a900A503c0281
  10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  // BNB Smart Chain: docs.across.to, "Chains & Contracts"
  56: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
  // Unichain (same address as Base): docs.across.to, "Chains & Contracts"
  130: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  // Polygon: docs.across.to, "Chains & Contracts"
  137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
  // World Chain (same address as Base): docs.across.to, "Chains & Contracts"
  480: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  // Soneium: docs.across.to, "Chains & Contracts"
  1868: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
  // Base: https://basescan.org/address/0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64
  8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  // Arbitrum One: https://arbiscan.io/address/0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A
  42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  // Avalanche: docs.across.to, "Chains & Contracts"
  43114: "0xFE9D541c92E4e90437C7152A00244886dE37a658",
  // Ink: docs.across.to, "Chains & Contracts"
  57073: "0xeF684C38F94F48775959ECf2012D7E864ffb9dd4",
  // Linea: docs.across.to, "Chains & Contracts"
  59144: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75",
};

/**
 * Across's MulticallHandler, a message recipient that runs calls and sends leftovers to a fallback
 * recipient. Same address on Ethereum, Optimism, Base, Arbitrum and others. Source: docs.across.to,
 * "Chains & Contracts"; contract: across-protocol/contracts `contracts/handlers/MulticallHandler.sol`.
 */
export const ACROSS_MULTICALL_HANDLER: Address = "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E";

export const spokePoolAbi = parseAbi([
  // Current SpokePools (bytes32 addresses, uint256 depositId).
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
  // SpokePools before the bytes32 upgrade (addresses, uint32 depositId).
  "event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)",
  "struct V3RelayData { bytes32 depositor; bytes32 recipient; bytes32 exclusiveRelayer; bytes32 inputToken; bytes32 outputToken; uint256 inputAmount; uint256 outputAmount; uint256 originChainId; uint256 depositId; uint32 fillDeadline; uint32 exclusivityDeadline; bytes message; }",
  "struct V3RelayDataLegacy { address depositor; address recipient; address exclusiveRelayer; address inputToken; address outputToken; uint256 inputAmount; uint256 outputAmount; uint256 originChainId; uint32 depositId; uint32 fillDeadline; uint32 exclusivityDeadline; bytes message; }",
  "function fillRelay(V3RelayData relayData, uint256 repaymentChainId, bytes32 repaymentAddress)",
  "function fillV3Relay(V3RelayDataLegacy relayData, uint256 repaymentChainId)",
  // Deposits (for tests and callers that build their own). `exclusivityParameter`: 0 for none, an
  // offset in seconds up to 31,536,000, or an absolute timestamp (SpokePool.sol, `deposit`).
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
  "function fillDeadlineBuffer() view returns (uint32)",
  "function depositQuoteTimeBuffer() view returns (uint32)",
]);

/** MulticallHandler's message: `abi.encode(Instructions)` (MulticallHandler.sol). */
export const multicallHandlerInstructions = [
  {
    type: "tuple",
    components: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
      { name: "fallbackRecipient", type: "address" },
    ],
  },
] as const;
