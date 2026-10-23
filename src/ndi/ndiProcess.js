/**
 * Entry point of the NDI utilityProcess. The main process sends it a
 * MessagePort for the renderer (see main/ndiHost.js); frames go straight
 * down that port, so preview traffic never passes through the main process.
 *
 * Frames come from ndi-helper.exe (see ndiHelper.js), an x64 program run
 * under emulation because NDI has no Windows ARM64 library. Its path is the
 * --ndi-helper=<path> argument. Each channel shows the NDI source at its
 * camera's IP; the main process sends the channel IPs as { type: 'channels' }.
 *
 * With RCP_FAKE_NDI set ("1", or a size such as "1920x1080"), every channel
 * gets generated test frames instead, and the helper isn't started.
 *
 * Previews start stopped. The renderer sends { type: 'previews', channels }
 * over its port, listing the channels whose preview is on; a stopped channel
 * has no receiver, so no NDI video is pulled from its camera or decoded.
 * Discovery keeps running, so a start reconnects at once.
 */
const fs = require('node:fs');
const { createNdiService } = require('./ndiService');
const { createFakeSource } = require('./fakeSource');
const { NdiHelper, matchSources } = require('./ndiHelper');

const CHANNEL_IDS = [1, 2, 3, 4];
const log = (message) => console.log(`[ndi] ${message}`);

/**
 * Applies a new set of running channels: calls start(id) or stop(id) for each
 * channel whose state changed. The first call (from boot) applies to all.
 */
function createRunningSet({ start, stop }) {
    let running = null;
    return {
        has: (id) => running?.has(id) ?? false,
        set(next) {
            const before = running;
            running = new Set(next);
            for (const id of CHANNEL_IDS) {
                const on = running.has(id);
                if (before && before.has(id) === on) continue;
                if (on) start(id);
                else stop(id);
            }
        },
    };
}

function fakeSize(setting) {
    const match = /^(\d+)x(\d+)$/.exec(setting ?? '');
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 640, height: 360 };
}

function startFake(service, setting) {
    const size = fakeSize(setting);
    log(`fake sources at ${size.width}x${size.height}`);
    for (const id of CHANNEL_IDS) service.setSource(id, createFakeSource(id, size));
    const running = createRunningSet({
        start(id) {
            service.setStatus(id, 'connecting');
            // Stagger the "connections" so the overlay states are visible.
            setTimeout(() => running.has(id) && service.setStatus(id, 'connected'), 400 + id * 250);
        },
        stop: (id) => service.setStatus(id, 'stopped'),
    });
    return { setChannels() {}, setRunning: running.set };
}

/** Feeds each channel from the helper, reconnecting as the channel IPs or the visible sources change. */
function startHelper(service, exePath) {
    if (!exePath || !fs.existsSync(exePath)) {
        log(`ndi-helper not found at ${exePath ?? '(no path)'}; previews disabled. Build it with "npm run build:ndi-helper".`);
        return { setChannels() {}, setRunning() {} };
    }

    const helper = new NdiHelper(exePath, { log });
    let channels = {};
    let sources = [];
    const connectedTo = new Map(); // channel -> source name
    const running = createRunningSet({
        start(id) {
            service.setStatus(id, 'no_source');
            rematch(); // connects it if its camera is visible
        },
        stop(id) {
            if (connectedTo.get(id)) helper.disconnect(id);
            connectedTo.set(id, null);
            service.setStatus(id, 'stopped');
        },
    });

    for (const id of CHANNEL_IDS) {
        const latest = () => helper.latest(id);
        service.setSource(id, {
            push: true,
            get width() { return latest()?.width; },
            get height() { return latest()?.height; },
            get stride() { return latest()?.stride; },
            get format() { return latest()?.format; },
            frameAt: () => latest()?.data ?? null,
        });
    }

    function rematch() {
        const wanted = matchSources(channels, sources);
        for (const id of CHANNEL_IDS) {
            if (!running.has(id)) continue;
            const name = wanted[id] ?? null;
            if (name === (connectedTo.get(id) ?? null)) continue;
            if (name) {
                helper.connect(id, name);
                service.setStatus(id, 'connecting');
            } else {
                helper.disconnect(id);
                service.setStatus(id, 'no_source');
            }
            connectedTo.set(id, name);
        }
    }

    helper.on('sources', (list) => {
        sources = list;
        rematch();
    });
    helper.on('status', (id, status) => {
        if (connectedTo.get(id)) service.setStatus(id, status);
    });
    helper.on('frame', (id) => service.frameReady(id));
    helper.on('restart', () => {
        connectedTo.clear();
        rematch(); // reconnects to whatever was visible; a fresh source list follows shortly
    });
    helper.start();

    return {
        setChannels(next) {
            channels = next;
            helper.find(Object.values(next).map((c) => c.ip_address));
            rematch();
        },
        setRunning: running.set,
    };
}

const fake = process.env.RCP_FAKE_NDI;
let feeds = null;
const service = createNdiService({ channelIds: CHANNEL_IDS, log: fake ? log : null, onPreviews: (ids) => feeds.setRunning(ids) });
const helperArg = process.argv.find((arg) => arg.startsWith('--ndi-helper='));
feeds = fake ? startFake(service, fake) : startHelper(service, helperArg?.slice('--ndi-helper='.length));
feeds.setRunning([]);

process.parentPort.on('message', (event) => {
    if (event.data?.type === 'port' && event.ports[0]) {
        service.attach(event.ports[0]);
    } else if (event.data?.type === 'channels') {
        feeds.setChannels(event.data.channels);
    }
});

service.start();
