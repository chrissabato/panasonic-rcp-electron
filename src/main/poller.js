const { CHANNEL_IDS } = require('./state/StateStore');

/**
 * Slow poll loop, moved out of the renderer. Each tick runs pollChannel for
 * every camera (a health probe, then a read-back of its current values) and
 * caches the results; the renderer's fast poll reads them from the store. A
 * tick is skipped while the previous one is still running, so a stalled
 * camera never stacks probes.
 */
class HealthPoller {
    constructor({ pollChannel, getIntervalMs, log = console.warn }) {
        this.pollChannel = pollChannel;
        this.getIntervalMs = getIntervalMs;
        this.log = log;
        this.timer = null;
        this.inFlight = false;
    }

    start() {
        this.stop();
        this.tick();
        this.timer = setInterval(() => this.tick(), this.getIntervalMs());
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Picks up a changed interval. */
    restart() {
        if (this.timer !== null) this.start();
    }

    async tick() {
        if (this.inFlight) return;
        this.inFlight = true;
        try {
            await Promise.all(CHANNEL_IDS.map((id) => this.pollChannel(id).catch((err) => {
                this.log(`poll for channel ${id} failed: ${err.message}`);
            })));
        } finally {
            this.inFlight = false;
        }
    }
}

module.exports = { HealthPoller };
