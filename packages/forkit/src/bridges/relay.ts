/**
 * `bridge.relay(f)`: a simulated Relay solver for cross-chain tests on a multi-chain fork.
 *
 * On-chain, a Relay deposit today is a call into the RelayDepository on the origin chain:
 * `depositNative(depositor, id)` or `depositErc20(depositor, token, amount, id)`, emitting
 * `RelayNativeDeposit(from, amount, id)` or `RelayErc20Deposit(from, token, amount, id)`, where the
 * `bytes32 id` is the quote's `protocol.v2.orderId` (https://docs.relay.link/references/protocol/guides/for-apps).
 * The older RelayReceiver (`FundsForwardedWithData(bytes data)`) is still deployed and can be
 * watched with `receiver: true`.
 *
 * What the solver pays on the destination is not in the deposit: it lives in the order
 * (`protocol.v2.orderData.output` of the quote). So a test registers each fill it expects, either by
 * hand (`b.expect(orderId, { destinationChainId, recipient, currency, amount })`) or from a quote
 * response (`b.expectQuote(quote)`). On `settle()`, for each deposit, an impersonated and funded solver
 * pays the recipient on the destination fork (a native transfer or an ERC-20 `transfer`), then runs
 * the order's calls, if any, through Relay's router `multicall`, as Relay's quotes route them.
 * See docs/bridges-relay.md.
 */
import {
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  parseEther,
  slice,
  toHex,
} from "viem";
import type { Fork } from "../types.ts";
import {
  type BridgeSimulator,
  custom,
  type Deposit,
  type Fill,
  type FillContext,
  type FillResult,
  handleFor,
  type MultiFork,
} from "./core.ts";
import {
  fundsForwardedWithDataEvent,
  RELAY_CHAINS,
  RELAY_DEPOSITORY,
  RELAY_NATIVE,
  RELAY_RECEIVER,
  RELAY_ROUTER,
  relayDepositoryAbi,
  relayErc20DepositEvent,
  relayNativeDepositEvent,
  relayReceiverAbi,
  relayRouterAbi,
} from "./relay-contracts.ts";
import {
  decodeRelayDeposit,
  type FillFromQuoteOptions,
  fillFromQuote,
  planRelayFill,
  type RelayDepositArgs,
  type RelayDepositKind,
  type RelayFee,
  type RelayFill,
  RelayFillError,
  type RelayFillPlan,
  type RelayQuoteLike,
  relayKey,
} from "./relay-plan.ts";

export type {
  FillFromQuoteOptions,
  RelayAmountContext,
  RelayCall,
  RelayDepositArgs,
  RelayDepositKind,
  RelayFee,
  RelayFill,
  RelayFillPlan,
  RelayQuoteLike,
} from "./relay-plan.ts";
export { RelayFillError } from "./relay-plan.ts";

/** Where contracts live, per chain id. */
type AddressMap = Readonly<Record<number, Address | readonly Address[]>>;

export interface RelayOptions {
  /** The solver that fills on the destination (impersonated and funded). Default {@link DEFAULT_RELAY_SOLVER}. */
  solver?: Address;
  /** Fee for fills whose output is the default `inputAmount - fee`. Default 0. */
  fee?: RelayFee;
  /** Fills to expect, by order id (or receiver data). Same as calling `b.expect` for each. */
  fills?: Readonly<Record<string, RelayFill>>;
  /** Relay quote responses to expect. Same as calling `b.expectQuote` for each. */
  quotes?: readonly RelayQuoteLike[];
  /**
   * The RelayDepository to watch per origin chain id. Default: Relay's depository on every chain of
   * the fork where its address is known (Ethereum, Optimism, Base, Arbitrum).
   */
  depository?: AddressMap;
  /**
   * Also watch the older RelayReceiver: `true` for its known address on the fork's chains, or a map.
   * Default `false`: Relay's current quotes deposit into the depository.
   */
  receiver?: boolean | AddressMap;
  /** Relay's router per destination chain id, which runs a fill's calls. Merged over the defaults. */
  router?: Readonly<Record<number, Address>>;
}

/** What a Relay fill reports in `Fill.details`. */
export interface RelayFillDetails {
  /** The deposit's order id (or receiver data). */
  orderId: Hex;
  kind: RelayDepositKind;
  solver: Address;
  depositor?: Address;
  inputToken: Address;
  inputAmount?: bigint;
  recipient: Address;
  currency: Address;
  outputAmount: bigint;
  /** Fee taken by the `inputAmount - fee` rule; absent when the fill set its amount. */
  fee?: bigint;
  minimumAmount?: bigint;
  /** How many calls the router ran. */
  calls: number;
  router?: Address;
}

export interface RelaySimulator extends BridgeSimulator<RelayDepositArgs> {
  /** The simulated solver's address on every destination. */
  readonly solver: Address;
  /**
   * Expect a deposit carrying `id` (the quote's `protocol.v2.orderId`; for receiver deposits, the
   * forwarded data) and say how to fill it. Throws if the destination chain is not in the fork.
   */
  expect(id: string, fill: RelayFill): RelaySimulator;
  /** Expect a Relay quote's order: its fill is read from `protocol.v2`. Resolves to the order id. */
  expectQuote(quote: RelayQuoteLike, options?: FillFromQuoteOptions): Hex;
}

/** Default solver: an address derived from a hash, so nothing holds funds there on real chains. */
export const DEFAULT_RELAY_SOLVER: Address = getAddress(
  slice(keccak256(toHex("forkit relay solver")), 12),
);

/** Native balance the solver gets on top of what it pays out, for gas. */
const SOLVER_GAS = parseEther("1");

/** Known addresses for the fork's chains, as an origin map for `custom()`. */
function knownOn(f: MultiFork, address: Address): Record<number, Address> {
  const map: Record<number, Address> = {};
  for (const m of f.forks) if (RELAY_CHAINS.includes(m.chain.id)) map[m.chain.id] = address;
  return map;
}

/** One origin event watched by its own `custom()` simulator. */
interface Watcher {
  kind: RelayDepositKind;
  sim: BridgeSimulator;
}

// Thrown by a watcher's onDeposit to stop its settle() after the one deposit allowed to fill, so
// deposits from different events are filled in one chronological order (see settle below).
const PAUSE = new Error("forkit relay: pause");

function relaySimulator(f: MultiFork, options: RelayOptions = {}): RelaySimulator {
  const solver = getAddress(options.solver ?? DEFAULT_RELAY_SOLVER);
  const fills = new Map<Hex, RelayFill>();
  const normalized = new Map<string, Deposit<RelayDepositArgs>>();
  const made: Fill<RelayDepositArgs>[] = [];
  const routers: Record<number, Address> = {
    ...Object.fromEntries(RELAY_CHAINS.map((id) => [id, RELAY_ROUTER])),
    ...options.router,
  };
  let allowed: string | undefined;

  const keyOf = (kind: RelayDepositKind, args: Record<string, unknown>): Hex =>
    relayKey((kind === "receiver" ? args.data : args.id) as Hex);

  const destinationOf = (kind: RelayDepositKind, args: Record<string, unknown>, origin: number) => {
    const key = keyOf(kind, args);
    const fill = fills.get(key);
    if (fill === undefined) {
      const known = [...fills.keys()];
      throw new RelayFillError(
        [
          `forkit: a Relay ${kind} deposit on chain ${origin} carries id ${key}, and no fill is registered for it.`,
          `Register it before settle(): b.expect("${key}", { destinationChainId, recipient, currency, amount }) or b.expectQuote(quote).`,
          `Registered: ${known.length === 0 ? "none" : known.join(", ")}.`,
        ].join("\n"),
      );
    }
    return fill.destinationChainId;
  };

  async function normalize(
    kind: RelayDepositKind,
    deposit: Deposit,
  ): Promise<Deposit<RelayDepositArgs>> {
    const cached = normalized.get(deposit.id);
    if (cached !== undefined) return cached;
    let txValue: bigint | undefined;
    if (kind === "receiver") {
      // The receiver's event has no amount: use the transaction's value when it called the receiver.
      const tx = await handleFor(f, deposit.originChainId, "origin").client.getTransaction({
        hash: deposit.txHash,
      });
      if (tx.to != null && isAddressEqual(tx.to, deposit.address)) txValue = tx.value;
    }
    const result = { ...deposit, args: decodeRelayDeposit(kind, deposit.args, txValue) };
    normalized.set(deposit.id, result);
    return result;
  }

  const normalizeSync = (kind: RelayDepositKind, deposit: Deposit): Deposit<RelayDepositArgs> =>
    normalized.get(deposit.id) ?? { ...deposit, args: decodeRelayDeposit(kind, deposit.args) };

  async function onDeposit(
    kind: RelayDepositKind,
    context: FillContext<Record<string, unknown>>,
  ): Promise<FillResult> {
    if (context.deposit.id !== allowed) throw PAUSE;
    allowed = undefined;
    const deposit = await normalize(kind, context.deposit);
    const fill = fills.get(deposit.args.id) as RelayFill;
    const destination = context.destination;
    const plan = planRelayFill(deposit.args, fill, {
      ...(options.fee === undefined ? {} : { fee: options.fee }),
      ...(routers[destination.chain.id] === undefined
        ? {}
        : { router: routers[destination.chain.id] }),
    });
    const txHashes = await executeFill(destination, solver, plan);
    const details: RelayFillDetails = {
      orderId: deposit.args.id,
      kind,
      solver,
      ...(deposit.args.from === undefined ? {} : { depositor: deposit.args.from }),
      inputToken: deposit.args.token,
      ...(deposit.args.amount === undefined ? {} : { inputAmount: deposit.args.amount }),
      recipient: plan.recipient,
      currency: plan.currency,
      outputAmount: plan.outputAmount,
      ...(plan.fee === undefined ? {} : { fee: plan.fee }),
      ...(plan.minimumAmount === undefined ? {} : { minimumAmount: plan.minimumAmount }),
      calls: plan.calls.length,
      ...(plan.router === undefined ? {} : { router: plan.router }),
    };
    return { txHashes, outputAmount: plan.outputAmount, details: { ...details } };
  }

  const watch = (kind: RelayDepositKind, address: AddressMap): Watcher[] => {
    if (Object.keys(address).length === 0) return [];
    const event =
      kind === "native"
        ? relayNativeDepositEvent
        : kind === "erc20"
          ? relayErc20DepositEvent
          : fundsForwardedWithDataEvent;
    const sim = custom<typeof event, Record<string, unknown>>(f, {
      originEvent: { event, address },
      destinationOf: (args, origin) => destinationOf(kind, args, origin),
      onDeposit: (context) => onDeposit(kind, context),
    });
    return [{ kind, sim }];
  };

  const depository = options.depository ?? knownOn(f, RELAY_DEPOSITORY);
  const receiver =
    options.receiver === true
      ? knownOn(f, RELAY_RECEIVER)
      : options.receiver === false || options.receiver === undefined
        ? {}
        : options.receiver;
  const watchers = [
    ...watch("native", depository),
    ...watch("erc20", depository),
    ...watch("receiver", receiver),
  ];
  if (watchers.length === 0) {
    throw new RelayFillError(
      `forkit: bridge.relay knows no Relay depository on this fork's chains (${f.forks
        .map((m) => m.chain.id)
        .join(", ")}); pass \`depository: { [chainId]: address }\``,
    );
  }

  const order = <T>(a: Deposit<T>, b: Deposit<T>) =>
    a.originChainId - b.originChainId ||
    Number(a.blockNumber - b.blockNumber) ||
    a.logIndex - b.logIndex;

  async function poll(): Promise<Deposit<RelayDepositArgs>[]> {
    const found: Deposit<RelayDepositArgs>[] = [];
    for (const w of watchers) {
      for (const d of await w.sim.poll()) found.push(await normalize(w.kind, d));
    }
    return found.sort(order);
  }

  async function settle(): Promise<Fill<RelayDepositArgs>[]> {
    await poll();
    const settled: Fill<RelayDepositArgs>[] = [];
    // Each event has its own watcher, and a watcher's settle() fills all of its pending deposits.
    // To fill across watchers in chain, block and log order, repeatedly pick the earliest head and
    // let only that deposit through: the watcher's next onDeposit throws PAUSE, stopping it there.
    for (;;) {
      let next: { w: Watcher; d: Deposit } | undefined;
      for (const w of watchers) {
        const d = w.sim.pending[0];
        if (d !== undefined && (next === undefined || order(d, next.d) < 0)) next = { w, d };
      }
      if (next === undefined) break;
      const { w, d } = next;
      const before = w.sim.fills.length;
      allowed = d.id;
      try {
        await w.sim.settle();
      } catch (error) {
        if (error !== PAUSE) throw error;
      } finally {
        allowed = undefined;
        for (const fill of w.sim.fills.slice(before)) {
          const done = { ...fill, deposit: normalizeSync(w.kind, fill.deposit) };
          made.push(done);
          settled.push(done);
        }
      }
      if (w.sim.fills.length === before) {
        throw new RelayFillError(`forkit: bridge.relay could not fill deposit ${d.id}`);
      }
    }
    return settled;
  }

  const simulator: RelaySimulator = {
    solver,
    get pending() {
      return watchers
        .flatMap((w) => w.sim.pending.map((d) => normalizeSync(w.kind, d)))
        .sort(order);
    },
    get fills() {
      return [...made];
    },
    poll,
    settle,
    expect(id, fill) {
      handleFor(f, fill.destinationChainId, "destination");
      getAddress(fill.recipient);
      getAddress(fill.currency);
      fills.set(relayKey(id), fill);
      return simulator;
    },
    expectQuote(quote, quoteOptions) {
      const { ids, fill } = fillFromQuote(quote, quoteOptions);
      for (const id of ids) simulator.expect(id, fill);
      return ids[0] as Hex;
    },
  };
  for (const [id, fill] of Object.entries(options.fills ?? {})) simulator.expect(id, fill);
  for (const quote of options.quotes ?? []) simulator.expectQuote(quote);
  return simulator;
}

/** Pay the recipient from a funded, impersonated solver, then run the calls through the router. */
async function executeFill(
  destination: Fork,
  solver: Address,
  plan: RelayFillPlan,
): Promise<Hex[]> {
  const native = isAddressEqual(plan.currency, RELAY_NATIVE);
  const callValue = plan.calls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  // When the router is the recipient (Relay's quotes do this for orders with calls), the payment
  // rides along with the multicall: native as its value, ERC-20 transferred to the router first.
  const viaRouter = plan.router !== undefined && isAddressEqual(plan.recipient, plan.router);
  // A native payment to the router funds the calls' values; otherwise the solver sends them.
  const multicallValue = viaRouter && native ? plan.outputAmount : callValue;
  const nativeSpend = (native && !viaRouter ? plan.outputAmount : 0n) + multicallValue;

  destination.label(solver, "RelaySolver (forkit)");
  if (plan.router !== undefined) destination.label(plan.router, "RelayRouter");
  const nativeBalance = await destination.client.getBalance({ address: solver });
  await destination.dealNative(solver, nativeBalance + nativeSpend + SOLVER_GAS);
  if (!native && plan.outputAmount > 0n) {
    const tokenBalance = await destination.client.readContract({
      address: plan.currency,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [solver],
    });
    await destination.deal(plan.currency, solver, tokenBalance + plan.outputAmount);
  }

  return destination.prank(solver, async (c) => {
    const hashes: Hex[] = [];
    if (plan.outputAmount > 0n && !(viaRouter && native)) {
      hashes.push(
        native
          ? await c.sendTransaction({ to: plan.recipient, value: plan.outputAmount })
          : await c.writeContract({
              address: plan.currency,
              abi: erc20Abi,
              functionName: "transfer",
              args: [plan.recipient, plan.outputAmount],
            }),
      );
    }
    if (plan.router !== undefined && plan.calls.length > 0) {
      hashes.push(
        await c.writeContract({
          address: plan.router,
          abi: relayRouterAbi,
          functionName: "multicall",
          args: [
            plan.calls.map((call) => ({
              target: call.to,
              allowFailure: false,
              value: call.value ?? 0n,
              callData: call.data,
            })),
            plan.refundTo,
            RELAY_NATIVE,
            "0x",
          ],
          value: multicallValue,
        }),
      );
    }
    return hashes;
  });
}

/**
 * Relay solver simulator. Watches Relay's origin depository on the fork's chains; on `settle()`, a
 * funded, impersonated solver pays each expected fill on its destination and runs its calls.
 *
 * ```ts
 * const b = bridge.relay(f, { fee: 50_000n });
 * b.expect(orderId, { destinationChainId: arbitrum.id, recipient, currency: USDC_ARB });
 * // ... deposit on Base with depositErc20(user, USDC_BASE, amount, orderId)
 * const [fill] = await b.settle(); // recipient got amount - 50_000 USDC on Arbitrum
 * ```
 */
export const relay = Object.assign(relaySimulator, {
  /** Read a fill out of a Relay quote response (see {@link fillFromQuote}). */
  fillFromQuote,
  /** Native currency in Relay's orders and deposits (the zero address). */
  NATIVE: RELAY_NATIVE,
  /** RelayDepository on Ethereum, Optimism, Base and Arbitrum. */
  DEPOSITORY: RELAY_DEPOSITORY,
  /** RelayReceiver (older deposit target) on the same chains. */
  RECEIVER: RELAY_RECEIVER,
  /** RelayRouterV3, which runs a fill's calls, on the same chains. */
  ROUTER: RELAY_ROUTER,
  depositoryAbi: relayDepositoryAbi,
  receiverAbi: relayReceiverAbi,
});
