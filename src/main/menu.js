const { Menu, shell } = require('electron');

const NDI_URL = 'https://ndi.video/';

/**
 * The window's menu bar: Electron's standard File, Edit, View and Window
 * menus, plus Help with the About box and the link to ndi.video that NDI's
 * licensing asks for.
 */
function buildAppMenu({ panelUrl }) {
    // The About box lives on the panel page; from Settings, go back to the panel first.
    function showAbout(win) {
        if (!win) return;
        const contents = win.webContents;
        if (contents.getURL() === panelUrl) {
            contents.send('rcp:showAbout');
            return;
        }
        contents.once('did-finish-load', () => contents.send('rcp:showAbout'));
        contents.loadURL(panelUrl);
    }

    return Menu.buildFromTemplate([
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                { label: 'About AG-CX370 CCU', click: (_item, win) => showAbout(win) },
                { type: 'separator' },
                { label: 'NDI® website (ndi.video)', click: () => shell.openExternal(NDI_URL) },
            ],
        },
    ]);
}

module.exports = { buildAppMenu };
