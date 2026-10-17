/**
 * Process-wide labels and known ABIs, like Foundry's `vm.label`. Labels make addresses readable
 * in assertion errors and traces; known ABIs let traces and errors decode calldata, return
 * values, custom errors and events. `writeContract` and `deployContract` on a fork client
 * register the ABI they were given automatically.
 */
import { erc20Abi, getAddress, isAddress, toEventSelector, toFunctionSelector, } from "viem";
const labels = new Map();
const functions = new Map();
const errors = new Map();
const events = new Map();
/** Name `address` in errors and traces. Labels are process-wide and apply on every chain. */
export function label(address, name) {
    labels.set(address.toLowerCase(), name);
}
/** The label of `address`, if it has one. */
export function labelOf(address) {
    return labels.get(address.toLowerCase());
}
/** Every label, keyed by lowercase address. */
export function allLabels() {
    return Object.fromEntries(labels);
}
/** `USDC (0x8335…2913)` for a labelled address, the checksummed address otherwise. */
export function formatAddress(address) {
    const name = labelOf(address);
    const checksummed = isAddress(address, { strict: false }) ? getAddress(address) : address;
    return name === undefined
        ? checksummed
        : `${name} (${checksummed.slice(0, 6)}…${checksummed.slice(-4)})`;
}
/** Let traces and errors decode this ABI's functions, errors and events. */
export function registerAbi(abi) {
    for (const item of abi) {
        if (item.type === "function")
            functions.set(toFunctionSelector(item), item);
        else if (item.type === "error")
            errors.set(errorSelector(item), item);
        else if (item.type === "event")
            events.set(toEventSelector(item), item);
    }
}
/** An error's selector is computed like a function's: name and input types. */
export function errorSelector(item) {
    return toFunctionSelector({ ...item, type: "function", outputs: [], stateMutability: "view" });
}
/** Forget every label and registered ABI (the ERC-20 ABI stays known). For test isolation. */
export function clearLabels() {
    labels.clear();
    functions.clear();
    errors.clear();
    events.clear();
    registerAbi(erc20Abi);
}
export function knownFunction(selector) {
    return functions.get(selector.toLowerCase());
}
export function knownError(selector) {
    return errors.get(selector.toLowerCase());
}
export function knownEvent(topic0) {
    return events.get(topic0.toLowerCase());
}
registerAbi(erc20Abi);
//# sourceMappingURL=labels.js.map