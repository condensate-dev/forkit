/**
 * Decode transactions for the run record while the worker still knows the ABIs: calldata, return
 * data, reverts and events, each against forkit's known ABIs (see `registerAbi`). The browser UI
 * has no ABI decoder; it renders what this produces.
 */
import { type AbiParameter, type Hex } from "viem";
import type { CallFrame } from "../trace.ts";
import type { DecodedCall, DecodedParam, Json, LogRecord, TraceFrame } from "./schema.ts";
type Values = readonly unknown[] | Record<string, unknown>;
/** One ABI value as JSON, keeping tuples' component names and types. */
export declare function paramValue(param: AbiParameter, value: unknown): Json;
/** Decoded values, named and typed after the ABI parameters they came from. */
export declare function decodedParams(params: readonly AbiParameter[], values: Values): DecodedParam[];
/** Decode calldata against the known ABIs, or `undefined` when its selector is unknown. */
export declare function decodeCall(input: Hex | undefined): DecodedCall | undefined;
/** Decode an event log against the known ABIs. */
export declare function decodeLog(topics: readonly Hex[], data: Hex): DecodedCall | undefined;
/** A log from a receipt, decoded. */
export declare function logRecord(log: {
    address: string;
    topics: readonly Hex[];
    data: Hex;
    logIndex?: Hex | number | null;
}): LogRecord;
/** A reverted frame's reason: the decoded revert data, else the node's own words. */
export declare function revertText(frame: Pick<CallFrame, "output" | "error" | "revertReason">): string;
/** A `callTracer` frame, decoded, with its children (and its events, when traced with them). */
export declare function decodeFrame(frame: CallFrame): TraceFrame;
export {};
//# sourceMappingURL=decode.d.ts.map