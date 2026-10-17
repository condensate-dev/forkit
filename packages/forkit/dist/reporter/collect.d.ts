/**
 * Collect run events in the process where tests run, plus what rendering needs later: labels of
 * the addresses involved, and each transferred token's symbol and decimals (read from the fork
 * while it is still up).
 */
import { type Hex } from "viem";
import { type ForkitEvent } from "../events.ts";
import { type RunLog, type TokenInfo } from "./serialize.ts";
/** keccak256("Transfer(address,address,uint256)"). */
export declare const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export interface RunCollector {
    /** Every event collected so far, in order. */
    readonly events: readonly ForkitEvent[];
    /** The whole run so far, once pending token lookups finish. */
    snapshot(): Promise<RunLog>;
    /** The events since the previous `drain()` (with labels and tokens), once lookups finish. */
    drain(): Promise<RunLog>;
    /** Stop collecting. */
    stop(): void;
}
/** `address` from a 32-byte topic, lowercase. */
export declare function topicAddress(topic: Hex | undefined): string | undefined;
/** Read `decimals()` and `symbol()` of an ERC-20 over JSON-RPC. Never throws. */
export declare function lookupToken(rpcUrl: string, address: string): Promise<TokenInfo>;
/**
 * Start collecting run events in this process. Use it where tests run: in a jest or node:test
 * file (then `formatRun(await run.snapshot())` in `afterAll`), or through the vitest setup file
 * and bun preload, which do it for you.
 */
export declare function collectRun(): RunCollector;
//# sourceMappingURL=collect.d.ts.map