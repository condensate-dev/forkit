# `bridge.cctp(f)`: Circle CCTP

`bridge.cctp(f)` watches Circle's TokenMessengers for `DepositForBurn`, v1 and v2, and credits the mint recipient with USDC on the destination fork.

```ts
import { bridge } from "@condensate_dev/forkit/bridges";

const f = await fork([{ chain: base, blockNumber: B }, { chain: optimism, blockNumber: O }]);
const cctp = bridge.cctp(f);

await burnOnBase();                  // your code: depositForBurn(amount, 2, pad(bob), USDC_BASE, ...)
const [fill] = await cctp.settle();  // bob holds `fill.outputAmount` more USDC on OP Mainnet
fill.details.fee;                    // the v2 fee kept, 0n for v1
```

## The credit is not a real mint

Circle's attestation service signs each burn, and `receiveMessage` on the destination mints USDC. forkit has no attester, so the simulator sets the recipient's balance with `deal`:

- **No transaction runs.** `fill.txHashes` is empty.
- **The total supply does not change**, and there is no `Transfer` event and no `MintAndWithdraw` event.
- **`hookData` and `destinationCaller` are not used.** CCTP v2 does not run hooks itself, and the simulator does not either. Both are in the fill, so you can run your own hook handler after `settle()`.

Use it to test what your code does when the USDC arrives. Do not use it to test the mint.

## What it reads

| Event | Version | Source |
|---|---|---|
| `DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)` | v1 | `src/TokenMessenger.sol` |
| `DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)` | v2 | `src/v2/TokenMessengerV2.sol` |

Both come from [circlefin/evm-cctp-contracts](https://github.com/circlefin/evm-cctp-contracts). Their topics were checked against live Base logs.

- **The destination chain** is the chain of `destinationDomain`, from `CCTP_DOMAINS` and your `domains`.
- **The recipient** is `mintRecipient`. It must be an EVM address in a bytes32 (12 zero bytes, then 20). Anything else fails loudly.
- **A deposit to a domain with no chain id**, such as Solana (domain 5), fails. Without `maxFillAttempts` it holds the deposits behind it. To let a stack go on, map that domain to a chain id you do not fork, such as `domains: { 900005: 5 }`, and pass `unforkedDestination: "skip"` or `"deliver"`.
- **The token** is what the real mint uses: the destination TokenMessenger's `localMinter()`, then `getLocalToken(originDomain, burnToken)`. Pass `usdc` to name it yourself.
- **The amount** is `amount` for v1. For v2 it is `amount - fee`, where the fee is `maxFee` for a Fast Transfer (`minFinalityThreshold` below 2000) and 0 for a Standard Transfer. Circle sets the real fee at attestation, and it is at most `maxFee`, so the default is the least the recipient can get. Pass `fee` to choose it.

## Options

| Option | Default | |
| --- | --- | --- |
| `tokenMessengers` | TokenMessengerV2 on every chain in `CCTP_DOMAINS`, plus v1 on Ethereum, OP Mainnet and Base | `{ [chainId]: address \| address[] }`, merged per chain. Every forked chain with an entry is an origin. |
| `domains` | `CCTP_DOMAINS` | `{ [chainId]: domain }`, merged. Each domain is one chain. |
| `usdc` | read from the destination minter | `{ [chainId]: address }`: the token to credit. |
| `fee` | see above | `(args: CctpV2DepositArgs) => bigint`. It must be between 0 and `min(maxFee, amount)`. |
| `journalDir`, `maxFillAttempts`, `unforkedDestination` | | see [the long-running stack guide](long-running-stacks.md#the-fill-journal) |

The journal key of a v1 burn is `v1-<origin domain>-<nonce>`. A v2 burn gets its nonce at attestation, so its key is `v2-<deposit id>`.

## Addresses and domains

From Circle's docs, [Supported chains and domains](https://developers.circle.com/cctp/supported-domains) and the contract addresses page. Each was checked on chain in November 2026: the domain is `localDomain()` of the MessageTransmitterV2 at `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`.

| Chain | Id | Domain | v1 TokenMessenger |
| --- | --- | --- | --- |
| Ethereum | 1 | 0 | `0xBd3fa81B58Ba92a82136038B25aDec7066af3155` |
| Avalanche C-Chain | 43114 | 1 | pass it |
| OP Mainnet | 10 | 2 | `0x2B4069517957735bE00ceE0fadAE88a26365528f` |
| Arbitrum One | 42161 | 3 | pass it |
| Base | 8453 | 6 | `0x1682Ae6375C4E4A97e4B583BC394c861A46D8962` |
| Polygon PoS | 137 | 7 | pass it |

TokenMessengerV2 is `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` on each of them.

## Tests

- `test/anvil/bridges-cctp.vitest.ts` runs on two local anvils, with a stub that emits both events and answers the minter reads.
- `test/e2e/cctp-base-optimism.vitest.ts` burns USDC through Circle's real v1 and v2 TokenMessengers on Base, and reads the real minter on OP Mainnet.
