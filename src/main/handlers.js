const net = require('node:net');
const registry = require('./camera/controlRegistry');
const applier = require('./camera/controlApplier');
const { CameraState, CameraResponse } = require('./camera/cameraResponse');
const { parseDeviceInfo } = require('./camera/CameraClient');
const { CHANNEL_IDS } = require('./state/StateStore');

/** A request the caller got wrong; becomes { ok: false, error, code }. */
class ApiError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

function parseChannel(raw, { allowAll = false } = {}) {
    if (allowAll && (raw === undefined || raw === 'all')) {
        return CHANNEL_IDS;
    }
    const id = registry.toInt(raw);
    if (id < 1 || id > 4) {
        throw new ApiError(allowAll ? 'channel must be 1-4 or "all"' : 'channel must be 1-4', 'invalid_channel');
    }
    return allowAll ? [id] : id;
}

/** Channel config as the renderer may see it: never the password itself. */
function publicConfig({ password, ...rest }) {
    return { ...rest, has_password: password !== '' };
}

const FAILURE_CODES = {
    [CameraState.UNREACHABLE]: ['Camera unreachable', 'unreachable'],
    [CameraState.AUTH_FAILED]: ['Camera rejected the username or password', 'auth_failed'],
    [CameraState.UNEXPECTED]: ['Unexpected camera response', 'unexpected'],
    [CameraState.NOT_APPLIED]: ['Camera acknowledged the value but did not apply it', 'not_applied'],
};

/**
 * The IPC handlers. ctx supplies:
 *   store     StateStore
 *   queue     CommandQueue (one job at a time per camera)
 *   clientFor (channelId) => CameraClient built from the current config
 *   log       (message) => void
 */
function createHandlers(ctx) {
    const { store, queue, clientFor, log = console.warn } = ctx;

    /** Updates cached health from a control command's outcome. Unexpected replies leave it alone, as in the PHP. */
    function recordCommandHealth(channelId, response) {
        switch (response.state) {
            case CameraState.OK:
            case CameraState.NOT_APPLIED: // the camera answered normally; it just kept its own value
                store.setHealth(channelId, { reachable: true, status: CameraState.OK });
                break;
            case CameraState.UNREACHABLE:
                store.setHealth(channelId, { reachable: false, status: response.state, error: response.error });
                break;
            case CameraState.AUTH_FAILED:
                store.setHealth(channelId, { reachable: true, status: response.state, error: response.error });
                break;
            default:
                break;
        }
    }

    function applyControl(channelId, control, value) {
        if (store.getChannelConfig(channelId).ip_address === '') {
            return Promise.resolve(CameraResponse.unreachable('No IP address set'));
        }
        return queue.enqueue(channelId, control, () => applier.apply(clientFor(channelId), control, value));
    }

    /** Active probe of one camera (login + discovery query); stores and returns the result. */
    async function checkHealth(channelId) {
        if (store.getChannelConfig(channelId).ip_address === '') {
            store.setHealth(channelId, { reachable: false, status: CameraState.UNREACHABLE, error: 'No IP address set' });
            return store.getHealth(channelId);
        }

        const response = await queue.enqueue(channelId, 'health', () => clientFor(channelId).getDeviceInfo());
        if (response.isOk()) {
            store.setHealth(channelId, { reachable: true, status: CameraState.OK, info: parseDeviceInfo(response.body) });
        } else {
            if (response.state === CameraState.UNEXPECTED) {
                log(`health: unexpected response for channel ${channelId}: ${response.error ?? ''}`);
            }
            store.setHealth(channelId, {
                reachable: response.state !== CameraState.UNREACHABLE,
                status: response.state,
                error: response.error,
            });
        }
        return store.getHealth(channelId);
    }

    /**
     * Reads the camera's current values and stores them, so the panel shows
     * the camera's real state, including changes made on the camera body.
     * The renderer's pending guard keeps this from moving a control mid-drag.
     */
    async function refreshValues(channelId) {
        if (store.getChannelConfig(channelId).ip_address === '') {
            return;
        }
        const response = await queue.enqueue(channelId, 'readback', () => clientFor(channelId).readValues());
        recordCommandHealth(channelId, response);
        if (!response.isOk()) {
            log(`readback: channel ${channelId} failed (${response.state}): ${response.error ?? ''}`);
            return;
        }
        for (const [control, value] of Object.entries(response.body)) {
            store.setControlValue(channelId, control, value);
        }
    }

    /** One slow-poll tick for a channel: probe it, then read its values back if it's up. */
    async function pollChannel(channelId) {
        const health = await checkHealth(channelId);
        if (health.status === CameraState.OK) {
            await refreshValues(channelId);
        }
    }

    function getChannels() {
        const channels = {};
        for (const channelId of CHANNEL_IDS) {
            channels[channelId] = {
                config: publicConfig(store.getChannelConfig(channelId)),
                state: store.getChannelState(channelId),
                health: store.getHealth(channelId),
            };
        }
        return { channels, controls: registry.all() };
    }

    async function setControl(body = {}) {
        const channelId = parseChannel(body.channel);
        const control = String(body.control ?? '');
        if (!registry.isValid(control)) {
            throw new ApiError(`Unknown control '${control}'`, 'invalid_control');
        }
        if (!Object.hasOwn(body, 'value')) {
            throw new ApiError('Missing value', 'missing_value');
        }

        let value;
        try {
            value = registry.coerceValue(control, body.value);
        } catch (err) {
            throw new ApiError(err.message, 'invalid_value');
        }

        const response = await applyControl(channelId, control, value);
        recordCommandHealth(channelId, response);
        if (response.isOk()) {
            if (!registry.isMomentary(control)) {
                store.setControlValue(channelId, control, value);
            }
            return { channel: channelId, control, value };
        }

        if (response.state === CameraState.UNEXPECTED || response.state === CameraState.NOT_APPLIED) {
            log(`setControl: ${response.state} camera response for channel ${channelId} control ${control}: ${response.error ?? ''}`);
        }
        if (response.state === CameraState.NOT_APPLIED) {
            // Store what the camera actually holds, so the control snaps back to it.
            await refreshValues(channelId);
        }
        const [message, code] = FAILURE_CODES[response.state] ?? FAILURE_CODES[CameraState.UNEXPECTED];
        // The camera's own value is the useful part of a not_applied failure, so pass it through.
        throw new ApiError(response.state === CameraState.NOT_APPLIED ? response.error : message, code);
    }

    function getConfig() {
        const channels = {};
        for (const channelId of CHANNEL_IDS) {
            channels[channelId] = publicConfig(store.getChannelConfig(channelId));
        }
        return { channels };
    }

    /** Updates one channel's connection; omitted fields keep their current values. */
    async function setConfig(body = {}) {
        const channelId = parseChannel(body.channel);

        const ip = String(body.ip_address ?? '').trim();
        if (ip !== '' && net.isIP(ip) === 0) {
            throw new ApiError('Invalid IP address', 'invalid_ip');
        }
        const name = String(body.display_name ?? '').trim();
        if (name === '') {
            throw new ApiError('display_name is required', 'invalid_name');
        }

        const current = store.getChannelConfig(channelId);
        const port = body.port !== undefined ? registry.toInt(body.port) : current.port;
        if (port < 1 || port > 65535) {
            throw new ApiError('port must be between 1 and 65535', 'invalid_port');
        }

        store.setChannelConfig(channelId, {
            ip_address: ip !== '' ? ip : current.ip_address,
            display_name: name,
            port,
            username: body.username !== undefined ? String(body.username).trim() : current.username,
            password: body.password !== undefined ? String(body.password) : current.password,
        });

        // Re-check now so the UI reflects the new address without waiting for the slow poll.
        const health = await checkHealth(channelId);
        return { channel: channelId, config: publicConfig(store.getChannelConfig(channelId)), health };
    }

    function listScenes() {
        return { scenes: store.listScenes() };
    }

    function saveScene(body = {}) {
        const name = String(body.name ?? '').trim();
        if (name === '') {
            throw new ApiError('name is required', 'invalid_name');
        }

        const input = body.channels ?? 'all';
        const channelIds = input === 'all'
            ? CHANNEL_IDS
            : [...new Set([].concat(input).map(registry.toInt))];
        if (channelIds.length === 0) {
            throw new ApiError('At least one channel is required', 'invalid_channel');
        }
        if (channelIds.some((id) => id < 1 || id > 4)) {
            throw new ApiError('channels must each be 1-4', 'invalid_channel');
        }

        const scope = channelIds.length === 4 ? 'all' : 'single';
        const id = store.saveScene(name, scope, channelIds);
        return { id, name, scope, channels: channelIds };
    }

    function deleteScene(body = {}) {
        const id = registry.toInt(body.id);
        if (id < 1) {
            throw new ApiError('id is required', 'invalid_id');
        }
        store.deleteScene(id);
        return { deleted: id };
    }

    async function recallScene(body = {}) {
        const sceneId = registry.toInt(body.scene_id);
        if (sceneId < 1 || !store.sceneExists(sceneId)) {
            throw new ApiError('Scene not found', 'scene_not_found');
        }
        const channelIds = parseChannel(body.channel, { allowAll: true });

        const sceneValues = store.getSceneValues(sceneId, channelIds);
        const results = {};

        // Channels are independent cameras, so recall them in parallel; each
        // channel's own commands still run one at a time through the queue.
        await Promise.all(channelIds.map(async (channelId) => {
            const applied = [];
            const failed = [];
            const skipped = [];

            for (const [control, value] of Object.entries(sceneValues[channelId] ?? {})) {
                if (!registry.isValid(control) || registry.isMomentary(control)) {
                    skipped.push(control);
                    continue;
                }
                const response = await applyControl(channelId, control, value);
                recordCommandHealth(channelId, response);
                if (response.isOk()) {
                    store.setControlValue(channelId, control, value);
                    applied.push(control);
                } else {
                    failed.push({ control, reason: response.state });
                }
            }

            results[channelId] = { applied, failed, skipped };
        }));

        return { scene_id: sceneId, results };
    }

    function settingsPayload() {
        const settings = store.getSettings();
        return {
            timeouts: settings.timeouts,
            poll: settings.poll,
            channels: getConfig().channels,
        };
    }

    function getSettings() {
        return settingsPayload();
    }

    /** Validates everything first, so a bad field never leaves a partial write. */
    function saveSettings(body = {}) {
        const errors = [];
        const inRange = (v, lo, hi) => v >= lo && v <= hi;

        let timeouts = null;
        if (body.timeouts && typeof body.timeouts === 'object') {
            const connectMs = registry.toInt(body.timeouts.connect_ms);
            const totalMs = registry.toInt(body.timeouts.total_ms);
            if (!inRange(connectMs, 100, 30000)) errors.push('timeouts.connect_ms must be between 100 and 30000');
            if (!inRange(totalMs, 100, 30000)) errors.push('timeouts.total_ms must be between 100 and 30000');
            timeouts = { connect_ms: connectMs, total_ms: totalMs };
        }

        let poll = null;
        if (body.poll && typeof body.poll === 'object') {
            const fastMs = registry.toInt(body.poll.fast_ms);
            const slowMs = registry.toInt(body.poll.slow_ms);
            if (!inRange(fastMs, 200, 60000)) errors.push('poll.fast_ms must be between 200 and 60000');
            if (!inRange(slowMs, 1000, 300000)) errors.push('poll.slow_ms must be between 1000 and 300000');
            poll = { fast_ms: fastMs, slow_ms: slowMs };
        }

        const channelUpdates = {};
        if (body.channels && typeof body.channels === 'object') {
            for (const channelId of CHANNEL_IDS) {
                const entry = body.channels[channelId];
                if (!entry) continue;
                const current = store.getChannelConfig(channelId);

                const name = String(entry.display_name ?? '').trim();
                if (name === '') errors.push(`channel ${channelId}: display_name is required`);

                const ip = String(entry.ip_address ?? '').trim();
                if (ip !== '' && net.isIP(ip) === 0) errors.push(`channel ${channelId}: invalid IP address`);

                const port = registry.toInt(entry.port ?? current.port);
                if (!inRange(port, 1, 65535)) errors.push(`channel ${channelId}: port must be between 1 and 65535`);

                channelUpdates[channelId] = {
                    display_name: name,
                    ip_address: ip,
                    port,
                    username: String(entry.username ?? '').trim(),
                    // The renderer never receives passwords, so it only sends one when the user typed a new one.
                    password: entry.password !== undefined ? String(entry.password) : current.password,
                };
            }
        }

        if (errors.length > 0) {
            throw new ApiError(errors.join('; '), 'invalid_settings');
        }

        if (timeouts) store.setSetting('timeouts', timeouts);
        if (poll) store.setSetting('poll', poll);
        for (const [channelId, cfg] of Object.entries(channelUpdates)) {
            store.setChannelConfig(Number(channelId), cfg);
        }

        ctx.onSettingsChanged?.();
        return settingsPayload();
    }

    return {
        checkHealth,
        refreshValues,
        pollChannel,
        handlers: {
            getChannels,
            setControl,
            getConfig,
            setConfig,
            listScenes,
            saveScene,
            deleteScene,
            recallScene,
            getSettings,
            saveSettings,
        },
    };
}

module.exports = { createHandlers, ApiError };
