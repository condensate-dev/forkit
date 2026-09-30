/**
 * Decode transactions for the run record while the worker still knows the ABIs: calldata, return
 * data, reverts and events, each against forkit's known ABIs (see `registerAbi`). The browser UI
 * has no ABI decoder; it renders what this produces.
 */
import {
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  type Hex,
  hexToBigInt,
  size,
  slice,
  toEventSignature,
  toFunctionSignature,
} from "viem";
import { knownEvent, knownFunction } from "../labels.ts";
import { decodeRevert, describeRevert } from "../revert.ts";
import type { CallFrame } from "../trace.ts";
import { toJson } from "./json.ts";
import type { DecodedCall, DecodedParam, FrameLog, Json, LogRecord, TraceFrame } from "./schema.ts";

type Values = readonly unknown[] | Record<string, unknown>;

function pick(values: Values | undefined, param: AbiParameter, index: number): unknown {
  if (values === undefined) return undefined;
  if (Array.isArray(values)) return values[index];
  const record = values as Record<string, unknown>;
  return param.name !== undefined && param.name !== "" && param.name in record
    ? record[param.name]
    : record[String(index)];
}

/** One ABI value as JSON, keeping tuples' component names and types. */
export function paramValue(param: AbiParameter, value: unknown): Json {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null && Array.isArray(value)) {
    const element = { ...param, type: array[1] as string } as AbiParameter;
    return value.map((item) => paramValue(element, item));
  }
  if (param.type === "tuple" && "components" in param) {
    return decodedParams(param.components, value as Values) as unknown as Json;
  }
  return toJson(value);
}

/** Decoded values, named and typed after the ABI parameters they came from. */
export function decodedParams(params: readonly AbiParameter[], values: Values): DecodedParam[] {
  return params.map((param, index) => ({
    name: param.name ?? "",
    type: param.type,
    value: paramValue(param, pick(values, param, index)),
  }));
}

function callOf(fn: AbiFunction, values: Values): DecodedCall {
  return {
    name: fn.name,
    signature: toFunctionSignature(fn),
    args: decodedParams(fn.inputs, values),
  };
}

/** Decode calldata against the known ABIs, or `undefined` when its selector is unknown. */
export function decodeCall(input: Hex | undefined): DecodedCall | undefined {
  if (input === undefined || size(input) < 4) return undefined;
  const fn = knownFunction(slice(input, 0, 4));
  if (fn === undefined) return undefined;
  try {
    const { args } = decodeFunctionData({ abi: [fn], data: input });
    return callOf(fn, (args ?? []) as readonly unknown[]);
  } catch {
    return undefined;
  }
}

function decodeResult(input: Hex, output: Hex | undefined): DecodedParam[] | undefined {
  if (output === undefined || output === "0x" || size(input) < 4) return undefined;
  const fn = knownFunction(slice(input, 0, 4));
  if (fn === undefined || fn.outputs.length === 0) return undefined;
  try {
    return decodedParams(fn.outputs, decodeAbiParameters(fn.outputs, output));
  } catch {
    return undefined;
  }
}

/** Decode an event log against the known ABIs. */
export function decodeLog(topics: readonly Hex[], data: Hex): DecodedCall | undefined {
  const [topic0] = topics;
  if (topic0 === undefined) return undefined;
  const event: AbiEvent | undefined = knownEvent(topic0);
  if (event === undefined) return undefined;
  try {
    const decoded = decodeEventLog({
      abi: [event],
      data,
      topics: topics as [Hex, ...Hex[]],
    });
    return {
      name: event.name,
      signature: toEventSignature(event),
      args: decodedParams(event.inputs, (decoded.args ?? []) as Values),
    };
  } catch {
    return undefined;
  }
}

/** A log from a receipt, decoded. */
export function logRecord(log: {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  logIndex?: Hex | number | null;
}): LogRecord {
  const event = decodeLog(log.topics, log.data);
  const index =
    log.logIndex === undefined || log.logIndex === null
      ? undefined
      : typeof log.logIndex === "number"
        ? log.logIndex
        : Number(hexToBigInt(log.logIndex));
  return {
    address: log.address.toLowerCase(),
    topics: [...log.topics],
    data: log.data,
    ...(index === undefined ? {} : { logIndex: index }),
    ...(event === undefined ? {} : { event }),
  };
}

/** A reverted frame's reason: the decoded revert data, else the node's own words. */
export function revertText(frame: Pick<CallFrame, "output" | "error" | "revertReason">): string {
  const revert = decodeRevert(frame.output);
  if (revert.kind === "unknown" || (revert.kind === "empty" && frame.revertReason !== undefined)) {
    return frame.revertReason ?? frame.error ?? "reverted";
  }
  return describeRevert(revert);
}

const hexAmount = (value: Hex | undefined): string | undefined =>
  value === undefined ? undefined : hexToBigInt(value).toString();

/** A frame's own events (`callTracer` with `withLog`), decoded. */
function frameLogs(frame: CallFrame): FrameLog[] {
  return (frame.logs ?? []).map((log) => {
    const event = decodeLog(log.topics ?? [], log.data ?? "0x");
    return {
      address: log.address.toLowerCase(),
      topics: [...(log.topics ?? [])],
      data: log.data ?? "0x",
      position: log.position === undefined ? 0 : Number(hexToBigInt(log.position)),
      ...(log.index === undefined ? {} : { index: Number(hexToBigInt(log.index)) }),
      ...(event === undefined ? {} : { event }),
    };
  });
}

/** A `callTracer` frame, decoded, with its children (and its events, when traced with them). */
export function decodeFrame(frame: CallFrame): TraceFrame {
  const call = decodeCall(frame.input);
  const result = frame.error === undefined ? decodeResult(frame.input, frame.output) : undefined;
  const value = hexAmount(frame.value);
  const gasUsed = hexAmount(frame.gasUsed);
  const logs = frameLogs(frame);
  return {
    type: frame.type.toUpperCase(),
    from: frame.from.toLowerCase(),
    ...(frame.to === undefined ? {} : { to: frame.to.toLowerCase() }),
    ...(value === undefined ? {} : { value }),
    ...(gasUsed === undefined ? {} : { gasUsed }),
    input: frame.input,
    ...(frame.output === undefined ? {} : { output: frame.output }),
    ...(frame.error === undefined ? {} : { error: frame.error, revert: revertText(frame) }),
    ...(call === undefined ? {} : { call }),
    ...(result === undefined ? {} : { result }),
    ...(frame.calls === undefined || frame.calls.length === 0
      ? {}
      : { calls: frame.calls.map(decodeFrame) }),
    ...(logs.length === 0 ? {} : { logs }),
  };
}
