import { createChannelStrip } from './channelStrip.js';
import { startPoller } from './poller.js';
import { initSceneManager } from './sceneManager.js';
import { startNdiPreviews } from './ndiView.js';
import * as api from './api.js';

const CHANNEL_IDS = [1, 2, 3, 4];
const strips = {};

const globalStatus = document.getElementById('global-status');
const modal = document.getElementById('channel-config-modal');
const modalForm = document.getElementById('channel-config-form');
const modalChannelId = document.getElementById('config-channel-id');
const modalName = document.getElementById('config-display-name');
const modalIp = document.getElementById('config-ip-address');

function openConfigModal(channelId, config) {
    modalChannelId.value = String(channelId);
    modalName.value = config.display_name || '';
    modalIp.value = config.ip_address || '';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    modalName.focus();
}

function closeConfigModal() {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

document.getElementById('config-cancel-btn').addEventListener('click', closeConfigModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeConfigModal(); });

modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const channelId = Number(modalChannelId.value);
    try {
        const result = await api.setConfig(channelId, modalIp.value.trim(), modalName.value.trim());
        strips[channelId]?.update({ config: result.config, state: {}, health: result.health });
        closeConfigModal();
    } catch (err) {
        globalStatus.textContent = `Failed to save CH${channelId} config: ${err.message}`;
        globalStatus.classList.add('error');
    }
});

async function bootstrap() {
    let sceneManager = null;

    try {
        const [data, settings] = await Promise.all([api.getChannels(), api.getSettings()]);

        for (const channelId of CHANNEL_IDS) {
            const root = document.getElementById(`channel-${channelId}`);
            const strip = createChannelStrip(channelId, root, {
                onConfigOpen: openConfigModal,
                onQuickRecall: (id) => sceneManager?.recallLastOnChannel(id),
            });
            strip.init(data.controls, data.channels[channelId]);
            strips[channelId] = strip;
        }

        sceneManager = initSceneManager();
        startNdiPreviews(Object.fromEntries(CHANNEL_IDS.map((id) => [id, strips[id].preview])));

        startPoller({
            fastMs: settings.poll.fast_ms,
            onFastUpdate: (channelsData) => {
                globalStatus.textContent = '';
                globalStatus.classList.remove('error');
                for (const id of CHANNEL_IDS) strips[id].update(channelsData[id]);
            },
            onFastError: (err) => {
                globalStatus.textContent = `Connection to controller lost: ${err.message}`;
                globalStatus.classList.add('error');
            },
        });
    } catch (err) {
        globalStatus.textContent = `Failed to load: ${err.message}`;
        globalStatus.classList.add('error');
    }
}

bootstrap();
