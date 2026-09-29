import {
  type Abi,
  type Address,
  type Chain,
  type Client,
  createTestClient,
  encodeDeployData,
  encodeFunctionData,
  type Hex,
  type HttpTransport,
  http,
  numberToHex,
  type ParseAccount,
  type PublicActions,
  publicActions,
  type TestActions,
  type TestRpcSchema,
  type WalletActions,
  walletActions,
} from "viem";
import { emitForkitEvent, hasForkitListeners, type TxLog, type TxSentEvent } from "./events.ts";
import { registerAbi } from "./labels.ts";
import { isRevertError } from "./revert.ts";
import { formatTrace, type RpcCallRequest, traceCall } from "./trace.ts";

/** Untyped JSON-RPC escape hatch for anvil methods viem does not type (e.g. `anvil_dealERC20`). */
export type RawRequest = (args: {
  method: string;
  params?: readonly unknown[];
}) => Promise<unknown>;

export function rawRequest(client: { request: unknown }): RawRequest {
  return client.request as RawRequest;
}

/** The fields forkit reads from `sendTransaction` / `writeContract` / `deployContract` args. */
interface TxArgs {
  account?: Address | { address: Address } | null;
  to?: Address | null;
  data?: Hex;
  value?: bigint;
  address?: Address;
  abi?: Abi;
  functionName?: string;
  args?: readonly unknown[];
  bytecode?: Hex;
}

function addressOf(account: TxArgs["account"]): Address | undefined {
  if (account === null || account === undefined) return undefined;
  return typeof account === "string" ? account : account.address;
}

/** Property name of the formatted trace forkit attaches to a reverted transaction's error. */
export const TRACE_PROPERTY = "forkitTrace";

/** The trace forkit attached to an error, if any (see `traces` in fork options). */
export function traceOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const trace = (error as Record<string, unknown>)[TRACE_PROPERTY];
  return typeof trace === "string" ? trace : undefined;
}

async function attachTrace(
  request: RawRequest,
  error: unknown,
  call: () => RpcCallRequest,
): Promise<void> {
  if (!(error instanceof Error) || traceOf(error) !== undefined || !isRevertError(error)) return;
  let trace: string;
  try {
    trace = formatTrace(await traceCall(request, call()));
  } catch {
    return; // Tracing is best effort; the original error is what matters.
  }
  Object.defineProperty(error, TRACE_PROPERTY, { value: trace, enumerable: false });
  const before = error.message;
  error.message = `${before}\n\nTrace (forkit, replayed with debug_traceCall):\n${trace
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`;
  // A function replacement: `$&` and friends in a revert reason must stay literal.
  if (error.stack?.includes(before)) error.stack = error.stack.replace(before, () => error.message);
}

async function nonceOf(request: RawRequest, account: Address): Promise<bigint> {
  return BigInt(
    (await request({ method: "eth_getTransactionCount", params: [account, "latest"] })) as Hex,
  );
}

const NONCE_WAIT_MS = 10_000;

/** With automine on, wait (bounded) until `account`'s nonce is past `before`. */
async function waitForNonce(
  request: RawRequest,
  account: Address,
  before: bigint,
  warn: (message: string) => void,
): Promise<void> {
  if ((await request({ method: "anvil_getAutomine" })) !== true) return;
  const deadline = Date.now() + NONCE_WAIT_MS;
  while ((await nonceOf(request, account)) <= before) {
    if (Date.now() >= deadline) {
      warn(
        `forkit: ${account}'s transaction was sent, but its nonce had not moved after ${NONCE_WAIT_MS}ms; reads right after it may not see it.`,
      );
      return;
    }
    await new Promise((ok) => setTimeout(ok, 5));
  }
}

interface RpcReceipt {
  status: Hex;
  from: Address;
  to: Address | null;
  contractAddress?: Address | null;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  logs: { address: Address; topics: Hex[]; data: Hex; logIndex: Hex }[];
}

const RECEIPT_TRIES = 20;

/**
 * Read a just-sent transaction's receipt and emit `tx:mined`, for reporters and run records. It
 * runs inside the test, before the per-test `evm_revert` after which anvil may not find the
 * transaction. Best effort: with automine off (no receipt yet) or on any error, nothing is emitted.
 */
async function emitMined(request: RawRequest, chainId: number, url: string, hash: Hex) {
  try {
    if ((await request({ method: "anvil_getAutomine" })) !== true) return;
    let receipt: RpcReceipt | null = null;
    for (let i = 0; i < RECEIPT_TRIES && receipt === null; i++) {
      if (i > 0) await new Promise((ok) => setTimeout(ok, 5));
      receipt = (await request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })) as RpcReceipt | null;
    }
    if (receipt === null) return;
    const logs: TxLog[] = receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: Number(BigInt(log.logIndex)),
    }));
    emitForkitEvent({
      type: "tx:mined",
      ts: Date.now(),
      chainId,
      rpcUrl: url,
      hash,
      status: BigInt(receipt.status) === 1n ? "success" : "reverted",
      from: receipt.from,
      ...(receipt.to === null ? {} : { to: receipt.to }),
      ...(receipt.contractAddress ? { contractAddress: receipt.contractAddress } : {}),
      blockNumber: BigInt(receipt.blockNumber),
      gasUsed: BigInt(receipt.gasUsed),
      effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? "0x0"),
      logs,
    });
  } catch {
    // Observability must never break a write.
  }
}

/** The event fields that describe a write: from, to, calldata, value, function name. */
function describeTx(
  args: TxArgs,
  from: Address | undefined,
  toCall: (args: TxArgs) => Omit<RpcCallRequest, "from" | "value">,
): Pick<TxSentEvent, "from" | "to" | "data" | "value" | "functionName"> {
  let call: Omit<RpcCallRequest, "from" | "value"> = {};
  try {
    call = toCall(args);
  } catch {
    // Unencodable args: the send itself will say why; the event just lacks calldata.
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(call.to === undefined ? {} : { to: call.to }),
    ...(call.data === undefined ? {} : { data: call.data }),
    ...(args.value === undefined ? {} : { value: args.value }),
    ...(args.functionName === undefined ? {} : { functionName: args.functionName }),
  };
}

/**
 * The client {@link createForkClient} returns, spelled with viem's public types so that the
 * published declarations name it instead of reaching into viem's internal modules.
 */
export type ForkClientOf<TChain extends Chain, TAccount extends Address | undefined> = Client<
  HttpTransport,
  TChain,
  ParseAccount<TAccount>,
  TestRpcSchema<"anvil">,
  { mode: "anvil" } & TestActions &
    PublicActions<HttpTransport, TChain, ParseAccount<TAccount>> &
    WalletActions<TChain, ParseAccount<TAccount>>
>;

/** Build the viem client forkit hands out: test + public + wallet actions over one anvil. */
export function createForkClient<
  TChain extends Chain,
  TAccount extends Address | undefined = undefined,
>(
  chain: TChain,
  url: string,
  account?: TAccount,
  traces = true,
  warn: (message: string) => void = (message) => console.warn(message),
): ForkClientOf<TChain, TAccount> {
  const base = createTestClient({
    mode: "anvil",
    chain,
    account,
    transport: http(url),
    // anvil automines, so poll fast and never serve a cached block number after warp/roll.
    pollingInterval: 50,
    cacheTime: 0,
  })
    .extend(publicActions)
    .extend(walletActions);

  // Wrap the three ways to send a transaction:
  // - register the ABI, so traces and errors decode;
  // - unless the caller set `gas`, estimate it and send with it, as viem does for local
  //   accounts and a real node does for eth_sendTransaction. anvil mines an unsigned
  //   (impersonated) transaction even when it reverts, returning its hash, so without the
  //   estimate a revert would pass silently; and anvil 1.8 runs a gas-less unsigned transaction
  //   with too little gas. An explicit `gas` skips this, for tests that want a reverted
  //   transaction mined;
  // - with automine on, wait until the sender's nonce moves before returning the hash. anvil 1.8
  //   can answer eth_sendTransaction before the mined state is visible, and a test reading
  //   state right after a write must see the write. (Not the receipt: after evm_revert, anvil
  //   1.8 sometimes never finds the transaction by hash.)
  // - on a revert, replay the call with debug_traceCall and attach the decoded trace.
  const request = rawRequest(base);
  const defaultFrom = addressOf(base.account);
  const estimateGas = base.estimateGas as unknown as (args: object) => Promise<bigint>;
  const estimateContractGas = base.estimateContractGas as unknown as (
    args: object,
  ) => Promise<bigint>;
  const wrap = <F>(
    kind: TxSentEvent["kind"],
    action: F,
    toCall: (args: TxArgs) => Omit<RpcCallRequest, "from" | "value">,
    estimate: (args: TxArgs, account: Address) => Promise<bigint>,
  ): F => {
    const send = action as unknown as (args: TxArgs) => Promise<unknown>;
    return (async (args: TxArgs) => {
      if (args.abi !== undefined) registerAbi(args.abi);
      const from = addressOf(args.account) ?? defaultFrom;
      try {
        const gas = (args as { gas?: unknown }).gas;
        const sendArgs =
          gas === undefined && from !== undefined
            ? ({ ...args, gas: await estimate(args, from) } as TxArgs)
            : args;
        const nonce = from === undefined ? undefined : await nonceOf(request, from);
        const hash = (await send(sendArgs)) as Hex;
        emitForkitEvent({
          type: "tx:sent",
          ts: Date.now(),
          chainId: chain.id,
          rpcUrl: url,
          hash,
          kind,
          ...describeTx(args, from, toCall),
        });
        if (from !== undefined && nonce !== undefined)
          await waitForNonce(request, from, nonce, warn);
        if (hasForkitListeners()) await emitMined(request, chain.id, url, hash);
        return hash;
      } catch (error) {
        if (traces) {
          await attachTrace(request, error, () => ({
            ...(from === undefined ? {} : { from }),
            ...(args.value === undefined ? {} : { value: numberToHex(args.value) }),
            ...toCall(args),
          }));
        }
        if (isRevertError(error)) {
          emitForkitEvent({
            type: "tx:reverted",
            ts: Date.now(),
            chainId: chain.id,
            rpcUrl: url,
            kind,
            ...describeTx(args, from, toCall),
            message: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
            ...(traceOf(error) === undefined ? {} : { trace: traceOf(error) as string }),
          });
        }
        throw error;
      }
    }) as unknown as F;
  };
  const deployData = (a: TxArgs): Hex =>
    encodeDeployData({ abi: a.abi ?? [], bytecode: a.bytecode ?? "0x", args: a.args ?? [] });
  return base.extend(() => ({
    sendTransaction: wrap(
      "sendTransaction",
      base.sendTransaction,
      (a) => ({
        ...(a.to ? { to: a.to } : {}),
        ...(a.data === undefined ? {} : { data: a.data }),
      }),
      (a, account) => estimateGas({ ...a, account }),
    ),
    writeContract: wrap(
      "writeContract",
      base.writeContract,
      (a) => ({
        ...(a.address === undefined ? {} : { to: a.address }),
        data: encodeFunctionData({
          abi: a.abi ?? [],
          functionName: a.functionName ?? "",
          args: a.args ?? [],
        }),
      }),
      (a, account) => estimateContractGas({ ...a, account }),
    ),
    deployContract: wrap(
      "deployContract",
      base.deployContract,
      (a) => ({ data: deployData(a) }),
      (a, account) =>
        estimateGas({
          account,
          data: deployData(a),
          ...(a.value === undefined ? {} : { value: a.value }),
        }),
    ),
  }));
}

/** viem client with test, public and wallet actions, bound to one fork. */
export type ForkClient<TChain extends Chain = Chain> = ForkClientOf<TChain, undefined>;

/** A {@link ForkClient} whose default account is an impersonated address (see `prank`). */
export type PrankClient<TChain extends Chain = Chain> = ForkClientOf<TChain, Address>;
