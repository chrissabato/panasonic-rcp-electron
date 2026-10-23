// Thin wrapper over the preload bridge (window.rcp). Each call resolves with
// the handler's data, or throws an Error carrying the handler's error code.
async function request(name, body) {
    let reply;
    try {
        reply = await window.rcp[name](body);
    } catch (err) {
        throw new Error(`ipc error: ${err.message}`);
    }

    if (!reply.ok) {
        const err = new Error(reply.error || 'request failed');
        err.code = reply.code;
        throw err;
    }

    return reply.data;
}

export function getChannels() {
    return request('getChannels');
}

export function setControl(channel, control, value) {
    return request('setControl', { channel, control, value });
}

export function getConfig() {
    return request('getConfig');
}

// Omitted (undefined) fields keep their current values.
export function setConfig(channel, ipAddress, displayName, port, username, password) {
    return request('setConfig', { channel, ip_address: ipAddress, display_name: displayName, port, username, password });
}

export function listScenes() {
    return request('listScenes');
}

export function saveScene(name, channels) {
    return request('saveScene', { name, channels });
}

export function deleteScene(id) {
    return request('deleteScene', { id });
}

export function recallScene(sceneId, channel) {
    return request('recallScene', { scene_id: sceneId, channel });
}

export function getSettings() {
    return request('getSettings');
}

export function saveSettings(payload) {
    return request('saveSettings', payload);
}
