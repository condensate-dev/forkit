export type { SurfnetSuiteOptions } from "./suite.ts";
export type { Surfnet, SurfnetOptions } from "./surfnet.ts";
export declare const describeSurfnet: (name: string, options: import("./suite.ts").SurfnetSuiteOptions, body: (surfnet: import("./surfnet.ts").Surfnet) => void) => void, itSurfnet: (name: string, fn: (surfnet: import("./surfnet.ts").Surfnet) => Promise<void> | void, timeoutMs?: number) => void;
//# sourceMappingURL=vitest.d.ts.map