# Stablecoin payments: `@condensate_dev/forkit/payments`

`@condensate_dev/forkit/payments` signs the three ways a stablecoin payment is authorized off chain (EIP-2612 permits, EIP-3009 transfer authorizations and Permit2) against the real tokens on a fork, with deterministic test keys. It gets past USDT's and USDC's quirks, and it asserts what a payment changed. Nothing is mocked: every signature is checked by the forked contract's own code.

```ts
import { parseEther, parseUnits } from "viem";
import { base } from "viem/chains";
import { expectBalanceChange } from "@condensate_dev/forkit";
import {
  authorizationNonce,
  eip3009Abi,
  expectAuthorizationUsed,
  signTransferWithAuthorization,
  testAccount,
  testAddress,
} from "@condensate_dev/forkit/payments";
import { describeFork, itFork } from "@condensate_dev/forkit/vitest";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BLOCK = 51_950_000n;
const alice = testAccount("alice"); // signs; never needs ETH
const relayer = testAddress("relayer"); // submits, and pays the gas
const shop = testAddress("shop");

describeFork("gasless USDC on Base", { chain: base, blockNumber: BLOCK }, (f) => {
  itFork("a relayer submits alice's authorization", async () => {
    await f.deal(USDC, alice.address, parseUnits("100", 6));
    await f.dealNative(relayer, parseEther("1"));
    const { timestamp } = await f.client.getBlock({ blockNumber: BLOCK });
    const nonce = authorizationNonce("order 42");
    const auth = await signTransferWithAuthorization(f.client, {
      token: USDC,
      from: alice,
      to: shop,
      value: parseUnits("25", 6),
      validBefore: timestamp + 3_600n, // from the fork's clock, never Date.now()
      nonce,
    });
    await expectBalanceChange(f.client, USDC, shop, parseUnits("25", 6), () =>
      f.prank(relayer, (c) =>
        c.writeContract({ address: USDC, abi: eip3009Abi, functionName: "transferWithAuthorization", args: auth.args }),
      ),
    );
    await expectAuthorizationUsed(f.client, USDC, alice.address, nonce);
  });
});
```

Signing and the assertions only read, so they take a viem client: `f.client`, or any client. The token helpers send transactions as someone, so they take the fork.

## Test keys and nonces

- **`testAccount(name)`** is a viem private-key account whose key is `keccak256("forkit payments " + name)`. Use it for anyone who signs.
- **`testAddress(name)`** is an address no one holds the key to (the last 20 bytes of another hash), so on the real chain it has never sent a transaction and has no code. Use it for payees, spenders and relayers, which forkit impersonates.
- Both label the address with `name` for errors, traces and the explorer, like forge-std's `makeAddrAndKey` and `makeAddr`, unless the address has a label already.
- **`authorizationNonce(name)`** is an EIP-3009 `bytes32` nonce, and **`permit2Nonce(name)`** a Permit2 SignatureTransfer nonce, both hashed from `name`.

The keys are public, so use them on forks only. Never sign with `generatePrivateKey()` or a random nonce: each run would send different calldata and touch different storage, and the [fork cache](fork-cache-and-ci.md) would miss.

## EIP-2612 permits

`signPermit` reads the owner's `nonces(owner)` and the token's EIP-712 domain, then signs `Permit(owner, spender, value, nonce, deadline)`:

```ts
const permit = await signPermit(f.client, { token: USDC, owner: alice, spender: bob, value, deadline });
await f.prank(bob, (c) =>
  c.writeContract({ address: USDC, abi: eip2612Abi, functionName: "permit", args: permit.args }),
);
await expectAllowance(f.client, USDC, alice.address, bob, value);
await expectPermitNonce(f.client, USDC, alice.address, permit.nonce + 1n);
```

`permit.args` are the arguments of `permit(owner, spender, value, deadline, v, r, s)`. The result also carries the 65-byte `signature`, `v`, `r`, `s`, the `nonce` and the `domain`. Pass `nonce` or `domain` to skip reading them. Once the nonce moves on, the same signature recovers to another address, and USDC reverts with `EIP2612: invalid signature`.

## EIP-3009 authorizations

- **`signTransferWithAuthorization`** signs a transfer anyone may submit, as in the example above.
- **`signReceiveWithAuthorization`** signs one only the payee (`to`) may submit, so a front-runner cannot lift it out of the mempool. USDC reverts with `FiatTokenV2: caller must be the payee` for anyone else.

Both take `{ token, from, to, value, validBefore, nonce }`, and `validAfter` (default 0). `auth.args` fit the `(v, r, s)` form of either function. EIP-3009 nonces are unordered, so a payment is identified by its nonce: `expectAuthorizationUsed` and `expectAuthorizationUnused` read `authorizationState(authorizer, nonce)`. A used (or canceled) nonce reverts with `FiatTokenV2: authorization is used or canceled`.

USDC also has overloads that take `bytes signature` instead of `v`, `r`, `s` (they accept ERC-1271 smart-wallet signatures too). viem picks the overload by the arguments, so `args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.signature]` calls that one.

## Permit2

Permit2 moves tokens it has an ordinary ERC-20 allowance for, so the owner approves Permit2 once, in a transaction of their own (and pays its gas):

```ts
await f.dealNative(alice.address, parseEther("1"));
await forceApprove(f, { token: USDC, owner: alice.address, spender: PERMIT2, amount });
```

**SignatureTransfer**, one transfer per signature:

```ts
const signed = await signPermitTransferFrom(f.client, {
  owner: alice, token: USDC, amount: 60n * 10n ** 6n, spender: bob, nonce: permit2Nonce("order 1"), deadline,
});
await f.prank(bob, (c) =>
  c.writeContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "permitTransferFrom",
    args: [signed.permit, { to: shop, requestedAmount: 50n * 10n ** 6n }, alice.address, signed.signature],
  }),
);
await expectPermit2NonceUsed(f.client, alice.address, permit2Nonce("order 1"));
```

The signature covers the spender, but the calldata does not carry it: Permit2 checks it against `msg.sender`, so sign for whoever will submit. Nonces are unordered: `expectPermit2NonceUsed` reads bit `nonce & 0xff` of `nonceBitmap(owner, nonce >> 8)`. A spent nonce reverts with `InvalidNonce()`, and a request above the signed amount with `InvalidAmount(uint256)`.

**AllowanceTransfer**, a time-boxed allowance the spender draws on:

```ts
const signed = await signPermitSingle(f.client, {
  owner: alice, token: USDC, amount, expiration, spender: bob, sigDeadline: deadline,
});
await f.prank(bob, (c) =>
  c.writeContract({ address: PERMIT2, abi: permit2Abi, functionName: "permit", args: signed.args }),
);
await f.prank(bob, (c) =>
  c.writeContract({ address: PERMIT2, abi: permit2Abi, functionName: "transferFrom", args: [alice.address, shop, 120n * 10n ** 6n, USDC] }),
);
await expectPermit2Allowance(f.client, USDC, alice.address, bob, { amount: amount - 120n * 10n ** 6n });
```

The nonce is read from `allowance(owner, token, spender)` unless you pass one; it is ordered per owner, token and spender. In viem's types `amount` (a `uint160`) is a bigint, and `expiration` and `nonce` (`uint48`) are numbers. Drawing more than the allowance reverts with `InsufficientAllowance(uint256)`, and a replayed permit with `InvalidNonce()`.

`PERMIT2` is Permit2's canonical address, the one Uniswap lists for Ethereum, Base and most other chains. Where it lives elsewhere, pass `permit2` to the signers, to `permit2Domain` and (in the last argument) to the Permit2 assertions. Pass `abi: permit2Abi` to `writeContract` or `expectRevert`, and Permit2's custom errors decode in errors, traces and the explorer.

## EIP-712 domains

The signers read the domain from the token with `tokenDomain(client, token)`:

1. EIP-5267 `eip712Domain()`, when the token has it, with only the fields its bitmap marks. A domain with extensions, or one for another chain, throws.
2. Otherwise `name()`, `version()` (default `"1"`), the fork's chain id and the token's address.
3. When the token has `DOMAIN_SEPARATOR()`, the domain is hashed and compared with it. A mismatch throws, so a signature never goes out under a domain the token would reject. Pass `domain` to the signer instead.

A token that lacks a function is told apart from a failed read: an RPC error, or a read that misses the offline [fork cache](fork-cache-and-ci.md), throws instead of silently changing the domain.

USDC (FiatTokenV2_2) has no `eip712Domain()`. Its domain is `{ name: "USD Coin", version: "2", chainId, verifyingContract }`: the version is hard-coded to `"2"` in the contract, and the name is `USD Coin` on Ethereum and Base. Permit2's domain has no version at all, `EIP712Domain(string name,uint256 chainId,address verifyingContract)`; `permit2Domain(client)` builds it, checks it against Permit2's `DOMAIN_SEPARATOR()`, and throws when Permit2 has no code at the forked block.

## Token quirks

### USDT

- **`approve` from a nonzero allowance to another nonzero allowance reverts**, with a bare `require` and no revert data (`expectRevert` resolves to `{ kind: "empty" }`). `forceApprove(f, { token, owner, spender, amount })` works like OpenZeppelin's `forceApprove`: it approves `amount` directly when the token accepts that, and approves 0 first when it does not. It resolves to `{ hash, reset }`, where `reset` says whether the zeroing was needed. Approving Permit2 is where USDT holders usually hit this.
- **`approve`, `transfer` and `transferFrom` return nothing.** A transaction through viem's `erc20Abi` still goes through, because nothing decodes its result, but `simulateContract` throws `"transfer" returned no data ("0x")`. `safeTransfer(f, { token, from, to, amount })` applies the SafeERC20 rule instead: no return data (from a contract) or `true` is success, and `false` throws. `noReturnErc20Abi` describes the functions as USDT implements them, for your own calls.

Both helpers impersonate `owner` or `from`, who pays the gas like any sender: fund it with `f.dealNative` if it has no ETH. They send through the fork's client, so gas is estimated first, a revert throws with its trace, and the terminal reporter and the explorer show each transaction.

### USDC

- **`blacklist(f, token, account)`** and **`pause(f, token)`** read `blacklister()` or `pauser()` from the token at the fork, set that account's balance to 1 ETH for gas if it holds less than 0.1 ETH, and impersonate it. They resolve to the role holder. They work on Circle's FiatToken (USDC, EURC); on another token they throw.
- **Deal first, then blacklist.** FiatTokenV2_2 keeps the blacklist flag in the top bit of the account's balance slot, and `f.deal` writes the whole slot, so dealing to a blacklisted account clears the flag.
- Transfers from or to a blacklisted account revert with `Blacklistable: account is blacklisted`, and every transfer of a paused token with `Pausable: paused`. Per-test snapshots undo both.

## Assertions

The assertions work in any runner. Like forkit's own, they throw `ForkitAssertionError` with `actual` and `expected`, and resolve to what they read.

| Assertion | Checks |
|---|---|
| `expectAllowance(client, token, owner, spender, amount)` | the ERC-20 `allowance(owner, spender)` |
| `expectPermitNonce(client, token, owner, nonce)` | the EIP-2612 `nonces(owner)` |
| `expectAuthorizationUsed(client, token, authorizer, nonce)` | EIP-3009 `authorizationState` is true (used or canceled) |
| `expectAuthorizationUnused(client, token, authorizer, nonce)` | it is false |
| `expectPermit2NonceUsed(client, owner, nonce, { permit2? })` | the nonce's bit in Permit2's `nonceBitmap` is set |
| `expectPermit2NonceUnused(client, owner, nonce, { permit2? })` | it is clear |
| `expectPermit2Allowance(client, token, owner, spender, { amount?, expiration?, nonce? }, { permit2? })` | Permit2's `allowance(owner, token, spender)`, only the fields given |

A mismatch reads like this:

```
forkit: expected alice (0xCC31…A734)'s Permit2 nonce 1234 to be used, but bit 210 of nonceBitmap word 4 is 0.
```

## Deterministic replays

For a payment test to replay offline from the [fork cache](fork-cache-and-ci.md), every run must send the same transactions:

- **Derive keys, addresses and nonces from fixed strings**: `testAccount`, `testAddress`, `authorizationNonce`, `permit2Nonce`.
- **Take deadlines from the pinned block's time**, e.g. `(await f.client.getBlock({ blockNumber: BLOCK })).timestamp + 3_600n`, never from `Date.now()`.
- **On Ethereum forks, pin block times.** On every block it mines, anvil 1.8 runs the EIP-4788 beacon-roots system call, which touches storage keyed by the block's timestamp, and it stamps blocks with the wall clock, so each run reads different storage and the recording misses. Set a fixed interval before the per-test snapshots, as [the fork cache guide](fork-cache-and-ci.md#making-replays-deterministic) shows.

`test/e2e/payments-base-ethereum.vitest.ts` runs all of this against the real contracts and replays offline on anvil 1.7.1 and 1.8.3:
- Base USDC: a permit and `transferFrom`, transfer and receive authorizations, and Permit2 SignatureTransfer and AllowanceTransfer, each with its replay rejected;
- Ethereum USDT: the nonzero-to-nonzero `approve` revert, `forceApprove`, and `transfer`'s missing return value;
- Ethereum USDC: blacklisting and pausing through the real role holders, the blacklist-bit gotcha, and snapshot isolation.

## What is real

| Piece | Real or simulated |
|---|---|
| USDC (FiatTokenV2_2) on Ethereum and Base, USDT (TetherToken) on Ethereum, Permit2 | **Real**: the deployed bytecode and storage at the pinned blocks |
| EIP-712 domains, `nonces`, `authorizationState`, `nonceBitmap`, `allowance` | **Real**: read from the forked contracts, domains checked against `DOMAIN_SEPARATOR()` |
| Signatures | **Real**: secp256k1 over the EIP-712 digests, verified by the contracts' own `ecrecover` |
| Token balances | **Simulated**: `f.deal` writes storage |
| Gas for impersonated accounts | **Simulated**: `f.dealNative` (the USDC role holders get ETH only when they are short) |
| Relayers, spenders and USDC's blacklister and pauser sending transactions | **Simulated**: anvil impersonation, no one's key; the role holders are the real ones, read from the token |

Every revert string and custom error the e2e asserts comes from the deployed contracts.

## ABIs, addresses and sources

The exported ABIs are slices of the verified contracts, enough to sign, submit and assert: `eip2612Abi` (with the reads a signer needs), `eip3009Abi`, `permit2Abi` (single-token SignatureTransfer and AllowanceTransfer, with Permit2's events and errors), `fiatTokenAdminAbi` (USDC's blacklist and pause roles) and `noReturnErc20Abi`.

| Contract | Chain | Address | Source |
|---|---|---|---|
| USDC | Ethereum (1) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses) |
| USDC | Base (8453) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses) |
| USDT | Ethereum (1) | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | [Tether](https://tether.to/en/supported-protocols/), which also notes that its `transfer` returns no boolean |
| Permit2 | Ethereum, Base | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | [Uniswap](https://developers.uniswap.org/docs/protocols/v4/deployments) |

Specifications: [EIP-712](https://eips.ethereum.org/EIPS/eip-712), [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612), [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) and [EIP-5267](https://eips.ethereum.org/EIPS/eip-5267). Contracts: Circle's [FiatTokenV2_2](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2_2.sol), Tether's [TetherToken](https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7#code) and Uniswap's [Permit2](https://github.com/Uniswap/permit2) (type strings in `PermitHash.sol`, the domain in `EIP712.sol`).
