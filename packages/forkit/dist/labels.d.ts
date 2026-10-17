/**
 * Process-wide labels and known ABIs, like Foundry's `vm.label`. Labels make addresses readable
 * in assertion errors and traces; known ABIs let traces and errors decode calldata, return
 * values, custom errors and events. `writeContract` and `deployContract` on a fork client
 * register the ABI they were given automatically.
 */
import { type Abi, type AbiEvent, type AbiFunction, type Address, type Hex } from "viem";
type AbiError = Extract<Abi[number], {
    type: "error";
}>;
/** Name `address` in errors and traces. Labels are process-wide and apply on every chain. */
export declare function label(address: Address, name: string): void;
/** The label of `address`, if it has one. */
export declare function labelOf(address: string): string | undefined;
/** Every label, keyed by lowercase address. */
export declare function allLabels(): Record<string, string>;
/** `USDC (0x8335…2913)` for a labelled address, the checksummed address otherwise. */
export declare function formatAddress(address: string): string;
/** Let traces and errors decode this ABI's functions, errors and events. */
export declare function registerAbi(abi: Abi | readonly unknown[]): void;
/** An error's selector is computed like a function's: name and input types. */
export declare function errorSelector(item: AbiError): Hex;
/** Forget every label and registered ABI (the ERC-20 ABI stays known). For test isolation. */
export declare function clearLabels(): void;
export declare function knownFunction(selector: Hex): AbiFunction | undefined;
export declare function knownError(selector: Hex): AbiError | undefined;
export declare function knownEvent(topic0: Hex): AbiEvent | undefined;
export {};
//# sourceMappingURL=labels.d.ts.map