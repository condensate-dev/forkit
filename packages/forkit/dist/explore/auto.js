/** `FORKIT_RECORD=1`: start the run recorder the first time a fork boots or attaches. */
import { startRecording } from "./recorder.js";
import { recordingEnabled } from "./store.js";
let checked = false;
export function autoRecord() {
    if (checked)
        return;
    checked = true;
    if (recordingEnabled())
        startRecording();
}
//# sourceMappingURL=auto.js.map