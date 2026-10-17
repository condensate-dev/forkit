import { ForkitError } from "../errors.js";
import { createSurfnetSuite } from "./suite.js";
const OUTSIDE = "forkit: itSurfnet must be called inside a describeSurfnet body.";
export function createSurfnetAdapter(runner) {
    // As in createForkAdapter: each describeSurfnet's beforeEach pushes its handle and afterEach
    // pops it, so the top is the nearest enclosing surfnet whatever order nested bodies run in.
    // An itSurfnet outside any describeSurfnet fails when it runs.
    const running = [];
    return {
        describeSurfnet(name, options, body) {
            runner.describe(name, () => {
                const handle = createSurfnetSuite(options, runner.hooks);
                runner.hooks.beforeEach(() => {
                    running.push(handle);
                });
                runner.hooks.afterEach(() => {
                    running.pop();
                });
                body(handle);
            });
        },
        itSurfnet(name, fn, timeoutMs) {
            runner.it(name, async () => {
                const current = running.at(-1);
                if (current === undefined)
                    throw new ForkitError(OUTSIDE);
                await fn(current);
            }, timeoutMs);
        },
    };
}
//# sourceMappingURL=adapter.js.map