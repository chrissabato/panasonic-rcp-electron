import { createChannelStrip } from './channelStrip.js';
import { startPoller } from './poller.js';
import { initSceneManager } from './sceneManager.js';
import { startNdiPreviews } from './ndiView.js';
import { initAbout } from './about.js';
import * as api from './api.js';

const CHANNEL_IDS = [1, 2, 3, 4];
const strips = {};
const LINKED_KEY = 'rcp.linkedChannels';
const LOCKED_KEY = 'rcp.lockedChannels';

// Ganged ("linked") strips move together: a change on one is replayed on the
// others. Locked strips send nothing to their camera. Both are remembered per
// machine; a missing or blocked localStorage just starts with none.
const linked = new Set(loadChannelSet(LINKED_KEY));
const locked = new Set(loadChannelSet(LOCKED_KEY));
const linkAllBtn = document.getElementById('link-all-btn');
const previewToggleBtn = document.getElementById('preview-toggle-btn');

function loadChannelSet(key) {
    try {
        const ids = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(ids) ? ids.filter((id) => CHANNEL_IDS.includes(id)) : [];
    } catch {
        return [];
    }
}

function showLinked() {
    for (const id of CHANNEL_IDS) strips[id]?.setLinked(linked.has(id));
    linkAllBtn.textContent = linked.size === CHANNEL_IDS.length ? 'Ungang all' : 'Gang all';
    linkAllBtn.classList.toggle('on', linked.size === CHANNEL_IDS.length);
    saveChannelSet(LINKED_KEY, linked);
}

function showLocked() {
    for (const id of CHANNEL_IDS) strips[id]?.setLocked(locked.has(id));
    saveChannelSet(LOCKED_KEY, locked);
}

function saveChannelSet(key, set) {
    try {
        localStorage.setItem(key, JSON.stringify([...set]));
    } catch { /* not remembered; still works for this session */ }
}

function toggleLocked(channelId) {
    if (locked.has(channelId)) locked.delete(channelId);
    else locked.add(channelId);
    showLocked();
}

function toggleLinked(channelId) {
    if (linked.has(channelId)) linked.delete(channelId);
    else linked.add(channelId);
    showLinked();
}

function replayOnLinked(sourceId, control, value, final) {
    if (!linked.has(sourceId)) return;
    for (const id of linked) {
        if (id !== sourceId) strips[id]?.mirror(control, value, final);
    }
}

linkAllBtn.addEventListener('click', () => {
    if (linked.size === CHANNEL_IDS.length) linked.clear();
    else CHANNEL_IDS.forEach((id) => linked.add(id));
    showLinked();
});

const globalStatus = document.getElementById('global-status');
const stripsEl = document.getElementById('strips');

// Channels with no camera IP shrink to a slim card, so configured cameras get
// the width, up to --strip-max-width. Channels keep their positions, so CH3 is
// always third.
function sizeColumns() {
    const cols = CHANNEL_IDS.map((id) => (strips[id]?.isConfigured()
        ? 'minmax(0, var(--strip-max-width))'
        : 'minmax(120px, var(--strip-empty-width))')).join(' ');
    if (stripsEl.style.getPropertyValue('--cols') !== cols) stripsEl.style.setProperty('--cols', cols);
}
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
        sizeColumns();
        closeConfigModal();
    } catch (err) {
        globalStatus.textContent = `Failed to save CH${channelId} config: ${err.message}`;
        globalStatus.classList.add('error');
    }
});

initAbout();

// vMix tally is pushed the moment it changes; the fast poll also carries it.
window.rcp.onTally((tally) => {
    for (const id of CHANNEL_IDS) strips[id]?.setTally(tally[id] ?? null);
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
                onLocalChange: replayOnLinked,
                onLinkToggle: toggleLinked,
                onLockToggle: toggleLocked,
            });
            strip.init(data.controls, data.channels[channelId]);
            strips[channelId] = strip;
        }
        sizeColumns();

        showLinked();
        showLocked();
        sceneManager = initSceneManager({ isLocked: (id) => locked.has(id) });
        // Previews start stopped each launch: no NDI video is pulled until the
        // operator starts one (its own corner button) or all (this header button).
        const previews = startNdiPreviews(Object.fromEntries(CHANNEL_IDS.map((id) => [id, strips[id].preview])));
        const showPreviewButton = () => {
            const all = previews.allRunning();
            previewToggleBtn.textContent = all ? 'Stop all previews' : 'Start all previews';
            previewToggleBtn.classList.toggle('on', all);
            previewToggleBtn.setAttribute('aria-pressed', String(all));
        };
        previews.onChange(showPreviewButton);
        previewToggleBtn.addEventListener('click', () => previews.setAll(!previews.allRunning()));

        startPoller({
            fastMs: settings.poll.fast_ms,
            onFastUpdate: (channelsData) => {
                globalStatus.textContent = '';
                globalStatus.classList.remove('error');
                for (const id of CHANNEL_IDS) strips[id].update(channelsData[id]);
                sizeColumns();
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
