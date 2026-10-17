import { type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
export declare const TOKEN_PROGRAM_ADDRESS: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
export declare const TOKEN_2022_PROGRAM_ADDRESS: Address<"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">;
export declare const ASSOCIATED_TOKEN_PROGRAM_ADDRESS: Address<"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL">;
export declare const BPF_LOADER_UPGRADEABLE_ADDRESS: Address<"BPFLoaderUpgradeab1e11111111111111111111111">;
export declare const SYSVAR_CLOCK_ADDRESS: Address<"SysvarC1ock11111111111111111111111111111111">;
type Request = <T>(method: string, params?: readonly unknown[]) => Promise<T>;
/** Fields `surfnet_setAccount` sets; anything left out keeps its current (or forked) value. */
export interface AccountPatch {
    lamports?: bigint;
    data?: Uint8Array;
    owner?: Address;
    executable?: boolean;
    rentEpoch?: bigint;
}
/** The `Clock` sysvar, as programs on the surfnet read it. */
export interface SurfnetClock {
    slot: bigint;
    epoch: bigint;
    /** Seconds. */
    unixTimestamp: bigint;
}
/** `surfnet_timeTravel`'s answer (Solana's EpochInfo). */
export interface SurfnetEpochInfo {
    epoch: number;
    slotIndex: number;
    slotsInEpoch: number;
    absoluteSlot: number;
    blockHeight: number;
    transactionCount?: number | null;
}
export type WarpTarget = {
    unixTimestamp: bigint | number;
} | {
    slot: bigint | number;
} | {
    epoch: bigint | number;
};
export interface DealTokenOptions {
    /** The token program; by default whichever program owns the mint (Token or Token-2022). */
    tokenProgram?: Address;
}
export interface EtchOptions {
    /** The program's upgrade authority. Default: surfpool's (the system program). */
    authority?: Address;
}
export interface ResetOptions {
    /** Also reset the accounts this one owns (a program's accounts, say). Default false. */
    includeOwnedAccounts?: boolean;
}
/** The cheatcodes on a surfnet handle. */
export interface SurfnetCheats {
    /** `surfnet_setAccount`: write any of an account's fields. */
    setAccount(account: Address, patch: AccountPatch): Promise<void>;
    /** Set a wallet's SOL balance to exactly `lamports` (`surfnet_setAccount`), read back. */
    dealSol(account: Address, lamports: bigint): Promise<void>;
    /**
     * Set `owner`'s associated token account for `mint` to exactly `amount` base units, creating
     * it if needed (`surfnet_setTokenAccount`), read back. Returns the token account's address.
     */
    deal(mint: Address, owner: Address, amount: bigint, options?: DealTokenOptions): Promise<Address>;
    /** The `Clock` sysvar. */
    clock(): Promise<SurfnetClock>;
    /** Move the clock forward `seconds` from now (`surfnet_timeTravel`, absoluteTimestamp). */
    warp(seconds: bigint | number): Promise<SurfnetClock>;
    /** Move forward `slots` slots (`surfnet_timeTravel`, absoluteSlot). */
    roll(slots: bigint | number): Promise<SurfnetClock>;
    /** Jump to an absolute timestamp (seconds), slot or epoch (`surfnet_timeTravel`). Forward only. */
    warpTo(target: WarpTarget): Promise<SurfnetEpochInfo>;
    /** Stop slots from advancing (`surfnet_pauseClock`). */
    pauseClock(): Promise<SurfnetEpochInfo>;
    /** Let slots advance again (`surfnet_resumeClock`). */
    resumeClock(): Promise<SurfnetEpochInfo>;
    /**
     * Deploy a program `.so` (bytes, or a path to the file) at `programId` as an upgradeable
     * program (`surfnet_writeProgram`, chunked). Replaces whatever program is there.
     */
    etch(programId: Address, program: Uint8Array | string, options?: EtchOptions): Promise<void>;
    /** Set or clear (`null`) a program's upgrade authority (`surfnet_setProgramAuthority`). */
    setProgramAuthority(programId: Address, authority: Address | null): Promise<void>;
    /**
     * Drop local changes. With an account (`surfnet_resetAccount`), that account goes back to the
     * fork source's current state on its next read. Without one (`surfnet_resetNetwork`), the
     * whole surfnet does, clock included. It is a reset to the source's *current* state, not a
     * revert to a snapshot: surfpool 1.6.1 has no runtime snapshot or revert.
     */
    reset(account?: Address, options?: ResetOptions): Promise<void>;
}
/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export declare function associatedTokenAddress(owner: Address, mint: Address, tokenProgram?: Address): Promise<Address>;
/** The programdata account of an upgradeable program. */
export declare function programDataAddress(programId: Address): Promise<Address>;
/** Decode the 40-byte `Clock` sysvar: slot, epoch start, epoch, leader schedule epoch, unix time. */
export declare function decodeClock(data: Uint8Array): SurfnetClock;
export declare function createCheats(rpc: Rpc<SolanaRpcApi>, request: Request): SurfnetCheats;
export {};
//# sourceMappingURL=cheats.d.ts.map