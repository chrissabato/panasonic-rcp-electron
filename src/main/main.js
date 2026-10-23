const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron');

const APP_ORIGIN = 'app://rcp';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

const DEFAULT_SETTINGS = {
    timeouts: { connect_ms: 1500, total_ms: 2500 },
    poll: { fast_ms: 400, slow_ms: 7000 },
};

// The renderer is served from app://rcp/ rather than file:// so ES modules
// load and every response carries the CSP header.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/**
 * Native modules must match the process architecture (an x64 .node file
 * won't load into a win32-arm64 Electron), so load them up front and fail
 * with a clear message instead of a stack trace mid-session.
 */
function loadNativeModules() {
    console.log(`Electron ${process.versions.electron} on ${process.platform}-${process.arch}`);
    try {
        require('better-sqlite3');
    } catch (err) {
        dialog.showErrorBox(
            'Native module failed to load',
            `better-sqlite3 could not be loaded for ${process.platform}-${process.arch}. `
            + `This usually means it was built for a different CPU architecture.\n\n${err.message}`
        );
        app.exit(1);
        return false;
    }
    return true;
}

function serveRenderer() {
    protocol.handle('app', async (request) => {
        const { pathname } = new URL(request.url);
        const filePath = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
        if (!filePath.startsWith(RENDERER_DIR + path.sep)) {
            return new Response('Not found', { status: 404 });
        }
        const file = await net.fetch(pathToFileURL(filePath).toString());
        const headers = new Headers(file.headers);
        headers.set('Content-Security-Policy', CSP);
        return new Response(file.body, { status: file.status, headers });
    });
}

const isAppUrl = (url) => typeof url === 'string' && url.startsWith(`${APP_ORIGIN}/`);

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        backgroundColor: '#111',
        // Installed, the exe carries the icon; in development, point the window at it.
        icon: app.isPackaged ? undefined : path.join(__dirname, '..', '..', 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!isAppUrl(url)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.loadURL(`${APP_ORIGIN}/index.html`);
    return win;
}

async function start() {
    await app.whenReady();
    if (!loadNativeModules()) return;

    const { StateStore } = require('./state/StateStore');
    const { CameraClient } = require('./camera/CameraClient');
    const { CommandQueue } = require('./camera/commandQueue');
    const { createHandlers } = require('./handlers');
    const { registerIpc } = require('./ipc');
    const { HealthPoller } = require('./poller');
    const { createSecrets } = require('./secrets');
    const { NdiHost, helperPath } = require('./ndiHost');
    const { createAppHandlers } = require('./appHandlers');

    const store = new StateStore(path.join(app.getPath('userData'), 'rcp.sqlite'), {
        defaultSettings: DEFAULT_SETTINGS,
        secrets: createSecrets(),
    });

    // Built per command from the stored config, so settings changes apply immediately.
    const clientFor = (channelId) => {
        const cfg = store.getChannelConfig(channelId);
        const { timeouts } = store.getSettings();
        return new CameraClient({
            ipAddress: cfg.ip_address,
            port: cfg.port,
            username: cfg.username,
            password: cfg.password,
            connectTimeoutMs: timeouts.connect_ms,
            totalTimeoutMs: timeouts.total_ms,
        });
    };

    let poller = null;
    const ndi = new NdiHost();
    const { handlers, pollChannel } = createHandlers({
        store,
        queue: new CommandQueue(),
        clientFor,
        onSettingsChanged: () => poller?.restart(),
        onChannelConfigChanged: () => ndi.setChannels(store.getAllChannelConfigs()),
    });
    const appHandlers = createAppHandlers({
        ndiLicensesPath: path.join(path.dirname(helperPath()), 'Processing.NDI.Lib.Licenses.txt'),
    });
    registerIpc({ ...handlers, ...appHandlers }, { isTrustedSender: (frame) => isAppUrl(frame?.url) });

    poller = new HealthPoller({ pollChannel, getIntervalMs: () => store.getSettings().poll.slow_ms });
    poller.start();

    ndi.setChannels(store.getAllChannelConfigs());
    ndi.start();
    ipcMain.on('ndi:connect', (event) => {
        if (isAppUrl(event.senderFrame?.url)) ndi.connect(event.sender);
    });

    serveRenderer();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    app.on('will-quit', () => {
        poller.stop();
        ndi.stop();
        store.close();
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

start().catch((err) => {
    dialog.showErrorBox('Failed to start', err.stack ?? String(err));
    app.exit(1);
});
