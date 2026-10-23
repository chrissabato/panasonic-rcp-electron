const { app, shell } = require('electron');
const { ApiError } = require('./handlers');

// The only pages the renderer may open in the user's browser. NDI's licensing
// asks for a link to ndi.video wherever NDI is used, and in the About box.
const EXTERNAL_LINKS = new Set(['https://ndi.video/']);

/**
 * IPC handlers for the About box: app details, and opening the two things it
 * links to. The renderer can't navigate or open windows itself (see main.js),
 * so these are the only ways out, and each is limited to a fixed target.
 */
function createAppHandlers({ ndiLicensesPath }) {
    return {
        getAppInfo() {
            return {
                version: app.getVersion(),
                electron: process.versions.electron,
                platform: `${process.platform}-${process.arch}`,
            };
        },

        async openExternal(body = {}) {
            const url = String(body.url ?? '');
            if (!EXTERNAL_LINKS.has(url)) {
                throw new ApiError('That link is not allowed', 'forbidden_link');
            }
            await shell.openExternal(url);
            return { opened: url };
        },

        /** Opens NDI's third-party licenses file, shipped beside the NDI DLL as NDI requires. */
        async openNdiLicenses() {
            const error = await shell.openPath(ndiLicensesPath);
            if (error) {
                throw new ApiError(`Could not open the NDI licenses file: ${error}`, 'not_found');
            }
            return { opened: true };
        },
    };
}

module.exports = { createAppHandlers };
