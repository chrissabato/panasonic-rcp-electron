const Database = require('better-sqlite3');
const registry = require('../camera/controlRegistry');

const CHANNEL_IDS = [1, 2, 3, 4];
const DEFAULT_PORT = 49152;

const plainSecrets = { encrypt: (s) => s, decrypt: (s) => s };

/**
 * SQLite-backed persistence for the 4 fixed channels: their connection
 * config, last-known control values, cached health, saved scenes and global
 * settings. Port of StateStore.php.
 *
 * Differences from the PHP schema: channel_health has a `status` (a
 * CameraState value) and `info` (model/serial JSON) in place of the obsolete
 * `ndi_hx_mode`, and passwords are stored through `secrets` (Electron
 * safeStorage in the app) instead of as plain text.
 */
class StateStore {
    constructor(dbPath, { defaultChannels = {}, defaultSettings, secrets = plainSecrets } = {}) {
        this.secrets = secrets;
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this.ensureSchema();
        this.seedDefaults(defaultChannels, defaultSettings);
    }

    close() {
        this.db.close();
    }

    ensureSchema() {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS channel_config (
    channel_id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT ${DEFAULT_PORT},
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS channel_state (
    channel_id INTEGER NOT NULL,
    control_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, control_key)
);
CREATE TABLE IF NOT EXISTS channel_health (
    channel_id INTEGER PRIMARY KEY,
    reachable INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    info TEXT,
    last_checked_at TEXT,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scene_values (
    scene_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    control_key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scene_id, channel_id, control_key)
);
CREATE TABLE IF NOT EXISTS settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
);`);
    }

    /**
     * Inserts anything missing, on every start: channel rows, health rows, a
     * state row per persisted control (so controls added in later versions
     * appear in existing databases) and the global settings.
     */
    seedDefaults(defaultChannels, defaultSettings) {
        const insertConfig = this.db.prepare(
            'INSERT OR IGNORE INTO channel_config (channel_id, display_name, ip_address, port, username, password) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertHealth = this.db.prepare('INSERT OR IGNORE INTO channel_health (channel_id, reachable) VALUES (?, 0)');
        const insertState = this.db.prepare(
            'INSERT OR IGNORE INTO channel_state (channel_id, control_key, value, updated_at) VALUES (?, ?, ?, ?)'
        );
        const insertSetting = this.db.prepare('INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)');

        const now = StateStore.now();
        this.db.transaction(() => {
            for (const channelId of CHANNEL_IDS) {
                const cfg = defaultChannels[channelId] ?? {};
                insertConfig.run(
                    channelId,
                    cfg.display_name ?? `CH${channelId}`,
                    cfg.ip_address ?? '',
                    cfg.port ?? DEFAULT_PORT,
                    cfg.username ?? '',
                    this.secrets.encrypt(cfg.password ?? '')
                );
                insertHealth.run(channelId);

                for (const [key, def] of Object.entries(registry.all())) {
                    if (registry.isMomentary(key)) continue; // never persisted or scene-able
                    insertState.run(channelId, key, JSON.stringify(def.default), now);
                }
            }

            for (const [key, value] of Object.entries(defaultSettings)) {
                insertSetting.run(key, JSON.stringify(value));
            }
        })();
    }

    /** Global settings (timeouts, poll, vmix). */
    getSettings() {
        const result = {};
        for (const row of this.db.prepare('SELECT setting_key, setting_value FROM settings').all()) {
            result[row.setting_key] = JSON.parse(row.setting_value);
        }
        return result;
    }

    setSetting(key, value) {
        this.db.prepare(
            `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
             ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`
        ).run(key, JSON.stringify(value));
    }

    /** Includes the decrypted password; only the main process should ever see it. */
    getChannelConfig(channelId) {
        const row = this.db.prepare(
            'SELECT display_name, ip_address, port, username, password FROM channel_config WHERE channel_id = ?'
        ).get(channelId);
        if (!row) {
            return { display_name: `CH${channelId}`, ip_address: '', port: DEFAULT_PORT, username: '', password: '' };
        }
        return { ...row, port: Number(row.port), password: this.secrets.decrypt(row.password) };
    }

    /** Returns { 1: config, 2: config, 3: config, 4: config }. */
    getAllChannelConfigs() {
        return Object.fromEntries(CHANNEL_IDS.map((id) => [id, this.getChannelConfig(id)]));
    }

    setChannelConfig(channelId, { ip_address, display_name, port = DEFAULT_PORT, username = '', password = '' }) {
        this.db.prepare(
            'UPDATE channel_config SET ip_address = ?, display_name = ?, port = ?, username = ?, password = ? WHERE channel_id = ?'
        ).run(ip_address, display_name, port, username, this.secrets.encrypt(password), channelId);
    }

    getChannelState(channelId) {
        const state = {};
        for (const row of this.db.prepare('SELECT control_key, value FROM channel_state WHERE channel_id = ?').all(channelId)) {
            state[row.control_key] = JSON.parse(row.value);
        }
        return state;
    }

    setControlValue(channelId, control, value) {
        this.db.prepare(
            `INSERT INTO channel_state (channel_id, control_key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(channel_id, control_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(channelId, control, JSON.stringify(value), StateStore.now());
    }

    getHealth(channelId) {
        const row = this.db.prepare(
            'SELECT reachable, status, info, last_checked_at, last_error FROM channel_health WHERE channel_id = ?'
        ).get(channelId);
        if (!row) {
            return { reachable: false, status: null, info: null, last_checked_at: null, last_error: null };
        }
        return {
            reachable: Boolean(row.reachable),
            status: row.status,
            info: row.info === null ? null : JSON.parse(row.info),
            last_checked_at: row.last_checked_at,
            last_error: row.last_error,
        };
    }

    /** info is only replaced when given, so a failed set doesn't wipe the model/serial from the last probe. */
    setHealth(channelId, { reachable, status, error = null, info }) {
        this.db.prepare(
            `INSERT INTO channel_health (channel_id, reachable, status, info, last_checked_at, last_error) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel_id) DO UPDATE SET reachable = excluded.reachable, status = excluded.status,
                 info = COALESCE(excluded.info, channel_health.info),
                 last_checked_at = excluded.last_checked_at, last_error = excluded.last_error`
        ).run(channelId, reachable ? 1 : 0, status, info === undefined ? null : JSON.stringify(info), StateStore.now(), error);
    }

    listScenes() {
        return this.db.prepare('SELECT id, name, scope, created_at FROM scenes ORDER BY created_at DESC, id DESC').all();
    }

    saveScene(name, scope, channelIds) {
        const insertValue = this.db.prepare(
            'INSERT INTO scene_values (scene_id, channel_id, control_key, value) VALUES (?, ?, ?, ?)'
        );
        return this.db.transaction(() => {
            const sceneId = Number(this.db.prepare('INSERT INTO scenes (name, scope, created_at) VALUES (?, ?, ?)')
                .run(name, scope, StateStore.now()).lastInsertRowid);
            for (const channelId of channelIds) {
                for (const [control, value] of Object.entries(this.getChannelState(channelId))) {
                    insertValue.run(sceneId, channelId, control, JSON.stringify(value));
                }
            }
            return sceneId;
        })();
    }

    deleteScene(sceneId) {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM scene_values WHERE scene_id = ?').run(sceneId);
            this.db.prepare('DELETE FROM scenes WHERE id = ?').run(sceneId);
        })();
    }

    /** Returns { channelId: { control: value } } for the scene, restricted to channelIds. */
    getSceneValues(sceneId, channelIds) {
        if (channelIds.length === 0) return {};
        const placeholders = channelIds.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT channel_id, control_key, value FROM scene_values WHERE scene_id = ? AND channel_id IN (${placeholders})`
        ).all(sceneId, ...channelIds);

        const result = {};
        for (const row of rows) {
            (result[row.channel_id] ??= {})[row.control_key] = JSON.parse(row.value);
        }
        return result;
    }

    sceneExists(sceneId) {
        return this.db.prepare('SELECT 1 FROM scenes WHERE id = ?').get(sceneId) !== undefined;
    }

    static now() {
        return new Date().toISOString();
    }
}

module.exports = { StateStore, CHANNEL_IDS, DEFAULT_PORT };
