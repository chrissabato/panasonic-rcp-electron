const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFakeSource, rgbToYuv709 } = require('../src/ndi/fakeSource');
const { createNdiService } = require('../src/ndi/ndiService');

/** Stands in for a MessagePortMain: records what's posted, lets a test send messages in. */
function fakePort() {
    const port = new EventEmitter();
    port.sent = [];
    port.postMessage = (message) => port.sent.push(message);
    port.start = () => {};
    port.close = () => port.emit('close');
    port.receive = (data) => port.emit('message', { data });
    port.frames = () => port.sent.filter((m) => m.type === 'frame');
    return port;
}

test('BT.709 limited range: white, black and the 75% bars', () => {
    assert.deepEqual(rgbToYuv709([1, 1, 1]), { y: 235, u: 128, v: 128 });
    assert.deepEqual(rgbToYuv709([0, 0, 0]), { y: 16, u: 128, v: 128 });
    assert.deepEqual(rgbToYuv709([0.75, 0, 0]), { y: 51, u: 109, v: 212 });
});

test('fake frames are UYVY of the requested size, with a sweeping bar', () => {
    const source = createFakeSource(2, { width: 640, height: 360 });
    assert.equal(source.format, 'UYVY');
    assert.equal(source.stride, 1280);

    const first = Buffer.from(source.frameAt(0));
    assert.equal(first.length, 1280 * 360);
    const later = source.frameAt(1000);
    assert.notDeepEqual(Buffer.from(later), first, 'the bar moved');

    // Pixel pair (40, 359) sits in the first (75% white) bar, clear of the sweep at t=0: U Y V Y.
    const i = 359 * 1280 + 40 * 2;
    assert.deepEqual([...first.subarray(i, i + 4)], [128, 180, 128, 180]);
});

/** A service on a manual clock, with channel 1 connected to a small fake source. */
function connectedService({ channelIds = [1] } = {}) {
    const clock = { t: 0 };
    const service = createNdiService({ channelIds, now: () => clock.t });
    for (const id of channelIds) service.setSource(id, createFakeSource(id, { width: 64, height: 36 }));
    service.setStatus(1, 'connected');
    return { clock, service };
}

test('frames go out only for connected channels, at most one in flight', () => {
    const { clock, service } = connectedService({ channelIds: [1, 2] });
    service.setStatus(2, 'connecting');
    const port = fakePort();
    service.attach(port);

    assert.deepEqual(port.sent.map((m) => [m.type, m.channel, m.status]), [
        ['status', 1, 'connected'], ['status', 2, 'connecting'],
    ]);

    service.tick();
    assert.equal(port.frames().length, 1);
    assert.equal(port.frames()[0].channel, 1);
    assert.equal(port.frames()[0].data.length, 128 * 36);

    clock.t = 100;
    service.tick();
    assert.equal(port.frames().length, 1, 'no second frame before the ack');
});

test('frames are paced by due time, so a coarse timer still averages the target rate', () => {
    const { clock, service } = connectedService();
    const port = fakePort();
    service.attach(port);

    // Ticks every 15.6 ms, like a Windows timer; the renderer acks each frame at once.
    for (clock.t = 0; clock.t < 1000; clock.t += 15.6) {
        const before = port.frames().length;
        service.tick();
        if (port.frames().length > before) port.receive({ type: 'ack', channel: 1 });
    }
    assert.equal(port.frames().length, 30);
});

test('a frame that falls due while waiting for an ack goes out when the ack arrives', () => {
    const { clock, service } = connectedService();
    const port = fakePort();
    service.attach(port);

    service.tick(); // t=0: sent
    port.receive({ type: 'ack', channel: 1 });
    assert.equal(port.frames().length, 1, 'an ack before the next frame is due sends nothing');

    clock.t = 40;
    service.tick(); // sent
    clock.t = 80;
    service.tick(); // due, but still waiting for the ack
    port.receive({ type: 'ack', channel: 1 });
    assert.equal(port.frames().length, 3, 'the due frame goes out on the ack');
    service.tick();
    assert.equal(port.frames().length, 3, 'and still only one in flight');
});

test('a new port replaces the old one and resets credit', () => {
    const { clock, service } = connectedService();
    const first = fakePort();
    service.attach(first);
    service.tick(); // sent, never acked: the page reloaded

    const second = fakePort();
    service.attach(second);
    clock.t = 40;
    service.tick();
    assert.equal(second.frames().length, 1);
    assert.equal(first.frames().length, 1);
});

test('no port, no source or a bad status sends nothing', () => {
    const service = createNdiService({ channelIds: [1], now: () => 0 });
    service.setStatus(1, 'connected');
    service.tick(); // no port yet

    const port = fakePort();
    service.attach(port);
    service.tick(); // no source
    assert.equal(port.frames().length, 0);
    assert.throws(() => service.setStatus(1, 'bogus'), RangeError);
});
