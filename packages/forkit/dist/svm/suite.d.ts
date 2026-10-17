import type { SuiteHooks } from "../suite.ts";
import { type Surfnet, type SurfnetOptions } from "./surfnet.ts";
export type { SuiteHooks } from "../suite.ts";
/**
 * Register one surfnet's lifecycle on a runner's hooks and return its handle. Call it while tests
 * are being collected: a missing or too-old surfpool throws right here, so the suite fails
 * loudly instead of skipping.
 */
export declare function createSurfnetSuite(options: SurfnetOptions, hooks: SuiteHooks): Surfnet;
//# sourceMappingURL=suite.d.ts.map