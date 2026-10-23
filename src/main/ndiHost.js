const path = require('node:path');
const { utilityProcess, MessageChannelMain } = require('electron');

const ENTRY = path.join(__dirname, '..', 'ndi', 'ndiProcess.js');
const RESTART_DELAY_MS = 1000;

/**
 * Runs NDI in its own utilityProcess, so native decode work (and any crash
 * in it) stays out of the main process, and wires it to the panel window
 * with a direct MessagePort. If the process dies it's restarted and the
 * window gets a fresh port; the renderer just sees the previews reconnect.
 */
class NdiHost {
    constructor({ log = console.warn } = {}) {
        this.log = log;
        this.child = null;
        this.contents = null;
        this.stopping = false;
    }

    start() {
        this.stopping = false;
        this.child = utilityProcess.fork(ENTRY, [], { serviceName: 'NDI previews', stdio: 'pipe' });
        // Forward the process's logs into the main log, where everything else goes.
        this.child.stdout.on('data', (chunk) => process.stdout.write(chunk));
        this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
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
