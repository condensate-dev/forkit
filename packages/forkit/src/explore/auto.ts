/** `FORKIT_RECORD=1`: start the run recorder the first time a fork boots or attaches. */
import { startRecording } from "./recorder.ts";
import { recordingEnabled } from "./store.ts";

let checked = false;

export function autoRecord(): void {
  if (checked) return;
  checked = true;
  if (recordingEnabled()) startRecording();
}
