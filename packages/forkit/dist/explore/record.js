/**
 * `@condensate/forkit/explore/record`: record runs without setting `FORKIT_RECORD` by hand.
 *
 * - As a global setup (vitest or jest `globalSetup`), it turns recording on for every worker and
 *   gives them one run id.
 * - As a setup file (vitest `setupFiles`, jest `setupFiles`, `bun test --preload`), it records
 *   the process that loads it.
 *
 * See docs/guides/explore.md.
 */
import { startRecording } from "./recorder.js";
import { RECORD_ENV, RUN_ID_ENV } from "./store.js";
process.env[RECORD_ENV] ??= "1";
const recorder = startRecording();
process.env[RUN_ID_ENV] ??= recorder.runId;
/** The global setup hook: loading this module already did the work. */
export default function setup() { }
export { activeRecorder, startRecording, stopRecording } from "./recorder.js";
//# sourceMappingURL=record.js.map