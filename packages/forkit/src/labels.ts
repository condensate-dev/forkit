/**
 * Process-wide labels and known ABIs, like Foundry's `vm.label`. Labels make addresses readable
 * in assertion errors and traces; known ABIs let traces and errors decode calldata, return
 * values, custom errors and events. `writeContract` and `deployContract` on a fork client
 * register the ABI they were given automatically.
 */
import {
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  isAddress,
  toEventSelector,
  toFunctionSelector,
} from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;

const labels = new Map<string, string>();
const functions = new Map<Hex, AbiFunction>();
const errors = new Map<Hex, AbiError>();
const events = new Map<Hex, AbiEvent>();

/** Name `address` in errors and traces. Labels are process-wide and apply on every chain. */
export function label(address: Address, name: string): void {
  labels.set(address.toLowerCase(), name);
}

/** The label of `address`, if it has one. */
export function labelOf(address: string): string | undefined {
  return labels.get(address.toLowerCase());
}

/** Every label, keyed by lowercase address. */
export function allLabels(): Record<string, string> {
  return Object.fromEntries(labels);
}

/** `USDC (0x8335…2913)` for a labelled address, the checksummed address otherwise. */
export function formatAddress(address: string): string {
  const name = labelOf(address);
  const checksummed = isAddress(address, { strict: false }) ? getAddress(address) : address;
  return name === undefined
    ? checksummed
    : `${name} (${checksummed.slice(0, 6)}…${checksummed.slice(-4)})`;
}

/** Let traces and errors decode this ABI's functions, errors and events. */
export function registerAbi(abi: Abi | readonly unknown[]): void {
  for (const item of abi as Abi) {
    if (item.type === "function") functions.set(toFunctionSelector(item), item);
    else if (item.type === "error") errors.set(errorSelector(item), item);
    else if (item.type === "event") events.set(toEventSelector(item), item);
  }
}

/** An error's selector is computed like a function's: name and input types. */
export function errorSelector(item: AbiError): Hex {
  return toFunctionSelector({ ...item, type: "function", outputs: [], stateMutability: "view" });
}

/** Forget every label and registered ABI (the ERC-20 ABI stays known). For test isolation. */
export function clearLabels(): void {
  labels.clear();
  functions.clear();
  errors.clear();
  events.clear();
  registerAbi(erc20Abi);
}

export function knownFunction(selector: Hex): AbiFunction | undefined {
  return functions.get(selector.toLowerCase() as Hex);
}

export function knownError(selector: Hex): AbiError | undefined {
  return errors.get(selector.toLowerCase() as Hex);
}

export function knownEvent(topic0: Hex): AbiEvent | undefined {
  return events.get(topic0.toLowerCase() as Hex);
}

registerAbi(erc20Abi);
