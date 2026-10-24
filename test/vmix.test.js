const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { VmixTally, parseTally, parseInputs } = require('../src/main/vmix/vmixTally');
const { createVmixHandlers } = require('../src/main/vmix/vmixHandlers');
const { StateStore } = require('../src/main/state/StateStore');

const xmlFor = (inputs) => `<vmix><version>29.0.0.34</version><inputs>${inputs
    .map((i) => `<input key="${i.key}" number="${i.number}" type="NDI" title="${i.title}" state="Running">${i.title}</input>`)
    .join('')}</inputs><active>1</active><preview>2</preview></vmix>`;

/**
 * Minimal vMix TCP API: answers SUBSCRIBE TALLY and XML like vMix does, and
 * lets a test push tally lines, swap the input list, or drop the connection.
 */
function startFakeVmix() {
    const state = { inputs: [], tally: '', sockets: new Set() };
    const server = net.createServer((socket) => {
        state.sockets.add(socket);
        socket.on('close', () => state.sockets.delete(socket));
        socket.on('error', () => {});
        socket.write('VERSION OK 29.0.0.34\r\n');
        let pending = '';
        socket.on('data', (chunk) => {
            pending += chunk.toString('utf8');
            let eol;
            while ((eol = pending.indexOf('\r\n')) >= 0) {
                const cmd = pending.slice(0, eol);
                pending = pending.slice(eol + 2);
                if (cmd === 'SUBSCRIBE TALLY') socket.write(`SUBSCRIBE OK TALLY Subscribed\r\nTALLY OK ${state.tally}\r\n`);
                if (cmd === 'XML') {
                    const body = Buffer.from(xmlFor(state.inputs), 'utf8');
                    socket.write(Buffer.concat([Buffer.from(`XML ${body.length}\r\n`), body]));
                }
            }
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        state,
        pushTally(tally) {
            state.tally = tally;
            for (const s of state.sockets) s.write(`TALLY OK ${tally}\r\n`);
        },
        dropConnections() {
            for (const s of state.sockets) s.destroy();
        },
        close: () => new Promise((done) => { for (const s of state.sockets) s.destroy(); server.close(done); }),
    })));
}

/** Resolves once check() is true, re-checking on every 'change' (fails after 3 s). */
function until(emitter, check) {
    return new Promise((resolve, reject) => {
        if (check()) return resolve();
        const timer = setTimeout(() => { emitter.off('change', onChange); reject(new Error('timed out waiting for vMix state')); }, 3000);
        function onChange() {
            if (!check()) return;
            clearTimeout(timer);
            emitter.off('change', onChange);
            resolve();
        }
        emitter.on('change', onChange);
    });
}

test('tally lines map each input to program, preview or off', () => {
    assert.deepEqual(parseTally('TALLY OK 0120'), ['off', 'program', 'preview', 'off']);
    assert.equal(parseTally('SUBSCRIBE OK TALLY Subscribed'), null);
    assert.equal(parseTally('TALLY OK 01x'), null);
});

test('inputs are read from vMix XML, with entities decoded', () => {
    const inputs = parseInputs(xmlFor([
        { key: 'a-1', number: 1, title: 'Cam &amp; Lens' },
        { key: 'b-2', number: 2, title: '&quot;Wide&quot;' },
    ]));
    assert.deepEqual(inputs, [
        { key: 'a-1', number: 1, title: 'Cam & Lens' },
        { key: 'b-2', number: 2, title: '"Wide"' },
    ]);
});

test('follows vMix tally by input key, through renumbering and a reconnect', async () => {
    const vmixServer = await startFakeVmix();
    // A multi-byte title: vMix's XML length is in bytes, not characters.
    vmixServer.state.inputs = [{ key: 'cam-a', number: 1, title: 'Caméra A' }, { key: 'cam-b', number: 2, title: 'Cam B' }];
    vmixServer.state.tally = '12';
    const vmix = new VmixTally({ log: () => {} });
    try {
        assert.equal(vmix.tallyFor('cam-a'), null, 'nothing is known before connecting');
        vmix.configure({ host: '127.0.0.1', port: vmixServer.port });
        await until(vmix, () => vmix.status === 'connected' && vmix.inputs.length === 2 && vmix.tally.length === 2);
        assert.equal(vmix.version, '29.0.0.34');
        assert.equal(vmix.inputs[0].title, 'Caméra A');
        assert.equal(vmix.tallyFor('cam-a'), 'program');
        assert.equal(vmix.tallyFor('cam-b'), 'preview');
        assert.equal(vmix.tallyFor('not-an-input'), null);

        vmixServer.pushTally('21');
        await until(vmix, () => vmix.tallyFor('cam-a') === 'preview');
        assert.equal(vmix.tallyFor('cam-b'), 'program');

        // The inputs swap places in vMix; tally still follows each camera by key once the list refreshes.
        vmixServer.state.inputs = [{ key: 'cam-b', number: 1, title: 'Cam B' }, { key: 'cam-a', number: 2, title: 'Caméra A' }];
        vmix.onInputs(parseInputs(xmlFor(vmixServer.state.inputs)));
        assert.equal(vmix.tallyFor('cam-a'), 'program', 'tally digit 2 is now cam-a');

        vmixServer.dropConnections();
        await until(vmix, () => vmix.status === 'unreachable');
        assert.equal(vmix.tallyFor('cam-a'), null, 'no tally while vMix is away');
        await until(vmix, () => vmix.status === 'connected' && vmix.tally.length === 2);
    } finally {
        vmix.stop();
        await vmixServer.close();
    }
});

test('an empty address turns tally off', () => {
    const vmix = new VmixTally({ log: () => {} });
    vmix.configure({ host: '', port: 8099 });
    assert.equal(vmix.status, 'disabled');
    assert.equal(vmix.tallyFor('anything'), null);
});

test('saving vMix settings validates, keeps input titles, and reconnects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-vmix-'));
    const store = new StateStore(path.join(dir, 'rcp.sqlite'), {
        defaultSettings: { timeouts: { connect_ms: 500, total_ms: 800 }, poll: { fast_ms: 400, slow_ms: 7000 }, vmix: { host: '', port: 8099, channels: {} } },
    });
    const vmix = Object.assign(new EventEmitter(), {
        status: 'connected', version: '29', inputs: [{ key: 'cam-a', number: 3, title: 'Cam A' }], configured: null,
        configure(cfg) { this.configured = cfg; },
    });
    let changed = 0;
    const { getVmix, saveVmix } = createVmixHandlers({ store, vmix, onChanged: () => changed++ });
    try {
        const saved = saveVmix({ host: '192.168.4.100', port: 8099, channels: { 1: 'cam-a', 2: '' } });
        assert.deepEqual(saved.channels, { 1: { key: 'cam-a', title: 'Cam A' } });
        assert.deepEqual(vmix.configured, { host: '192.168.4.100', port: 8099 });
        assert.equal(changed, 1);
        assert.deepEqual(getVmix().inputs, [{ key: 'cam-a', number: 3, title: 'Cam A' }]);

        assert.throws(() => saveVmix({ host: 'not a host!', port: 8099 }), (err) => err.code === 'invalid_host');
        assert.throws(() => saveVmix({ host: 'vmix-pc', port: 70000 }), (err) => err.code === 'invalid_port');
        assert.equal(store.getSettings().vmix.host, '192.168.4.100', 'a rejected save changes nothing');
    } finally {
        store.close();
    }
});
