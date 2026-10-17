import { createTestClient, encodeDeployData, encodeFunctionData, http, numberToHex, publicActions, walletActions, } from "viem";
import { emitForkitEvent, hasForkitListeners } from "./events.js";
import { registerAbi } from "./labels.js";
import { isRevertError } from "./revert.js";
import { formatTrace, traceCall } from "./trace.js";
export function rawRequest(client) {
    return client.request;
}
function addressOf(account) {
    if (account === null || account === undefined)
        return undefined;
    return typeof account === "string" ? account : account.address;
}
/** Property name of the formatted trace forkit attaches to a reverted transaction's error. */
export const TRACE_PROPERTY = "forkitTrace";
/** The trace forkit attached to an error, if any (see `traces` in fork options). */
export function traceOf(error) {
    if (typeof error !== "object" || error === null)
        return undefined;
    const trace = error[TRACE_PROPERTY];
    return typeof trace === "string" ? trace : undefined;
}
async function attachTrace(request, error, call) {
    if (!(error instanceof Error) || traceOf(error) !== undefined || !isRevertError(error))
        return;
    let trace;
    try {
        trace = formatTrace(await traceCall(request, call()));
    }
    catch {
        return; // Tracing is best effort; the original error is what matters.
    }
    Object.defineProperty(error, TRACE_PROPERTY, { value: trace, enumerable: false });
    const before = error.message;
    error.message = `${before}\n\nTrace (forkit, replayed with debug_traceCall):\n${trace
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`;
    // A function replacement: `$&` and friends in a revert reason must stay literal.
    if (error.stack?.includes(before))
        error.stack = error.stack.replace(before, () => error.message);
}
async function nonceOf(request, account) {
    return BigInt((await request({ method: "eth_getTransactionCount", params: [account, "latest"] })));
}
const NONCE_WAIT_MS = 10_000;
/** With automine on, wait (bounded) until `account`'s nonce is past `before`. */
async function waitForNonce(request, account, before, warn) {
    if ((await request({ method: "anvil_getAutomine" })) !== true)
        return;
    const deadline = Date.now() + NONCE_WAIT_MS;
    while ((await nonceOf(request, account)) <= before) {
        if (Date.now() >= deadline) {
            warn(`forkit: ${account}'s transaction was sent, but its nonce had not moved after ${NONCE_WAIT_MS}ms; reads right after it may not see it.`);
            return;
        }
        await new Promise((ok) => setTimeout(ok, 5));
    }
}
const RECEIPT_TRIES = 20;
/**
 * Read a just-sent transaction's receipt and emit `tx:mined`, for reporters and run records. It
 * runs inside the test, before the per-test `evm_revert` after which anvil may not find the
 * transaction. Best effort: with automine off (no receipt yet) or on any error, nothing is emitted.
 */
async function emitMined(request, chainId, url, hash) {
    try {
        if ((await request({ method: "anvil_getAutomine" })) !== true)
            return;
        let receipt = null;
        for (let i = 0; i < RECEIPT_TRIES && receipt === null; i++) {
            if (i > 0)
                await new Promise((ok) => setTimeout(ok, 5));
            receipt = (await request({
                method: "eth_getTransactionReceipt",
                params: [hash],
            }));
        }
        if (receipt === null)
            return;
        const logs = receipt.logs.map((log) => ({
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
    }
    catch {
        // Observability must never break a write.
    }
}
/** The event fields that describe a write: from, to, calldata, value, function name. */
function describeTx(args, from, toCall) {
    let call = {};
    try {
        call = toCall(args);
    }
    catch {
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
/** Build the viem client forkit hands out: test + public + wallet actions over one anvil. */
export function createForkClient(chain, url, account, traces = true, warn = (message) => console.warn(message)) {
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
    const estimateGas = base.estimateGas;
    const estimateContractGas = base.estimateContractGas;
    const wrap = (kind, action, toCall, estimate) => {
        const send = action;
        return (async (args) => {
            if (args.abi !== undefined)
                registerAbi(args.abi);
            const from = addressOf(args.account) ?? defaultFrom;
            try {
                const gas = args.gas;
                const sendArgs = gas === undefined && from !== undefined
                    ? { ...args, gas: await estimate(args, from) }
                    : args;
                const nonce = from === undefined ? undefined : await nonceOf(request, from);
                const hash = (await send(sendArgs));
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
                if (hasForkitListeners())
                    await emitMined(request, chain.id, url, hash);
                return hash;
            }
            catch (error) {
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
                        ...(traceOf(error) === undefined ? {} : { trace: traceOf(error) }),
                    });
                }
                throw error;
            }
        });
    };
    const deployData = (a) => encodeDeployData({ abi: a.abi ?? [], bytecode: a.bytecode ?? "0x", args: a.args ?? [] });
    return base.extend(() => ({
        sendTransaction: wrap("sendTransaction", base.sendTransaction, (a) => ({
            ...(a.to ? { to: a.to } : {}),
            ...(a.data === undefined ? {} : { data: a.data }),
        }), (a, account) => estimateGas({ ...a, account })),
        writeContract: wrap("writeContract", base.writeContract, (a) => ({
            ...(a.address === undefined ? {} : { to: a.address }),
            data: encodeFunctionData({
                abi: a.abi ?? [],
                functionName: a.functionName ?? "",
                args: a.args ?? [],
            }),
        }), (a, account) => estimateContractGas({ ...a, account })),
        deployContract: wrap("deployContract", base.deployContract, (a) => ({ data: deployData(a) }), (a, account) => estimateGas({
            account,
            data: deployData(a),
            ...(a.value === undefined ? {} : { value: a.value }),
        })),
    }));
}
//# sourceMappingURL=client.js.map