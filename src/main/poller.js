const { CHANNEL_IDS } = require('./state/StateStore');

/**
 * Slow health loop, moved out of the renderer. Each tick probes every camera
 * (login + discovery query) and caches the result; the renderer's fast poll
 * reads it from the store. A tick is skipped while the previous one is still
 * running, so a stalled camera never stacks probes.
 */
class HealthPoller {
    constructor({ checkHealth, getIntervalMs, log = console.warn }) {
        this.checkHealth = checkHealth;
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
            await Promise.all(CHANNEL_IDS.map((id) => this.checkHealth(id).catch((err) => {
                this.log(`health check for channel ${id} failed: ${err.message}`);
            })));
        } finally {
            this.inFlight = false;
        }
    }
}

module.exports = { HealthPoller };
