/**
 * Builds `describeSurfnet` / `itSurfnet` for one test runner, the Solana twin of
 * `describeFork` / `itFork`.
 */
import type { RunnerApi } from "../adapter.ts";
import { type SurfnetSuiteOptions } from "./suite.ts";
import type { Surfnet } from "./surfnet.ts";
export interface SurfnetAdapter {
    /**
     * A `describe` block with its own surfnet: booted before the first test, stopped after the
     * last. `body` receives the handle; it is usable inside tests and hooks.
     */
    describeSurfnet(name: string, options: SurfnetSuiteOptions, body: (surfnet: Surfnet) => void): void;
    /** A test inside {@link SurfnetAdapter.describeSurfnet} that receives the nearest surfnet. */
    itSurfnet(name: string, fn: (surfnet: Surfnet) => Promise<void> | void, timeoutMs?: number): void;
}
export declare function createSurfnetAdapter(runner: RunnerApi): SurfnetAdapter;
//# sourceMappingURL=adapter.d.ts.map