import * as api from './api.js';

/** isLocked(channelId): locked channels are left out of every recall. */
export function initSceneManager({ isLocked = () => false } = {}) {
    const listEl = document.getElementById('scene-list');
    const nameInput = document.getElementById('scene-name-input');
    const scopeSelect = document.getElementById('scene-scope-select');
    const saveBtn = document.getElementById('scene-save-btn');
    const managerEl = document.getElementById('scene-manager');
    const modal = document.getElementById('scene-modal');
    const openBtn = document.getElementById('scenes-open-btn');
    const closeBtn = document.getElementById('scene-modal-close-btn');
    let resultEl = null;

    let lastRecalledSceneId = null;

    function openModal() {
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    }

    function closeModal() {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }

    openBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    async function refresh() {
        try {
            const data = await api.listScenes();
            render(data.scenes);
        } catch (err) {
            console.warn('Failed to load scenes:', err.message);
        }
    }

    function render(scenes) {
        listEl.innerHTML = '';
        if (scenes.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'scene-meta';
            empty.textContent = 'No saved scenes yet.';
            listEl.append(empty);
            return;
        }
        for (const scene of scenes) {
            const row = document.createElement('li');
            row.className = 'scene-row';

            const name = document.createElement('span');
            name.className = 'scene-name';
            name.textContent = scene.name;

            const meta = document.createElement('span');
            meta.className = 'scene-meta';
            meta.textContent = scene.scope === 'all' ? 'All 4 CH' : 'Single CH';

            const recallBtn = document.createElement('button');
            recallBtn.type = 'button';
            recallBtn.textContent = 'Recall';
            recallBtn.addEventListener('click', () => doRecall(scene.id, 'all'));

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.textContent = 'Delete';
            delBtn.className = 'danger';
            delBtn.addEventListener('click', () => doDelete(scene.id));

            row.append(name, meta, recallBtn, delBtn);
            listEl.append(row);
        }
    }

    async function doRecall(sceneId, channel) {
        const channels = channel === 'all' ? [1, 2, 3, 4] : [channel];
        const open = channels.filter((id) => !isLocked(id));
        const results = Object.fromEntries(channels.filter(isLocked).map((id) => [id, { locked: true }]));
        try {
            // With nothing locked, one call does every channel; otherwise recall the unlocked ones one by one.
            if (channel === 'all' && open.length === channels.length) {
                Object.assign(results, (await api.recallScene(sceneId, 'all')).results);
            } else {
                const replies = await Promise.all(open.map((id) => api.recallScene(sceneId, id)));
                for (const reply of replies) Object.assign(results, reply.results);
            }
            lastRecalledSceneId = sceneId;
        } catch (err) {
            console.warn('Recall failed:', err.message);
        }
        showResult(results);
    }

    function showResult(results) {
        if (!resultEl) {
            resultEl = document.createElement('div');
            resultEl.id = 'scene-result';
            resultEl.className = 'scene-result';
            managerEl.append(resultEl);
        }
        const parts = Object.entries(results).map(([channelId, r]) => {
            if (r.locked) return `CH${channelId}: locked, not recalled`;
            const bits = [];
            if (r.applied.length) bits.push(`${r.applied.length} applied`);
            if (r.failed.length) bits.push(`${r.failed.length} failed`);
            if (r.skipped.length) bits.push(`${r.skipped.length} skipped`);
            return `CH${channelId}: ${bits.join(', ') || 'no change'}`;
        });
        resultEl.textContent = parts.join('  |  ');
    }

    async function doDelete(sceneId) {
        try {
            await api.deleteScene(sceneId);
            await refresh();
        } catch (err) {
            console.warn('Delete failed:', err.message);
        }
    }

    saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        const scope = scopeSelect.value;
        const channels = scope === 'all' ? 'all' : [Number.parseInt(scope, 10)];
        try {
            await api.saveScene(name, channels);
            nameInput.value = '';
            await refresh();
        } catch (err) {
            console.warn('Save failed:', err.message);
        }
    });

    refresh();

    return {
        recallLastOnChannel(channelId) {
            // Open the modal so the result of this one-click action (from a
            // channel strip, with the modal normally closed) is actually visible.
            openModal();
            if (!lastRecalledSceneId) {
                showResult({ [channelId]: { applied: [], failed: [], skipped: [] } });
                console.info(`No scene recalled yet -- pick one from the list first.`);
                return;
            }
            doRecall(lastRecalledSceneId, channelId);
        },
    };
}
