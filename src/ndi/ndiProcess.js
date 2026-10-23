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
 */
const fs = require('node:fs');
const { createNdiService } = require('./ndiService');
const { createFakeSource } = require('./fakeSource');
const { NdiHelper, matchSources } = require('./ndiHelper');

const CHANNEL_IDS = [1, 2, 3, 4];
const log = (message) => console.log(`[ndi] ${message}`);

function fakeSize(setting) {
    const match = /^(\d+)x(\d+)$/.exec(setting ?? '');
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 640, height: 360 };
}

function startFake(service, setting) {
    const size = fakeSize(setting);
    log(`fake sources at ${size.width}x${size.height}`);
    for (const id of CHANNEL_IDS) {
        service.setSource(id, createFakeSource(id, size));
        service.setStatus(id, 'connecting');
        // Stagger the "connections" so the overlay states are visible.
        setTimeout(() => service.setStatus(id, 'connected'), 400 + id * 250);
    }
    return { setChannels() {} };
}

/** Feeds each channel from the helper, reconnecting as the channel IPs or the visible sources change. */
function startHelper(service, exePath) {
    if (!exePath || !fs.existsSync(exePath)) {
        log(`ndi-helper not found at ${exePath ?? '(no path)'}; previews disabled. Build it with "npm run build:ndi-helper".`);
        return { setChannels() {} };
    }

    const helper = new NdiHelper(exePath, { log });
    let channels = {};
    let sources = [];
    const connectedTo = new Map(); // channel -> source name

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
    };
}

const fake = process.env.RCP_FAKE_NDI;
const service = createNdiService({ channelIds: CHANNEL_IDS, log: fake ? log : null });
const helperArg = process.argv.find((arg) => arg.startsWith('--ndi-helper='));
const feeds = fake ? startFake(service, fake) : startHelper(service, helperArg?.slice('--ndi-helper='.length));

process.parentPort.on('message', (event) => {
    if (event.data?.type === 'port' && event.ports[0]) {
        service.attach(event.ports[0]);
    } else if (event.data?.type === 'channels') {
        feeds.setChannels(event.data.channels);
    }
});

service.start();
