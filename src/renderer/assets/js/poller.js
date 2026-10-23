import * as api from './api.js';

/**
 * Fast (~400ms) refresh of cached channel state and health. This only reads
 * the main process's store, so it's cheap; the active camera probes now run
 * on the main process's slow health loop, which writes into that store.
 * Guarded against overlap so a stalled request never stacks.
 */
export function startPoller({ onFastUpdate, onFastError, fastMs = 400 } = {}) {
    let fastInFlight = false;

    async function fastTick() {
        if (fastInFlight) return;
        fastInFlight = true;
        try {
            const data = await api.getChannels();
            onFastUpdate?.(data.channels);
        } catch (err) {
            onFastError?.(err);
        } finally {
            fastInFlight = false;
        }
    }

    fastTick();
    const fastTimer = setInterval(fastTick, fastMs);

    return {
        stop() {
            clearInterval(fastTimer);
        },
    };
}
