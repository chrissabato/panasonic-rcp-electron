const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../src/main/state/StateStore');

const DEFAULT_SETTINGS = {
    timeouts: { connect_ms: 1500, total_ms: 2500 },
    poll: { fast_ms: 400, slow_ms: 7000 },
};

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-store-'));
    return path.join(dir, 'rcp.sqlite');
}

const reversingSecrets = {
    encrypt: (s) => `rev:${[...s].reverse().join('')}`,
    decrypt: (s) => (s.startsWith('rev:') ? [...s.slice(4)].reverse().join('') : s),
};

test('seeds channels, persisted controls and settings', () => {
    const store = new StateStore(tempDbPath(), { defaultSettings: DEFAULT_SETTINGS });
    const cfg = store.getChannelConfig(3);
    assert.deepEqual(cfg, { display_name: 'CH3', ip_address: '', port: 49152, username: '', password: '' });

    const state = store.getChannelState(1);
    assert.equal(state.iris, 50);
    assert.equal(state.iris_level, 0);
    assert.equal(state.auto_focus, true);
    assert.equal('zoom' in state, false, 'momentary controls are not persisted');
    assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS);
    store.close();
});

test('reopening keeps saved values and settings', () => {
    const dbPath = tempDbPath();
    let store = new StateStore(dbPath, { defaultSettings: DEFAULT_SETTINGS });
    store.setControlValue(2, 'iris', 77);
    store.setSetting('poll', { fast_ms: 500, slow_ms: 9000 });
    store.close();

    store = new StateStore(dbPath, { defaultSettings: DEFAULT_SETTINGS });
    assert.equal(store.getChannelState(2).iris, 77);
    assert.deepEqual(store.getSettings().poll, { fast_ms: 500, slow_ms: 9000 });
    store.close();
});

test('passwords go through secrets and never sit in the DB as plain text', () => {
    const dbPath = tempDbPath();
    const store = new StateStore(dbPath, { defaultSettings: DEFAULT_SETTINGS, secrets: reversingSecrets });
    store.setChannelConfig(1, { ip_address: '10.0.0.5', display_name: 'Cam A', port: 49151, username: 'admin', password: 'hunter2' });
    assert.equal(store.getChannelConfig(1).password, 'hunter2');

    const raw = store.db.prepare('SELECT password FROM channel_config WHERE channel_id = 1').get().password;
    assert.equal(raw, 'rev:2retnuh');
    store.close();
});

test('health keeps the last device info when a later update has none', () => {
    const store = new StateStore(tempDbPath(), { defaultSettings: DEFAULT_SETTINGS });
    store.setHealth(1, { reachable: true, status: 'ok', info: { model: 'AG-CX370' } });
    store.setHealth(1, { reachable: false, status: 'unreachable', error: 'timeout' });
    const health = store.getHealth(1);
    assert.equal(health.status, 'unreachable');
    assert.equal(health.last_error, 'timeout');
    assert.deepEqual(health.info, { model: 'AG-CX370' });
    store.close();
});

test('scenes snapshot channel state and filter by channel', () => {
    const store = new StateStore(tempDbPath(), { defaultSettings: DEFAULT_SETTINGS });
    store.setControlValue(1, 'iris', 10);
    store.setControlValue(2, 'iris', 20);
    const id = store.saveScene('Look', 'all', [1, 2, 3, 4]);
    store.setControlValue(1, 'iris', 99);

    assert.equal(store.sceneExists(id), true);
    const values = store.getSceneValues(id, [1, 2]);
    assert.equal(values[1].iris, 10);
    assert.equal(values[2].iris, 20);
    assert.equal(values[3], undefined);
    assert.deepEqual(store.getSceneValues(id, []), {});

    store.deleteScene(id);
    assert.equal(store.sceneExists(id), false);
    assert.deepEqual(store.getSceneValues(id, [1]), {});
    store.close();
});
