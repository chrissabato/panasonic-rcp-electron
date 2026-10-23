/**
 * Entry point of the NDI utilityProcess. The main process sends it a
 * MessagePort for the renderer (see main/ndiHost.js); frames go straight
 * down that port, so preview traffic never passes through the main process.
 *
 * The NDI SDK receiver isn't integrated yet. Until it is, every channel
 * reports no_source, unless RCP_FAKE_NDI is set ("1", or a size such as
 * "1920x1080"), which feeds each channel generated test frames instead.
 */
const { createNdiService } = require('./ndiService');
const { createFakeSource } = require('./fakeSource');

const CHANNEL_IDS = [1, 2, 3, 4];
const log = (message) => console.log(`[ndi] ${message}`);

function fakeSize(setting) {
    const match = /^(\d+)x(\d+)$/.exec(setting ?? '');
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 640, height: 360 };
}

const fake = process.env.RCP_FAKE_NDI;
const service = createNdiService({ channelIds: CHANNEL_IDS, log: fake ? log : null });

if (fake) {
    const size = fakeSize(fake);
    log(`fake sources at ${size.width}x${size.height}`);
    for (const id of CHANNEL_IDS) {
        service.setSource(id, createFakeSource(id, size));
        service.setStatus(id, 'connecting');
        // Stagger the "connections" so the overlay states are visible.
        setTimeout(() => service.setStatus(id, 'connected'), 400 + id * 250);
    }
}

process.parentPort.on('message', (event) => {
    if (event.data?.type === 'port' && event.ports[0]) {
        service.attach(event.ports[0]);
    }
});

service.start();
