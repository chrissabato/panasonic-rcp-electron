const path = require('node:path');
const { app, utilityProcess, MessageChannelMain } = require('electron');

const ENTRY = path.join(__dirname, '..', 'ndi', 'ndiProcess.js');
const RESTART_DELAY_MS = 1000;

/** ndi-helper.exe: bundled under resources/ in the installed app, built into native/ in development. */
function helperPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'ndi-helper', 'ndi-helper.exe')
        : path.join(__dirname, '..', '..', 'native', 'ndi-helper', 'build', 'ndi-helper.exe');
}

/**
 * Runs NDI in its own utilityProcess, so native decode work (and any crash
 * in it) stays out of the main process, and wires it to the panel window
 * with a direct MessagePort. If the process dies it's restarted, gets the
 * channel list again, and the window gets a fresh port; the renderer just
 * sees the previews reconnect.
 */
class NdiHost {
    constructor({ log = console.warn } = {}) {
        this.log = log;
        this.child = null;
        this.contents = null;
        this.channels = null;
        this.stopping = false;
    }

    start() {
        this.stopping = false;
        this.child = utilityProcess.fork(ENTRY, [`--ndi-helper=${helperPath()}`], { serviceName: 'NDI previews', stdio: 'pipe' });
        // Forward the process's logs into the main log, where everything else goes.
        this.child.stdout.on('data', (chunk) => process.stdout.write(chunk));
        this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
        if (this.channels) this.child.postMessage({ type: 'channels', channels: this.channels });
        this.child.on('exit', (code) => {
            this.child = null;
            if (this.stopping) return;
            this.log(`NDI process exited with code ${code}; restarting`);
            setTimeout(() => {
                if (this.stopping) return;
                this.start();
                if (this.contents && !this.contents.isDestroyed()) this.connect(this.contents);
            }, RESTART_DELAY_MS);
        });
    }

    /** Tells the NDI process each channel's camera, so it can pick that camera's NDI source. */
    setChannels(configs) {
        this.channels = Object.fromEntries(Object.entries(configs).map(([id, cfg]) => [id, { ip_address: cfg.ip_address }]));
        this.child?.postMessage({ type: 'channels', channels: this.channels });
    }

    /** Gives webContents a new port to the NDI process. Called when the panel page asks, and again after a restart. */
    connect(webContents) {
        this.contents = webContents;
        if (!this.child) return; // a restart is pending; it reconnects this page
        const { port1, port2 } = new MessageChannelMain();
        this.child.postMessage({ type: 'port' }, [port1]);
        webContents.postMessage('ndi:port', null, [port2]);
    }

    stop() {
        this.stopping = true;
        this.child?.kill();
        this.child = null;
    }
}

module.exports = { NdiHost };
