import * as api from './api.js';

/**
 * The About box: app version, and the NDI notices NDI's licensing asks for
 * (trademark statement, copyright, a link to ndi.video, and its third-party
 * licenses file). Links marked data-external, here and in the header, open
 * in the user's browser through the main process, which only allows ndi.video.
 */
export function initAbout() {
    const modal = document.getElementById('about-modal');
    const versionEl = document.getElementById('about-version');
    const runtimeEl = document.getElementById('about-runtime');
    const errorEl = document.getElementById('about-error');
    let loaded = false;

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    async function open() {
        errorEl.hidden = true;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        if (loaded) return;
        try {
            const info = await api.getAppInfo();
            versionEl.textContent = `Version ${info.version}`;
            runtimeEl.textContent = `Electron ${info.electron} · ${info.platform}`;
            loaded = true;
        } catch (err) {
            versionEl.textContent = '';
            console.warn(`About: ${err.message}`);
        }
    }

    function close() {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }

    document.getElementById('about-open-btn').addEventListener('click', open);
    document.getElementById('about-modal-close-btn').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });

    document.getElementById('about-ndi-licenses-btn').addEventListener('click', () => {
        api.openNdiLicenses().catch((err) => showError(err.message));
    });

    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[data-external]');
        if (!link) return;
        e.preventDefault();
        api.openExternal(link.href).catch((err) => console.warn(`Could not open ${link.href}: ${err.message}`));
    });
}
