const net = require('node:net');
const { EventEmitter } = require('node:events');

const RECONNECT_MS = 2000;
const INPUTS_REFRESH_MS = 10000;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);

/** "TALLY OK 0120" -> ['off', 'program', 'preview', 'off'], input 1 first; null for any other line. */
function parseTally(line) {
    const match = /^TALLY OK ([0-2]*)$/.exec(line);
    if (!match) return null;
    return [...match[1]].map((d) => (d === '1' ? 'program' : d === '2' ? 'preview' : 'off'));
}

/** vMix's XML state -> [{ key, number, title }] for every input. */
function parseInputs(xml) {
    const inputs = [];
    for (const tag of xml.matchAll(/<input ([^>]*)>/g)) {
        const attr = (name) => {
            const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag[1]);
            return m ? decodeXml(m[1]) : null;
        };
        const number = Number(attr('number'));
        if (attr('key') && Number.isInteger(number) && number > 0) {
            inputs.push({ key: attr('key'), number, title: attr('title') ?? '' });
        }
    }
    return inputs;
}

/**
 * Follows vMix's tally over its TCP API (port 8099): "SUBSCRIBE TALLY" makes
 * vMix push "TALLY OK <digit per input>" whenever program or preview changes.
 * Tally is reported per input number, but inputs move, so channels are mapped
 * by input key and the input list ("XML") is refreshed on the same connection
 * every 10 s. Reconnects on its own.
 *
 * Emits 'change' whenever the status, tally or input list changes.
 */
class VmixTally extends EventEmitter {
    constructor({ log = console.warn } = {}) {
        super();
        this.log = log;
        this.host = '';
        this.port = 8099;
        this.socket = null;
        this.retryTimer = null;
        this.refreshTimer = null;
        this.status = 'disabled'; // disabled | connecting | connected | unreachable
        this.version = null;
        this.inputs = [];
        this.tally = [];
        this.buffer = Buffer.alloc(0);
    }

    /** Points at a vMix machine; an empty host turns tally off. Reconnects only if something changed. */
    configure({ host = '', port = 8099 } = {}) {
        if (host === this.host && port === this.port && this.status !== 'disabled') return;
        this.host = host;
        this.port = port;
        this.disconnect();
        if (host) this.connect();
        else this.setStatus('disabled');
    }

    /** 'program', 'preview' or 'off' for the input with this key; null when unknown (no key, not connected, input gone). */
    tallyFor(key) {
        if (!key || this.status !== 'connected') return null;
        const input = this.inputs.find((i) => i.key === key);
        if (!input) return null;
        return this.tally[input.number - 1] ?? 'off';
    }

    stop() {
        this.disconnect();
        this.setStatus('disabled');
    }

    connect() {
        this.setStatus('connecting');
        const socket = net.connect({ host: this.host, port: this.port });
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.setTimeout(INPUTS_REFRESH_MS * 2); // the 10 s refresh keeps a healthy connection busy
        socket.on('connect', () => {
            this.setStatus('connected');
            socket.write('SUBSCRIBE TALLY\r\nXML\r\n');
            this.refreshTimer = setInterval(() => socket.write('XML\r\n'), INPUTS_REFRESH_MS);
        });
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('timeout', () => socket.destroy(new Error('no reply from vMix')));
        socket.on('error', (err) => {
            if (this.status !== 'unreachable') this.log(`vMix ${this.host}:${this.port}: ${err.message}`);
        });
        socket.on('close', () => {
            if (this.socket !== socket) return; // replaced by configure()
            this.cleanup();
            this.setStatus('unreachable');
            this.retryTimer = setTimeout(() => this.connect(), RECONNECT_MS);
        });
    }

    disconnect() {
        const socket = this.socket;
        this.cleanup();
        socket?.destroy();
    }

    cleanup() {
        clearTimeout(this.retryTimer);
        clearInterval(this.refreshTimer);
        this.retryTimer = null;
        this.refreshTimer = null;
        this.socket = null;
        this.tally = [];
    }

    setStatus(status) {
        if (status === this.status) return;
        this.status = status;
        this.emit('change');
    }

    /**
     * The stream is CRLF-terminated lines, except that an "XML <bytes>" line
     * is followed by exactly that many bytes of XML.
     */
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const eol = this.buffer.indexOf('\r\n');
            if (eol < 0) return;
            const line = this.buffer.subarray(0, eol).toString('utf8');
            const xml = /^XML (\d+)$/.exec(line);
            if (xml) {
                const end = eol + 2 + Number(xml[1]);
                if (this.buffer.length < end) return; // wait for the rest of the XML
                this.onInputs(parseInputs(this.buffer.subarray(eol + 2, end).toString('utf8')));
                this.buffer = this.buffer.subarray(end);
                continue;
            }
            this.buffer = this.buffer.subarray(eol + 2);
            this.onLine(line);
        }
    }

    onLine(line) {
        const tally = parseTally(line);
        if (tally) {
            if (tally.join() !== this.tally.join()) {
                this.tally = tally;
                this.emit('change');
            }
            return;
        }
        const version = /^VERSION OK (.+)$/.exec(line);
        if (version) this.version = version[1];
    }

    onInputs(inputs) {
        const before = JSON.stringify(this.inputs);
        this.inputs = inputs;
        if (JSON.stringify(inputs) !== before) this.emit('change');
    }
}

module.exports = { VmixTally, parseTally, parseInputs };
