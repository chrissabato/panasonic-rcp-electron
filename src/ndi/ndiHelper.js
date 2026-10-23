const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createMessageReader } = require('./helperProtocol');

const RESTART_DELAY_MS = 2000;

/**
 * Picks each channel's NDI source: the one whose address is the channel's
 * camera IP ("192.168.4.40:5961" for a camera at 192.168.4.40).
 * channels: { id: { ip_address } }, sources: [{ name, url }]. Returns { id: name | null }.
 */
function matchSources(channels, sources) {
    const result = {};
    for (const [id, { ip_address: ip }] of Object.entries(channels)) {
        const source = ip ? sources.find((s) => s.url.split(':')[0] === ip) : undefined;
        result[id] = source?.name ?? null;
    }
    return result;
}

/**
 * Runs ndi-helper.exe (x64, under emulation: NDI has no Windows ARM64
 * library) and restarts it if it exits. Events:
 *   'sources' (list)            NDI sources on the network changed
 *   'status' (channel, status)  connecting | connected
 *   'frame' (channel)           a new frame is in latest(channel)
 *   'restart'                   the helper restarted; connections are gone
 */
class NdiHelper extends EventEmitter {
    constructor(exePath, { log = console.warn } = {}) {
        super();
        this.exePath = exePath;
        this.log = log;
        this.child = null;
        this.frames = new Map();
        this.extraIps = '';
        this.stopping = false;
    }

    start() {
        this.stopping = false;
        const child = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        const read = createMessageReader((message) => this.onMessage(message));
        child.stdout.on('data', read);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (text) => {
            for (const line of text.split(/\r?\n/)) if (line) this.log(`[ndi-helper] ${line}`);
        });
        child.stdin.on('error', () => {}); // the exit handler deals with a dead helper
        child.on('error', (err) => this.log(`ndi-helper failed to start: ${err.message}`));
        child.on('exit', (code) => {
            if (this.child !== child) return;
            this.child = null;
            this.frames.clear();
            if (this.stopping) return;
            this.log(`ndi-helper exited with code ${code}; restarting`);
            setTimeout(() => {
                if (this.stopping) return;
                this.start();
                this.emit('restart');
            }, RESTART_DELAY_MS);
        });
        if (this.extraIps) this.send(`find ${this.extraIps}`);
    }

    stop() {
        this.stopping = true;
        this.child?.stdin.end(); // the helper exits when its input closes
        this.child = null;
    }

    send(line) {
        this.child?.stdin.write(`${line}\n`);
    }

    /** Also query these camera IPs directly, so discovery doesn't depend on mDNS getting through the firewall. */
    find(ips) {
        this.extraIps = ips.filter(Boolean).join(',');
        this.send(`find ${this.extraIps}`);
    }

    connect(channel, sourceName) {
        this.frames.delete(channel);
        this.send(`connect ${channel} ${sourceName}`);
    }

    disconnect(channel) {
        this.frames.delete(channel);
        this.send(`disconnect ${channel}`);
    }

    /** The newest frame for channel: { format, width, height, stride, data }, or undefined. */
    latest(channel) {
        return this.frames.get(channel);
    }

    onMessage(message) {
        if (message.type === 'frame') {
            this.frames.set(message.channel, message);
            this.emit('frame', message.channel);
        } else if (message.value?.type === 'sources') {
            this.emit('sources', message.value.sources);
        } else if (message.value?.type === 'status') {
            this.emit('status', message.value.channel, message.value.status);
        }
    }
}

module.exports = { NdiHelper, matchSources };
