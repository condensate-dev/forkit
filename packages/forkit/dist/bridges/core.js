import { parseEventLogs } from "viem";
import { ForkitError } from "../errors.js";
import { emitForkitEvent } from "../events.js";
/**
 * A bridge simulator for any bridge: name the origin deposit event and say how to fill it.
 * `bridge.across` and `bridge.relay` are built on this.
 */
export function custom(f, options) {
    const origins = Object.keys(options.originEvent.address).map(Number);
    for (const chainId of origins)
        handleFor(f, chainId, "origin");
    const pending = [];
    const fills = [];
    // Per origin chain: the block scanning started at and the last block scanned, each with its
    // hash; and every deposit seen, with its block. Heights alone cannot tell that a chain was
    // reverted and re-mined back to (or past) the same height; hashes can.
    const startedAt = new Map();
    const scanned = new Map();
    const seen = new Map();
    const headOf = async (origin) => {
        const block = await origin.client.getBlock();
        return { number: block.number, hash: block.hash };
    };
    const hashAt = async (origin, number) => {
        try {
            return (await origin.client.getBlock({ blockNumber: number })).hash;
        }
        catch {
            return undefined; // above the head after a revert
        }
    };
    const forget = (chainId, keep) => {
        for (const [id, mark] of seen)
            if (mark.chainId === chainId && !keep(mark))
                seen.delete(id);
        for (let i = pending.length - 1; i >= 0; i--) {
            const d = pending[i];
            if (d !== undefined && d.originChainId === chainId && !seen.has(d.id))
                pending.splice(i, 1);
        }
    };
    // Deposits made before the simulator existed are ignored: scanning starts at the head.
    const started = Promise.all(origins.map(async (chainId) => {
        const head = await headOf(handleFor(f, chainId, "origin"));
        startedAt.set(chainId, head);
        scanned.set(chainId, head);
    }));
    // A failed start surfaces from the next poll/settle, not as an unhandled rejection.
    started.catch(() => { });
    async function pollNow() {
        await started;
        const found = [];
        for (const chainId of origins) {
            const origin = handleFor(f, chainId, "origin");
            const head = await headOf(origin);
            const last = scanned.get(chainId);
            const first = startedAt.get(chainId);
            let from = last.number;
            if ((await hashAt(origin, last.number)) !== last.hash) {
                // The chain changed under us (an evm_revert, maybe re-mined since).
                if ((await hashAt(origin, first.number)) !== first.hash) {
                    // Reverted to before the simulator existed: nothing seen survives; start over here.
                    forget(chainId, () => false);
                    startedAt.set(chainId, head);
                    scanned.set(chainId, head);
                    continue;
                }
                // Keep the deposits whose blocks are still on chain, forget the rest, rescan.
                const hashes = new Map();
                for (const mark of seen.values()) {
                    if (mark.chainId === chainId && !hashes.has(mark.number)) {
                        hashes.set(mark.number, await hashAt(origin, mark.number));
                    }
                }
                forget(chainId, (mark) => hashes.get(mark.number) === mark.hash);
                from = first.number;
            }
            if (head.number > from) {
                const addresses = [options.originEvent.address[chainId] ?? []].flat();
                const logs = await origin.client.getLogs({
                    address: addresses,
                    event: options.originEvent.event,
                    fromBlock: from + 1n,
                    toBlock: head.number,
                });
                const parsed = parseEventLogs({ abi: [options.originEvent.event], logs: logs });
                for (const log of parsed) {
                    if (log.transactionHash === null ||
                        log.blockNumber === null ||
                        log.blockHash === null ||
                        log.logIndex === null)
                        continue;
                    const id = `${chainId}:${log.transactionHash}:${log.logIndex}`;
                    if (seen.has(id))
                        continue;
                    const args = log.args;
                    const deposit = {
                        id,
                        originChainId: chainId,
                        destinationChainId: Number(options.destinationOf(args, chainId)),
                        txHash: log.transactionHash,
                        blockNumber: log.blockNumber,
                        blockHash: log.blockHash,
                        logIndex: log.logIndex,
                        address: log.address,
                        args,
                    };
                    seen.set(id, { chainId, number: log.blockNumber, hash: log.blockHash });
                    pending.push(deposit);
                    found.push(deposit);
                }
            }
            scanned.set(chainId, head);
        }
        return found;
    }
    // poll and settle run one at a time, so two concurrent settles cannot fill one deposit twice.
    let queue = Promise.resolve();
    const serialized = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => { });
        return run;
    };
    const poll = () => serialized(pollNow);
    async function settleNow() {
        await pollNow();
        const made = [];
        while (pending.length > 0) {
            const deposit = pending[0];
            const destination = handleFor(f, deposit.destinationChainId, "destination");
            const result = await options.onDeposit({
                deposit,
                origin: handleFor(f, deposit.originChainId, "origin"),
                destination,
            });
            pending.shift();
            const fill = {
                deposit,
                destinationChainId: deposit.destinationChainId,
                txHashes: result?.txHashes ?? [],
                ...(result?.outputAmount === undefined ? {} : { outputAmount: result.outputAmount }),
                ...(result?.details === undefined ? {} : { details: result.details }),
            };
            fills.push(fill);
            emitForkitEvent({
                type: "bridge:fill",
                ts: Date.now(),
                bridge: options.name ?? "custom",
                depositId: deposit.id,
                originChainId: deposit.originChainId,
                destinationChainId: deposit.destinationChainId,
                depositTxHash: deposit.txHash,
                txHashes: fill.txHashes,
                ...(fill.outputAmount === undefined ? {} : { outputAmount: fill.outputAmount }),
                ...(fill.details === undefined ? {} : { details: fill.details }),
            });
            made.push(fill);
        }
        return made;
    }
    return {
        get pending() {
            return [...pending];
        },
        get fills() {
            return [...fills];
        },
        poll,
        settle: () => serialized(settleNow),
    };
}
/** The handle for `chainId` in a multi-fork, with an error naming the role when it is missing. */
export function handleFor(f, chainId, role) {
    const member = f.forks.find((m) => m.chain.id === chainId);
    if (member === undefined) {
        throw new ForkitError(`forkit: the bridge's ${role} chain ${chainId} is not in this fork (${f.forks
            .map((m) => `${m.chain.name} (${m.chain.id})`)
            .join(", ")}). Fork it with fork([...]).`);
    }
    return member;
}
//# sourceMappingURL=core.js.map