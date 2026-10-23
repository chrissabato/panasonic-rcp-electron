const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../src/main/state/StateStore');
const { CameraClient } = require('../src/main/camera/CameraClient');
const { CommandQueue } = require('../src/main/camera/commandQueue');
const { createHandlers, ApiError } = require('../src/main/handlers');
const { startP2Sim } = require('./p2-sim/server');

const DEFAULT_SETTINGS = {
    timeouts: { connect_ms: 500, total_ms: 800 },
    poll: { fast_ms: 400, slow_ms: 7000 },
};

/** Handlers wired to a fresh store, with channel 1 pointed at a P2 sim. */
async function setup(simOptions = {}) {
    const sim = await startP2Sim(simOptions);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-handlers-'));
    const store = new StateStore(path.join(dir, 'rcp.sqlite'), {
        defaultSettings: DEFAULT_SETTINGS,
        defaultChannels: { 1: { display_name: 'CH1', ip_address: sim.host, port: sim.port, username: 'admin', password: 'secret' } },
    });
    const clientFor = (id) => {
        const cfg = store.getChannelConfig(id);
        const { timeouts } = store.getSettings();
        return new CameraClient({
            ipAddress: cfg.ip_address, port: cfg.port, username: cfg.username, password: cfg.password,
            connectTimeoutMs: timeouts.connect_ms, totalTimeoutMs: timeouts.total_ms,
        });
    };
    const { handlers, checkHealth, pollChannel } = createHandlers({ store, queue: new CommandQueue(), clientFor, log: () => {} });
    return {
        sim, store, handlers, checkHealth, pollChannel,
        async teardown() {
            store.close();
            await sim.close();
        },
    };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => err instanceof ApiError && err.code === code);

test('setControl sends to the camera and persists non-momentary values', async () => {
    const t = await setup();
    try {
        assert.deepEqual(await t.handlers.setControl({ channel: 1, control: 'iris', value: 25 }), { channel: 1, control: 'iris', value: 25 });
        assert.equal(t.sim.state.Irs, '5000');
        assert.equal(t.store.getChannelState(1).iris, 25);
        assert.equal(t.store.getHealth(1).status, 'ok');

        await t.handlers.setControl({ channel: 1, control: 'zoom', value: 99 });
        assert.equal('zoom' in t.store.getChannelState(1), false);
    } finally {
        await t.teardown();
    }
});

test('setControl validates its input', async () => {
    const t = await setup();
    try {
        await rejectsWith(t.handlers.setControl({ channel: 5, control: 'iris', value: 1 }), 'invalid_channel');
        await rejectsWith(t.handlers.setControl({ channel: 1, control: 'gamma', value: 1 }), 'invalid_control');
        await rejectsWith(t.handlers.setControl({ channel: 1, control: 'iris' }), 'missing_value');
        await rejectsWith(t.handlers.setControl({ channel: 1, control: 'awb_mode', value: 7 }), 'invalid_value');
    } finally {
        await t.teardown();
    }
});

test('setControl reports camera failures with distinct codes', async () => {
    const t = await setup({ password: 'other' });
    try {
        await rejectsWith(t.handlers.setControl({ channel: 1, control: 'tally', value: true }), 'auth_failed');
        assert.equal(t.store.getHealth(1).status, 'auth_failed');
        assert.equal(t.store.getChannelState(1).tally, false, 'failed sets are not persisted');

        await rejectsWith(t.handlers.setControl({ channel: 2, control: 'tally', value: true }), 'unreachable');
    } finally {
        await t.teardown();
    }
});

test('checkHealth stores model and serial, and flags channels with no IP', async () => {
    const t = await setup();
    try {
        const health = await t.checkHealth(1);
        assert.equal(health.status, 'ok');
        assert.deepEqual(health.info, { model: 'AG-CX370', serial: 'DV24782369EC48' });

        const none = await t.checkHealth(2);
        assert.equal(none.status, 'unreachable');
        assert.equal(none.last_error, 'No IP address set');
    } finally {
        await t.teardown();
    }
});

test('the renderer never receives passwords', async () => {
    const t = await setup();
    try {
        const { channels } = t.handlers.getChannels();
        assert.equal(channels[1].config.password, undefined);
        assert.equal(channels[1].config.has_password, true);
        assert.equal(t.handlers.getSettings().channels[1].password, undefined);
    } finally {
        await t.teardown();
    }
});

test('saveSettings keeps the password when none is sent, and rejects bad input atomically', async () => {
    const t = await setup();
    try {
        const entry = { display_name: 'Cam A', ip_address: t.sim.host, port: t.sim.port, username: 'admin' };
        t.handlers.saveSettings({ channels: { 1: entry } });
        assert.equal(t.store.getChannelConfig(1).password, 'secret');
        assert.equal(t.store.getChannelConfig(1).display_name, 'Cam A');

        assert.throws(
            () => t.handlers.saveSettings({ poll: { fast_ms: 400, slow_ms: 7000 }, channels: { 1: { ...entry, ip_address: 'not-an-ip' } } }),
            (err) => err.code === 'invalid_settings'
        );
        assert.throws(() => t.handlers.saveSettings({ poll: { fast_ms: 50, slow_ms: 7000 } }), (err) => err.code === 'invalid_settings');
        assert.deepEqual(t.store.getSettings().poll, DEFAULT_SETTINGS.poll);
    } finally {
        await t.teardown();
    }
});

test('setConfig updates one channel and re-checks its health', async () => {
    const t = await setup();
    try {
        const result = await t.handlers.setConfig({ channel: 1, ip_address: '', display_name: 'Renamed' });
        assert.equal(result.config.display_name, 'Renamed');
        assert.equal(result.config.ip_address, t.sim.host, 'blank IP keeps the current one');
        assert.equal(result.health.status, 'ok');
        await rejectsWith(t.handlers.setConfig({ channel: 1, ip_address: '1.2.3', display_name: 'x' }), 'invalid_ip');
        await rejectsWith(t.handlers.setConfig({ channel: 1, display_name: 'x', port: 70000 }), 'invalid_port');
    } finally {
        await t.teardown();
    }
});

test('scenes save, recall onto the camera and report per-channel results', async () => {
    const t = await setup();
    try {
        t.store.setControlValue(1, 'iris', 100);
        t.store.setControlValue(1, 'auto_iris', true);
        const saved = t.handlers.saveScene({ name: 'Bright', channels: [1, 2] });
        assert.equal(saved.scope, 'single');
        assert.equal(t.handlers.listScenes().scenes[0].name, 'Bright');

        const { results } = await t.handlers.recallScene({ scene_id: saved.id, channel: 'all' });
        assert.equal(t.sim.state.Irs, '20000');
        assert.equal(t.sim.state.AIrsSw, 'On');
        assert.equal(results[1].failed.length, 0);
        assert.ok(results[1].applied.includes('iris'));
        assert.ok(results[2].failed.every((f) => f.reason === 'unreachable'));
        assert.deepEqual(results[3], { applied: [], failed: [], skipped: [] });

        await rejectsWith(t.handlers.recallScene({ scene_id: 999 }), 'scene_not_found');
        t.handlers.deleteScene({ id: saved.id });
        assert.equal(t.handlers.listScenes().scenes.length, 0);
    } finally {
        await t.teardown();
    }
});

test('an ignored write fails with not_applied and stores the camera\'s real value', async () => {
    const t = await setup({ ignoredWrites: ['BGain'] });
    try {
        await rejectsWith(t.handlers.setControl({ channel: 1, control: 'wb_b', value: 90 }), 'not_applied');
        assert.equal(t.store.getChannelState(1).wb_b, 40, 'BGain -2 of -10..10, not the 90 that was sent');
        assert.equal(t.store.getHealth(1).status, 'ok');
    } finally {
        await t.teardown();
    }
});

test('the slow poll probes health and stores values changed on the camera body', async () => {
    const t = await setup();
    try {
        t.sim.state.Irs = '20000';
        t.sim.state.AIrsSw = 'On';
        t.sim.state.WBalSel = 'Preset';
        await t.pollChannel(1);

        const state = t.store.getChannelState(1);
        assert.equal(state.iris, 100);
        assert.equal(state.auto_iris, true);
        assert.equal(state.awb_mode, 10);
        assert.equal(t.store.getHealth(1).info.model, 'AG-CX370');

        await t.pollChannel(2); // no IP: probed as unreachable, never read back
        assert.equal(t.store.getHealth(2).status, 'unreachable');
    } finally {
        await t.teardown();
    }
});

test('the slow poll skips read-back when login fails', async () => {
    const t = await setup({ password: 'other' });
    try {
        await t.pollChannel(1);
        assert.equal(t.store.getHealth(1).status, 'auth_failed');
        assert.equal(t.sim.received.includes('$Irs:?'), false);
    } finally {
        await t.teardown();
    }
});
