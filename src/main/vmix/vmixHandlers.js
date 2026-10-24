const net = require('node:net');
const { ApiError } = require('../handlers');
const { CHANNEL_IDS } = require('../state/StateStore');

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * IPC handlers for the vMix section of Settings. The "vmix" setting is
 * { host, port, channels: { channelId: { key, title } } }: each channel's
 * vMix input, by key (numbers change when inputs move) with its title kept
 * for display while vMix is unreachable. An empty host turns tally off.
 */
function createVmixHandlers({ store, vmix, onChanged = () => {} }) {
    function getVmix() {
        const { host, port, channels = {} } = store.getSettings().vmix;
        return {
            host,
            port,
            channels,
            status: vmix.status,
            version: vmix.version,
            inputs: vmix.inputs.map(({ key, number, title }) => ({ key, number, title })),
        };
    }

    /** Validates everything first, so a bad field never leaves a partial write. */
    function saveVmix(body = {}) {
        const host = String(body.host ?? '').trim();
        if (host !== '' && net.isIP(host) === 0 && !HOSTNAME.test(host)) {
            throw new ApiError('vMix address must be an IP address or host name', 'invalid_host');
        }
        const port = Number(body.port ?? 8099);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ApiError('vMix port must be between 1 and 65535', 'invalid_port');
        }

        const previous = store.getSettings().vmix.channels ?? {};
        const channels = {};
        for (const id of CHANNEL_IDS) {
            const key = String(body.channels?.[id] ?? '').trim();
            if (key === '') continue;
            const title = vmix.inputs.find((i) => i.key === key)?.title ?? previous[id]?.title ?? '';
            channels[id] = { key, title };
        }

        store.setSetting('vmix', { host, port, channels });
        vmix.configure({ host, port });
        onChanged();
        return getVmix();
    }

    return { getVmix, saveVmix };
}

module.exports = { createVmixHandlers };
