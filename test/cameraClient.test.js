const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { CameraClient, parseDeviceInfo } = require('../src/main/camera/CameraClient');
const { CameraState } = require('../src/main/camera/cameraResponse');
const { startP2Sim } = require('./p2-sim/server');

function clientFor(sim, overrides = {}) {
    return new CameraClient({
        ipAddress: sim.host, port: sim.port, username: 'admin', password: 'secret',
        connectTimeoutMs: 500, totalTimeoutMs: 800, ...overrides,
    });
}

async function withSim(options, fn) {
    const sim = await startP2Sim(options);
    try {
        await fn(sim);
    } finally {
        await sim.close();
    }
}

test('scaled set queries bounds, scales and sets in one session', () => withSim({}, async (sim) => {
    const response = await clientFor(sim).setIris(25);
    assert.equal(response.state, CameraState.OK);
    assert.equal(sim.state.Irs, '5000');
    assert.deepEqual(sim.received, [
        'Login:admin', '$Connect:=On', '$MyName:sPanasonicRCP', '$Irs:c', '$Irs:=5000', '$Connect:=Off',
    ]);
}));

test('exposure compensation maps -50..50 onto $AIrsLv', () => withSim({}, async (sim) => {
    assert.ok((await clientFor(sim).setIrisLevel(-20)).isOk());
    assert.equal(sim.state.AIrsLv, '-20');
}));

test('boolean and enum commands', () => withSim({}, async (sim) => {
    const client = clientFor(sim);
    assert.ok((await client.setTally(true)).isOk());
    assert.ok((await client.setAwbMode(10)).isOk());
    assert.equal(sim.state.RTlySw, 'On');
    assert.equal(sim.state.WBalSel, 'Preset');
    assert.throws(() => client.setAwbMode(3), RangeError);
}));

test('replies split across TCP packets are reassembled', () => withSim({ chunked: true }, async (sim) => {
    const response = await clientFor(sim).setIris(100);
    assert.equal(response.state, CameraState.OK);
    assert.equal(sim.state.Irs, '20000');
}));

test('self-closing ack completes the read without waiting for the timeout', () => withSim({}, async (sim) => {
    const started = Date.now();
    await clientFor(sim, { totalTimeoutMs: 2000 }).setAutoFocus(false);
    assert.ok(Date.now() - started < 500, 'set took as long as the read timeout');
}));

test('wrong password is reported as an auth failure', () => withSim({}, async (sim) => {
    const response = await clientFor(sim, { password: 'nope' }).setTally(true);
    assert.equal(response.state, CameraState.AUTH_FAILED);
    assert.match(response.error, /Wrong User/);
}));

test('":!" means not supported and ":#" means busy', () => withSim({ unsupported: ['AFcSw'], busy: ['RTlySw'] }, async (sim) => {
    const client = clientFor(sim);
    const unsupported = await client.setAutoFocus(true);
    assert.equal(unsupported.state, CameraState.UNEXPECTED);
    assert.match(unsupported.error, /not supported/);

    const busy = await client.setTally(true);
    assert.equal(busy.state, CameraState.UNEXPECTED);
    assert.match(busy.error, /busy/);
}));

test('missing range ("$X:i!") is an unexpected response', () => withSim({ ranges: {} }, async (sim) => {
    const response = await clientFor(sim).setIris(50);
    assert.equal(response.state, CameraState.UNEXPECTED);
    assert.match(response.error, /bounds/);
}));

test('AWB ignores the busy Act reply and polls until settled', () => withSim({ awbPollsBeforeSettle: 2 }, async (sim) => {
    const response = await clientFor(sim).triggerAwb();
    assert.equal(response.state, CameraState.OK);
    assert.equal(response.body, '$Awb:sOk');
    assert.equal(sim.received.filter((c) => c === '$Awb:?').length, 3);
}));

test('AWB failure is reported', () => withSim({ awbPollsBeforeSettle: 0, awbResult: 'Ng' }, async (sim) => {
    const response = await clientFor(sim).triggerAwb();
    assert.equal(response.state, CameraState.UNEXPECTED);
    assert.match(response.error, /sNg/);
}));

test('device info parses ModelName and SerialNo. from the XML reply', () => withSim({}, async (sim) => {
    const response = await clientFor(sim).getDeviceInfo();
    assert.ok(response.isOk());
    assert.deepEqual(parseDeviceInfo(response.body), { model: 'AG-CX370', serial: 'DV24782369EC48' });
}));

test('closed port is unreachable', async () => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    await new Promise((r) => server.close(r));

    const client = new CameraClient({ ipAddress: '127.0.0.1', port, connectTimeoutMs: 500 });
    assert.equal((await client.setTally(true)).state, CameraState.UNREACHABLE);
});

test('a camera that accepts but never answers times out as unreachable', async () => {
    const server = net.createServer(() => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const client = new CameraClient({ ipAddress: '127.0.0.1', port: server.address().port, totalTimeoutMs: 200 });
        const response = await client.getDeviceInfo();
        assert.equal(response.state, CameraState.UNREACHABLE);
    } finally {
        server.close();
        server.unref();
    }
});
