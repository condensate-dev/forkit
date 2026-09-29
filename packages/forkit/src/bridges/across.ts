/**
 * `bridge.across(f)`: an Across relayer simulator. It watches each origin fork's SpokePool for
 * deposits and, on `settle()`, fills each one on its destination fork the way an Across relayer
 * does: an impersonated, funded relayer approves the destination SpokePool and calls its fill
 * function with the deposit's relay data. The SpokePool then pays the recipient and runs any
 * message handler for real.
 *
 * Protocol behaviour follows across-protocol/contracts `contracts/spoke-pools/SpokePool.sol`
 * (https://github.com/across-protocol/contracts): `fillRelay` reverts with `NotExclusiveRelayer`
 * while `exclusivityDeadline >= block.timestamp` unless the caller is the exclusive relayer, and
 * with `ExpiredFillDeadline` once `fillDeadline < block.timestamp`; it pulls `outputAmount` of the
 * output token from the caller, sends it to the recipient (unwrapping WETH for EOAs), then calls
 * `handleV3AcrossMessage(token, amount, relayer, message)` on a contract recipient when the
 * message is not empty. See docs/guides/bridges-across.md.
 */
import {
  type Address,
  erc20Abi,
  getAbiItem,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  maxUint256,
  pad,
  parseEther,
  slice,
  toHex,
  zeroAddress,
} from "viem";
import { ForkitError } from "../errors.ts";
import type { Fork } from "../types.ts";
import { ACROSS_SPOKE_POOLS, spokePoolAbi } from "./across-abi.ts";
import {
  type BridgeSimulator,
  custom,
  type Deposit,
  type Fill,
  type FillContext,
  type FillResult,
  type MultiFork,
} from "./core.ts";

export { ACROSS_MULTICALL_HANDLER, ACROSS_SPOKE_POOLS, spokePoolAbi } from "./across-abi.ts";

/** Which SpokePool event a deposit came from. */
export type AcrossDepositEvent = "FundsDeposited" | "V3FundsDeposited";

/**
 * A decoded Across deposit. Both events are normalised to this shape: bytes32 fields become EVM
 * addresses (their low 20 bytes), ids and chain ids are bigints, timestamps are numbers.
 */
export interface AcrossDepositArgs {
  /** `FundsDeposited` on current SpokePools, `V3FundsDeposited` on ones before the bytes32 upgrade. */
  event: AcrossDepositEvent;
  depositor: Address;
  recipient: Address;
  inputToken: Address;
  outputToken: Address;
  inputAmount: bigint;
  outputAmount: bigint;
  destinationChainId: bigint;
  depositId: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  /** `0x000…0` when the deposit has no exclusive relayer. */
  exclusiveRelayer: Address;
  message: Hex;
}

export type AcrossDeposit = Deposit<AcrossDepositArgs>;
export type AcrossFill = Fill<AcrossDepositArgs>;

/** What `bridge.across` reports in each fill's `details`. */
export interface AcrossFillDetails {
  /** `inputAmount - delivered`, in raw token units (meaningful when both tokens share decimals). */
  fee: bigint;
  /** The deposit's own `outputAmount` (the delivered amount differs only with the override). */
  depositOutputAmount: bigint;
  /** Who filled: the exclusive relayer while its window is open, the default relayer otherwise. */
  relayer: Address;
  exclusive: boolean;
  repaymentChainId: number;
  spokePool: Address;
  fillFunction: "fillRelay" | "fillV3Relay";
}

/** A fee as basis points of `inputAmount` plus a fixed amount, both in the input token's units. */
export interface AcrossFeeConfig {
  /** Proportional fee in basis points (1 bps = 0.01 %). Default 0. */
  bps?: number | bigint;
  /** Fixed fee (e.g. gas cost) in raw token units. Default 0. */
  fixed?: bigint;
}

export interface AcrossOptions {
  /**
   * SpokePool addresses by chain id, merged over the built-in table ({@link ACROSS_SPOKE_POOLS}).
   * Use it for a chain the table lacks or a fork of a test deployment.
   */
  spokePools?: Readonly<Record<number, Address>>;
  /**
   * Origin chains to watch. Default: every forked chain with a known SpokePool. Naming a chain
   * with no SpokePool, or one not in the fork, is an error.
   */
  origins?: readonly number[];
  /**
   * The relayer that fills when no exclusive relayer holds the deposit. Default: a fixed test
   * address no one controls on a real chain ({@link ACROSS_DEFAULT_RELAYER}).
   */
  relayer?: Address;
  /**
   * The amount to deliver. Default: the deposit's `outputAmount`, which is what a real relayer
   * must deliver. Override it to model a different fee or slippage, e.g.
   * `(d) => across.outputAmount(d.args.inputAmount, { bps: 4 })`. The fill then carries this
   * amount in its relay data (so its relay hash differs from the deposit's; the destination
   * SpokePool does not check it against the origin).
   */
  outputAmount?: (deposit: AcrossDeposit) => bigint;
  /** Chain the relayer asks to be repaid on. Default: the destination chain. */
  repaymentChainId?: number | ((deposit: AcrossDeposit) => number);
  /**
   * Which deposit events to watch. Default both: `FundsDeposited` (current SpokePools) and
   * `V3FundsDeposited` (SpokePools before the bytes32 upgrade, for forks pinned at old blocks).
   * Deposits of the first event listed settle first.
   */
  events?: readonly AcrossDepositEvent[];
}

/** The default relayer: derived from a hash, so no one holds its key or anything at it. */
export const ACROSS_DEFAULT_RELAYER: Address = getAddress(
  slice(keccak256(toHex("forkit across relayer")), 12),
);

/** Native balance the relayer is topped up to when it has less than 1 ether, for gas. */
const RELAYER_GAS = parseEther("10");

/** `outputAmount = inputAmount - fee`, with `fee = inputAmount * bps / 10_000 + fixed`. */
export function acrossOutputAmount(inputAmount: bigint, fee: AcrossFeeConfig = {}): bigint {
  const out = inputAmount - acrossFee(inputAmount, fee);
  if (out < 0n)
    throw new ForkitError(`forkit: the Across fee exceeds the input amount (${inputAmount})`);
  return out;
}

/** The fee `acrossOutputAmount` subtracts: `inputAmount * bps / 10_000 + fixed` (rounded down). */
export function acrossFee(inputAmount: bigint, fee: AcrossFeeConfig = {}): bigint {
  const bps = BigInt(fee.bps ?? 0);
  const fixed = fee.fixed ?? 0n;
  if (bps < 0n || fixed < 0n) throw new ForkitError("forkit: an Across fee cannot be negative");
  return (inputAmount * bps) / 10_000n + fixed;
}

/** An EVM address from a bytes32 or address field. */
function toAddress(value: Hex): Address {
  return getAddress(value.length === 66 ? slice(value, 12) : value);
}

/** Normalise the decoded args of either deposit event. */
export function decodeAcrossDeposit(
  event: AcrossDepositEvent,
  args: Record<string, unknown>,
): AcrossDepositArgs {
  const hex = (name: string) => args[name] as Hex;
  const int = (name: string) => BigInt(args[name] as bigint | number);
  return {
    event,
    depositor: toAddress(hex("depositor")),
    recipient: toAddress(hex("recipient")),
    inputToken: toAddress(hex("inputToken")),
    outputToken: toAddress(hex("outputToken")),
    inputAmount: int("inputAmount"),
    outputAmount: int("outputAmount"),
    destinationChainId: int("destinationChainId"),
    depositId: int("depositId"),
    quoteTimestamp: Number(args.quoteTimestamp),
    fillDeadline: Number(args.fillDeadline),
    exclusivityDeadline: Number(args.exclusivityDeadline),
    exclusiveRelayer: toAddress(hex("exclusiveRelayer")),
    message: hex("message"),
  };
}

/** `V3RelayData` for `fillRelay` (bytes32 addresses). */
export function acrossRelayData(
  args: AcrossDepositArgs,
  originChainId: number,
  outputAmount: bigint = args.outputAmount,
) {
  const b32 = (a: Address) => pad(a, { size: 32 });
  return {
    depositor: b32(args.depositor),
    recipient: b32(args.recipient),
    exclusiveRelayer: b32(args.exclusiveRelayer),
    inputToken: b32(args.inputToken),
    outputToken: b32(args.outputToken),
    inputAmount: args.inputAmount,
    outputAmount,
    originChainId: BigInt(originChainId),
    depositId: args.depositId,
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    message: args.message,
  };
}

/** `V3RelayDataLegacy` for `fillV3Relay` (addresses, uint32 depositId). */
export function acrossLegacyRelayData(
  args: AcrossDepositArgs,
  originChainId: number,
  outputAmount: bigint = args.outputAmount,
) {
  if (args.depositId >= 2n ** 32n)
    throw new ForkitError(
      `forkit: Across deposit id ${args.depositId} does not fit fillV3Relay's uint32`,
    );
  return {
    depositor: args.depositor,
    recipient: args.recipient,
    exclusiveRelayer: args.exclusiveRelayer,
    inputToken: args.inputToken,
    outputToken: args.outputToken,
    inputAmount: args.inputAmount,
    outputAmount,
    originChainId: BigInt(originChainId),
    depositId: Number(args.depositId),
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    message: args.message,
  };
}

/**
 * Who fills: the deposit's exclusive relayer while its window may still be open at `now` (the
 * destination's latest block time; the SpokePool treats `exclusivityDeadline >= block.timestamp`
 * as exclusive, and the exclusive relayer may fill after the window too, so erring towards it is
 * safe), otherwise `fallback`.
 */
export function chooseAcrossRelayer(
  args: Pick<AcrossDepositArgs, "exclusiveRelayer" | "exclusivityDeadline">,
  now: bigint | number,
  fallback: Address,
): { relayer: Address; exclusive: boolean } {
  const open =
    !isAddressEqual(args.exclusiveRelayer, zeroAddress) &&
    BigInt(args.exclusivityDeadline) >= BigInt(now);
  return open
    ? { relayer: args.exclusiveRelayer, exclusive: true }
    : { relayer: fallback, exclusive: false };
}

/** The SpokePool table: the built-in one with the caller's overrides. */
function spokePoolTable(options: AcrossOptions): Record<number, Address> {
  return { ...ACROSS_SPOKE_POOLS, ...options.spokePools };
}

/** Origin chain ids to watch, with clear errors for the ones Across cannot serve. */
export function acrossOrigins(
  forkedChainIds: readonly number[],
  options: AcrossOptions = {},
): number[] {
  const pools = spokePoolTable(options);
  if (options.origins !== undefined) {
    for (const id of options.origins) {
      if (pools[id] === undefined)
        throw new ForkitError(
          `forkit: bridge.across has no SpokePool for origin chain ${id}. Pass it with spokePools: { ${id}: "0x…" } (addresses: https://docs.across.to/reference/contract-addresses).`,
        );
    }
    return [...options.origins];
  }
  const origins = forkedChainIds.filter((id) => pools[id] !== undefined);
  if (origins.length === 0)
    throw new ForkitError(
      `forkit: bridge.across knows no SpokePool on any forked chain (${forkedChainIds.join(", ")}). Pass spokePools: { <chainId>: "0x…" } (addresses: https://docs.across.to/reference/contract-addresses).`,
    );
  return origins;
}

/** Fill one deposit on its destination fork. */
async function fill(
  { deposit, destination }: FillContext<AcrossDepositArgs>,
  options: AcrossOptions,
): Promise<FillResult> {
  const args = deposit.args;
  const spokePool = spokePoolTable(options)[deposit.destinationChainId];
  if (spokePool === undefined)
    throw new ForkitError(
      `forkit: Across deposit ${deposit.id} goes to chain ${deposit.destinationChainId}, which has no known SpokePool. Pass spokePools: { ${deposit.destinationChainId}: "0x…" }.`,
    );
  if (isAddressEqual(args.outputToken, zeroAddress))
    throw new ForkitError(
      `forkit: Across deposit ${deposit.id} has no output token; the simulator cannot pick one.`,
    );
  const latest = await destination.client.getBlock();
  if (BigInt(args.fillDeadline) < latest.timestamp)
    throw new ForkitError(
      `forkit: Across deposit ${deposit.id} expired on chain ${deposit.destinationChainId}: its fillDeadline ${args.fillDeadline} is before the destination fork's time ${latest.timestamp}. Pin the forks at nearby times.`,
    );

  const delivered = options.outputAmount?.(deposit) ?? args.outputAmount;
  if (delivered < 0n)
    throw new ForkitError(`forkit: Across outputAmount for ${deposit.id} is negative`);
  const { relayer, exclusive } = chooseAcrossRelayer(
    args,
    latest.timestamp,
    options.relayer ?? ACROSS_DEFAULT_RELAYER,
  );
  const repaymentChainId =
    typeof options.repaymentChainId === "function"
      ? options.repaymentChainId(deposit)
      : (options.repaymentChainId ?? deposit.destinationChainId);

  await fund(destination, relayer, args.outputToken, delivered);
  const legacy = args.event === "V3FundsDeposited";
  const txHashes = await destination.prank(relayer, async (c) => {
    const hashes: Hex[] = [];
    const allowance = await c.readContract({
      address: args.outputToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [relayer, spokePool],
    });
    if (allowance < delivered) {
      // Tokens like USDT refuse a non-zero to non-zero approve.
      if (allowance > 0n)
        hashes.push(
          await c.writeContract({
            address: args.outputToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [spokePool, 0n],
          }),
        );
      hashes.push(
        await c.writeContract({
          address: args.outputToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [spokePool, maxUint256],
        }),
      );
    }
    hashes.push(
      legacy
        ? await c.writeContract({
            address: spokePool,
            abi: spokePoolAbi,
            functionName: "fillV3Relay",
            args: [
              acrossLegacyRelayData(args, deposit.originChainId, delivered),
              BigInt(repaymentChainId),
            ],
          })
        : await c.writeContract({
            address: spokePool,
            abi: spokePoolAbi,
            functionName: "fillRelay",
            args: [
              acrossRelayData(args, deposit.originChainId, delivered),
              BigInt(repaymentChainId),
              pad(relayer, { size: 32 }),
            ],
          }),
    );
    return hashes;
  });

  const details: AcrossFillDetails = {
    fee: args.inputAmount - delivered,
    depositOutputAmount: args.outputAmount,
    relayer,
    exclusive,
    repaymentChainId,
    spokePool,
    fillFunction: legacy ? "fillV3Relay" : "fillRelay",
  };
  return { txHashes, outputAmount: delivered, details: { ...details } };
}

/** Give `relayer` `amount` more of `token`, and gas money if it is short. */
async function fund(destination: Fork, relayer: Address, token: Address, amount: bigint) {
  const held = await destination.client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [relayer],
  });
  await destination.deal(token, relayer, held + amount);
  const gas = await destination.client.getBalance({ address: relayer });
  if (gas < parseEther("1")) await destination.dealNative(relayer, RELAYER_GAS);
}

/** Presents core deposits and fills with normalised args; one view object per deposit or fill. */
class Views {
  readonly #deposits = new WeakMap<Deposit, AcrossDeposit>();
  readonly #fills = new WeakMap<Fill, AcrossFill>();

  deposit(event: AcrossDepositEvent, d: Deposit): AcrossDeposit {
    let v = this.#deposits.get(d);
    if (v === undefined) {
      v = { ...d, address: getAddress(d.address), args: decodeAcrossDeposit(event, d.args) };
      this.#deposits.set(d, v);
    }
    return v;
  }

  fill(event: AcrossDepositEvent, x: Fill): AcrossFill {
    let v = this.#fills.get(x);
    if (v === undefined) {
      v = { ...x, deposit: this.deposit(event, x.deposit) };
      this.#fills.set(x, v);
    }
    return v;
  }
}

/** Merge per-event simulators into one. Deposits of the first part settle first. */
function merge(
  parts: readonly { event: AcrossDepositEvent; sim: BridgeSimulator }[],
  views: Views,
): BridgeSimulator<AcrossDepositArgs> {
  return {
    get pending() {
      return parts.flatMap(({ event, sim }) => sim.pending.map((d) => views.deposit(event, d)));
    },
    get fills() {
      return parts.flatMap(({ event, sim }) => sim.fills.map((x) => views.fill(event, x)));
    },
    async poll() {
      const found: AcrossDeposit[] = [];
      for (const { event, sim } of parts)
        found.push(...(await sim.poll()).map((d) => views.deposit(event, d)));
      return found;
    },
    async settle() {
      const made: AcrossFill[] = [];
      for (const { event, sim } of parts)
        made.push(...(await sim.settle()).map((x) => views.fill(event, x)));
      return made;
    },
  };
}

function acrossSimulator(
  f: MultiFork,
  options: AcrossOptions = {},
): BridgeSimulator<AcrossDepositArgs> {
  const pools = spokePoolTable(options);
  const origins = acrossOrigins(
    f.forks.map((m) => m.chain.id),
    options,
  );
  const address = Object.fromEntries(origins.map((id) => [id, pools[id] as Address]));
  const events = options.events ?? ["FundsDeposited", "V3FundsDeposited"];
  if (events.length === 0)
    throw new ForkitError("forkit: bridge.across needs at least one deposit event");
  const views = new Views();
  return merge(
    events.map((event) => ({
      event,
      sim: custom(f, {
        originEvent: { event: getAbiItem({ abi: spokePoolAbi, name: event }), address },
        destinationOf: (args: Record<string, unknown>) => args.destinationChainId as bigint,
        onDeposit: (context) =>
          fill({ ...context, deposit: views.deposit(event, context.deposit) }, options),
      }),
    })),
    views,
  );
}

/**
 * Across relayer simulator on a multi-chain fork, e.g. `fork([arbitrum, base])`.
 *
 * ```ts
 * const b = bridge.across(f);
 * // ... deposit into the origin SpokePool ...
 * const [fill] = await b.settle();
 * fill.outputAmount; // delivered to the recipient on the destination fork
 * fill.details?.fee; // inputAmount - delivered
 * ```
 *
 * Helpers: `across.outputAmount(inputAmount, { bps, fixed })` computes a deposit's
 * `outputAmount`, `across.fee(...)` the fee it subtracts, `across.spokePools` is the address table.
 */
export const across = Object.assign(acrossSimulator, {
  outputAmount: acrossOutputAmount,
  fee: acrossFee,
  spokePools: ACROSS_SPOKE_POOLS,
  defaultRelayer: ACROSS_DEFAULT_RELAYER,
});
