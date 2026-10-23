/**
 * Serializes work per camera and coalesces superseded updates.
 *
 * Every camera operation opens its own P2 session, so two at once would race
 * for the controller slot. Each channel therefore runs one job at a time.
 * Jobs with a key (e.g. a control name) replace any job with the same key
 * that is still waiting, so a fast knob drag never builds a backlog: only the
 * latest value is sent, and every caller waiting on the dropped job gets the
 * result of the one that replaced it.
 */
class CommandQueue {
    constructor() {
        this.channels = new Map();
    }

    channel(channelId) {
        if (!this.channels.has(channelId)) {
            this.channels.set(channelId, { running: false, waiting: [] });
        }
        return this.channels.get(channelId);
    }

    /** Runs fn() after earlier jobs on this channel; resolves with fn's result. */
    enqueue(channelId, key, fn) {
        const ch = this.channel(channelId);
        return new Promise((resolve, reject) => {
            const existing = key == null ? undefined : ch.waiting.find((job) => job.key === key);
            if (existing) {
                existing.fn = fn;
                existing.callbacks.push({ resolve, reject });
            } else {
                ch.waiting.push({ key, fn, callbacks: [{ resolve, reject }] });
            }
            this.drain(ch);
        });
    }

    async drain(ch) {
        if (ch.running) return;
        ch.running = true;
        while (ch.waiting.length > 0) {
            const job = ch.waiting.shift();
            try {
                const result = await job.fn();
                for (const cb of job.callbacks) cb.resolve(result);
            } catch (err) {
                for (const cb of job.callbacks) cb.reject(err);
            }
        }
        ch.running = false;
    }
}

module.exports = { CommandQueue };
