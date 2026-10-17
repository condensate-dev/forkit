import { type Address, type Hex } from "viem";
import { type ForkClient } from "./client.ts";
export declare const erc20BalanceAbi: readonly [{
    readonly name: "balanceOf";
    readonly type: 'function';
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}];
/** How `deal` writes an ERC-20 balance. */
export type DealStrategy = "auto" | "anvil_dealERC20" | "storage";
export interface DealOptions {
    /**
     * `auto` (default) tries `anvil_dealERC20`, then falls back to storage-slot discovery.
     * `storage` always discovers and writes the balance slot directly.
     */
    via?: DealStrategy;
}
export declare function readBalance(client: ForkClient, token: Address, holder: Address): Promise<bigint>;
/** Find the storage slot that backs `balanceOf(holder)`, or `undefined` if none does. */
export declare function findBalanceSlot(client: ForkClient, token: Address, holder: Address): Promise<Hex | undefined>;
/** Set `holder`'s balance of `token` to exactly `amount`, then read it back. */
export declare function dealErc20(client: ForkClient, token: Address, holder: Address, amount: bigint, options?: DealOptions): Promise<void>;
//# sourceMappingURL=deal.d.ts.map