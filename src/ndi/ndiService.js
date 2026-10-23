/**
 * Paces preview frames from each channel's source to the renderer over one
 * MessagePort. A channel only gets its next frame after the renderer acks
 * the last one it drew, so a slow renderer drops frames instead of building
 * a backlog -- the same "always the latest frame" rule as NDI framesync.
 * If a frame falls due while a channel waits for its ack, it goes out as
 * soon as the ack arrives, so the ack round trip doesn't cost a whole tick.
 *
 * Frames are paced by due time, checked on a short timer, rather than by a
 * 1000/fps interval: Windows timers fire on a ~15.6 ms clock, which turns a
 * 33 ms interval into ~47 ms (21 fps).
 *
 * Messages to the renderer:
 *   { type: 'status', channel, status }   no_source | connecting | connected | no_signal
 *   { type: 'frame', channel, width, height, stride, format, data }
 * Messages from the renderer:
 *   { type: 'ack', channel }               ready for that channel's next frame
 *   { type: 'stats', fps: { channel: n } } frames drawn per second, for measurement
 */
const STATUSES = new Set(['no_source', 'connecting', 'connected', 'no_signal']);
const CHECK_INTERVAL_MS = 10;

function createNdiService({ channelIds = [1, 2, 3, 4], fps = 30, now = Date.now, log = null } = {}) {
    const period = 1000 / fps;
    const channels = new Map(channelIds.map((id) => [id, { status: 'no_source', source: null, credit: true, missed: false, due: 0, sent: 0 }]));
    let port = null;
    let timer = null;

    const post = (message) => port?.postMessage(message);

    function onMessage({ data }) {
        if (data?.type === 'ack') {
            const ch = channels.get(data.channel);
            if (!ch) return;
            ch.credit = true;
            if (ch.missed) send(data.channel, ch, now());
        } else if (data?.type === 'stats' && log) {
            const sent = [...channels].map(([id, ch]) => `CH${id} ${ch.sent}`).join(', ');
            const drawn = Object.entries(data.fps ?? {}).map(([id, n]) => `CH${id} ${Number(n).toFixed(1)}`).join(', ');
            log(`preview fps drawn: ${drawn}; frames sent so far: ${sent}`);
        }
    }

    /** Points the service at a renderer's port, replacing any earlier one (e.g. after a reload). */
    function attach(newPort) {
        port?.close();
        port = newPort;
        port.on('message', onMessage);
        port.on('close', () => {
            if (port === newPort) port = null;
        });
        port.start();
        for (const [channel, ch] of channels) {
            ch.credit = true;
            ch.missed = false;
            post({ type: 'status', channel, status: ch.status });
        }
    }

    function setStatus(channel, status) {
        const ch = channels.get(channel);
        if (!ch || !STATUSES.has(status)) throw new RangeError(`Bad channel ${channel} or status ${status}`);
        ch.status = status;
        post({ type: 'status', channel, status });
    }

    /** source: { width, height, stride, format, frameAt(t) }, or null for none. */
    function setSource(channel, source) {
        channels.get(channel).source = source;
    }

    function send(channel, ch, t) {
        ch.missed = false;
        if (!port || ch.status !== 'connected' || !ch.source) return;
        const { width, height, stride, format } = ch.source;
        // postMessage copies the data as it serializes, so the source may reuse its buffer.
        post({ type: 'frame', channel, width, height, stride, format, data: ch.source.frameAt(t) });
        ch.credit = false;
        ch.sent++;
        // Next frame one period after this one was due; after a stall, restart from now rather than bursting to catch up.
        ch.due = (t - ch.due > period ? t : ch.due) + period;
    }

    function tick() {
        if (!port) return;
        const t = now();
        for (const [channel, ch] of channels) {
            if (t < ch.due) continue;
            if (ch.credit) send(channel, ch, t);
            else ch.missed = true;
        }
    }

    return {
        attach,
        setStatus,
        setSource,
        tick,
        start() {
            timer ??= setInterval(tick, CHECK_INTERVAL_MS);
        },
        stop() {
            clearInterval(timer);
            timer = null;
        },
    };
}

module.exports = { createNdiService };
