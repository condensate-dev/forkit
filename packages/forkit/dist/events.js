const listeners = new Set();
/** Observe every run event in this process. Returns an unsubscribe function. */
export function onForkitEvent(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
/** Whether anyone observes run events, so emitters can skip work nobody would see. */
export function hasForkitListeners() {
    return listeners.size > 0;
}
/** Emit a run event. Internal: forkit's own modules call this. */
export function emitForkitEvent(event) {
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch {
            // Observers must never break a test.
        }
    }
}
const work = new Set();
/**
 * Let an observer's async work (a run record reading receipts and traces, say) finish before
 * forkit changes the fork under it: `revertTo` and `stop` wait for it. A rejection is ignored.
 */
export function trackObserverWork(promise) {
    const tracked = promise.catch(() => { });
    work.add(tracked);
    void tracked.finally(() => work.delete(tracked));
}
/** Resolves once every tracked observer promise has settled, including ones added meanwhile. */
export async function observersSettled() {
    while (work.size > 0)
        await Promise.all(work);
}
//# sourceMappingURL=events.js.map