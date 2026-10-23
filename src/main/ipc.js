const { ipcMain } = require('electron');
const { ApiError } = require('./handlers');

/**
 * Registers each handler as an "rcp:<name>" invoke channel. Replies keep the
 * PHP API's envelope: { ok: true, data } or { ok: false, error, code }.
 */
function registerIpc(handlers, { isTrustedSender, log = console.error }) {
    for (const [name, fn] of Object.entries(handlers)) {
        ipcMain.handle(`rcp:${name}`, async (event, body) => {
            if (!isTrustedSender(event.senderFrame)) {
                return { ok: false, error: 'Forbidden', code: 'forbidden' };
            }
            try {
                return { ok: true, data: await fn(body) };
            } catch (err) {
                if (err instanceof ApiError) {
                    return { ok: false, error: err.message, code: err.code };
                }
                log(`rcp:${name}: ${err.stack ?? err}`);
                return { ok: false, error: 'Internal error', code: 'internal_error' };
            }
        });
    }
}

module.exports = { registerIpc };
