import type { SuiteHooks } from "../suite.ts";
import { type Surfnet, type SurfnetOptions } from "./surfnet.ts";
export type { SuiteHooks } from "../suite.ts";
export interface SurfnetSuiteOptions extends SurfnetOptions {
    /**
     * `reset()` the whole surfnet after every test (`surfnet_resetNetwork`), so each test starts
     * from the fork source's current state. Default false. Not a snapshot revert: accounts load
     * again from the source as it is now, and the clock goes back to the source's.
     */
    resetEach?: boolean;
}
/**
 * Register one surfnet's lifecycle on a runner's hooks and return its handle. Call it while tests
 * are being collected: a missing or too-old surfpool throws right here, so the suite fails
 * loudly instead of skipping.
 */
export declare function createSurfnetSuite(options: SurfnetSuiteOptions, hooks: SuiteHooks): Surfnet;
//# sourceMappingURL=suite.d.ts.map