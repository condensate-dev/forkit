/**
 * - `write`: record every measurement into the file (default outside CI).
 * - `check`: compare against the file and fail on a difference or a missing entry (default when
 *   `CI` is set).
 * - `off`: measure and return the gas, touch no file.
 */
export type GasSnapshotMode = "write" | "check" | "off";
export declare const GAS_SNAPSHOT_MODES: readonly GasSnapshotMode[];
export declare const GAS_SNAPSHOT_ENV = "FORKIT_GAS_SNAPSHOT";
export declare const GAS_SNAPSHOT_FILE_ENV = "FORKIT_GAS_SNAPSHOT_FILE";
export declare const DEFAULT_GAS_SNAPSHOT_FILE = ".gas-snapshot";
export interface GasSnapshotSettings {
    mode: GasSnapshotMode;
    /** Absolute path of the snapshot file. */
    file: string;
}
export declare function resolveGasSettings(mode: GasSnapshotMode | undefined, file: string | undefined, env?: Readonly<Record<string, string | undefined>>): GasSnapshotSettings;
/** Parse `label (gas: 123)` lines. */
export declare function parseGasSnapshot(text: string): Map<string, bigint>;
/** One `label (gas: 123)` line per entry, sorted by label, so the file diffs cleanly. */
export declare function formatGasSnapshot(entries: ReadonlyMap<string, bigint>): string;
/**
 * Record `gas` under `label` according to the mode. In `check` mode a missing or different
 * entry throws {@link ForkitAssertionError}.
 */
export declare function recordGas(settings: GasSnapshotSettings, label: string, gas: bigint): Promise<void>;
//# sourceMappingURL=gas.d.ts.map