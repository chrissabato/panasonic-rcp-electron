const net = require('node:net');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => name === 'CamCtl',
});

/**
 * Parses one P2Control message and returns its root element as an object, or
 * null if the text isn't (yet) well-formed XML. A self-closing
 * "<P2Control />" ack comes back as an empty object.
 */
function parseP2Response(xml) {
    if (!xml || XMLValidator.validate(xml) !== true) {
        return null;
    }
    const doc = parser.parse(xml);
    const rootKey = Object.keys(doc).find((k) => !k.startsWith('?'));
    if (rootKey === undefined) {
        return null;
    }
    const root = doc[rootKey];
    return root !== null && typeof root === 'object' ? root : {};
}

/** Text content of a parsed element, whether or not it carried attributes. */
function textOf(node) {
    if (node === undefined || node === null) return null;
    if (typeof node === 'object') return node['#text'] !== undefined ? String(node['#text']) : '';
    return String(node);
}

/**
 * One TCP connection to a camera's P2 port. Replaces PHP's
 * stream_socket_client/stream_select loop with buffered socket events.
 */
class P2Connection {
    constructor(socket) {
        this.socket = socket;
        this.buffer = '';
        this.closed = false;
        this.waiter = null;

        socket.setEncoding('utf8');
        socket.setNoDelay(true); // small request/reply messages; don't let Nagle add latency to knob drags
        socket.on('data', (chunk) => {
            this.buffer += chunk;
            this.checkComplete();
        });
        const onEnd = () => {
            this.closed = true;
            this.finishRead();
        };
        socket.on('end', onEnd);
        socket.on('close', onEnd);
        socket.on('error', onEnd);
    }

    /** Resolves to a connected P2Connection, or rejects with an Error describing why not. */
    static open(host, port, connectTimeoutMs) {
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host, port });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`connect timeout after ${connectTimeoutMs} ms`));
            }, connectTimeoutMs);

            socket.once('connect', () => {
                clearTimeout(timer);
                socket.removeAllListeners('error');
                resolve(new P2Connection(socket));
            });
            socket.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    send(xml) {
        if (!this.closed) {
            this.socket.write(xml);
        }
    }

    /**
     * Resolves with the next complete P2Control message, or with whatever
     * arrived (possibly '') if timeoutMs elapses or the connection closes.
     * Completion is detected by the buffer parsing as XML rather than by
     * looking for a literal "</P2Control>" -- some acks are a self-closing
     * "<P2Control />", which would otherwise stall every such read for the
     * full timeout.
     */
    readXml(timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.finishRead(), timeoutMs);
            this.waiter = { resolve, timer };
            this.checkComplete();
            if (this.closed) this.finishRead();
        });
    }

    checkComplete() {
        if (this.waiter && parseP2Response(this.buffer) !== null) {
            this.finishRead();
        }
    }

    finishRead() {
        if (!this.waiter) return;
        const { resolve, timer } = this.waiter;
        this.waiter = null;
        clearTimeout(timer);
        const raw = this.buffer;
        this.buffer = '';
        resolve(raw);
    }

    close() {
        this.closed = true;
        this.socket.destroy();
    }
}

module.exports = { P2Connection, parseP2Response, textOf };
