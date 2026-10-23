// Fake AG-CX370 P2 control port for tests. Replays the reply shapes recorded
// on real hardware (see PLAN.md "Protocol notes"): MD5 login, CamCtl sessions,
// ":c" ranges, ":?" values, self-closing set acks, ":!" / ":#" rejections,
// "Wrong User" on a bad password, and AWB's busy-then-settle sequence.
const crypto = require('node:crypto');
const net = require('node:net');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    isArray: (name) => name === 'CamCtl',
});
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const text = (node) => (node !== null && typeof node === 'object' ? node['#text'] ?? '' : String(node ?? ''));

const REALM = 'MovieRemote';

function startP2Sim({
    username = 'admin',
    password = 'secret',
    ranges = {
        Irs: [0, 20000], AIrsLv: [-50, 50], RGain: [-10, 10], BGain: [-10, 10],
        ZmSpd: [-49, 49], FcSpd: [-49, 49],
    },
    values = { Irs: '3363', AIrsSw: 'Off', AIrsLv: '0', RGain: '0', BGain: '-2', WBalSel: 'B', AFcSw: 'On', RTlySw: 'Off' },
    ignoredWrites = [],
    unsupported = [],
    busy = [],
    awbPollsBeforeSettle = 2,
    awbResult = 'Ok',
    chunked = false,
} = {}) {
    const state = { ...values };
    const received = [];
    const sockets = new Set();
    let nextSession = 1000;

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});

        let nonce = null;
        let sessionId = null;
        let awbPollsLeft = 0;
        let buffer = '';

        const reply = (xml) => {
            if (!chunked) {
                socket.write(xml);
                return;
            }
            // Split each reply into a few TCP writes to exercise reassembly.
            const step = Math.ceil(xml.length / 3);
            for (let i = 0; i < xml.length; i += step) {
                const piece = xml.slice(i, i + step);
                setTimeout(() => socket.writable && socket.write(piece), (i / step) * 5);
            }
        };
        const camCtl = (body, attrs = '') => `<P2Control><CamCtl${attrs}>${body}</CamCtl></P2Control>`;

        function handleCommand(cmd) {
            received.push(cmd);
            const m = /^\$(\w+):(.*)$/.exec(cmd);
            if (!m) return camCtl(`${cmd}:!`, ' Msg="Not Supported"');
            const [, field, rest] = m;

            if (field === 'Connect' && rest === '=Off') return '<P2Control />';
            if (field === 'Awb' && rest === 'Act') {
                awbPollsLeft = awbPollsBeforeSettle;
                return camCtl('$Awb:#');
            }
            if (field === 'Awb' && rest === '?') {
                if (awbPollsLeft > 0) {
                    awbPollsLeft--;
                    return camCtl('$Awb:sBusy');
                }
                return camCtl(`$Awb:s${awbResult}`);
            }
            if (rest === 'c') {
                return ranges[field] ? camCtl(`$${field}:i${ranges[field][0]},${ranges[field][1]}`) : camCtl(`$${field}:i!`);
            }
            if (rest === '?') {
                return field in state ? camCtl(`$${field}:s${state[field]}`) : camCtl(`$${field}:!`, ' Msg="Not Supported"');
            }
            if (rest.startsWith('=')) {
                if (unsupported.includes(field)) return camCtl(`$${field}:!`, ' Msg="Not Supported"');
                if (busy.includes(field)) return camCtl(`$${field}:#`);
                if (!ignoredWrites.includes(field)) state[field] = rest.slice(1);
                return '<P2Control />';
            }
            return camCtl(`$${field}:!`, ' Msg="Not Supported"');
        }

        function handleMessage(root) {
            if (root.Login !== undefined) {
                received.push(`Login:${text(root.Login)}`);
                nonce = crypto.randomBytes(8).toString('hex');
                return `<P2Control><Response><Realm>${REALM}</Realm><Nonce>${nonce}</Nonce></Response></P2Control>`;
            }

            const expected = md5(`${md5(`${username}:${REALM}:${password}`)}:${nonce}`);
            if (nonce === null || text(root.Auth) !== expected) {
                return '<P2Control><Error>Wrong User</Error></P2Control>';
            }

            if (root.Query !== undefined) {
                received.push('Query:env');
                return '<P2Control><Response><Env><ModelName>AG-CX370</ModelName><SerialNo.>DV24782369EC48</SerialNo.>'
                    + '<CmdTimeout>5000</CmdTimeout><RTInfo><Port>49153</Port></RTInfo></Env></Response></P2Control>';
            }

            const commands = (root.CamCtl ?? []).map(text);
            if (commands[0] === '$Connect:=On') {
                commands.forEach((c) => received.push(c));
                sessionId = String(nextSession++);
                return `<P2Control>${commands.map((c) => `<CamCtl SessionID="${sessionId}">${c}</CamCtl>`).join('')}</P2Control>`;
            }
            if (text(root.SessionID) !== sessionId) {
                return '<P2Control><Error>Invalid Session</Error></P2Control>';
            }
            return handleCommand(commands[0]);
        }

        socket.on('data', (chunk) => {
            buffer += chunk;
            if (XMLValidator.validate(buffer) !== true) return;
            const doc = parser.parse(buffer);
            buffer = '';
            reply(handleMessage(doc.P2Control ?? {}));
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                host: '127.0.0.1',
                port: server.address().port,
                state,
                received,
                close: () => new Promise((done) => {
                    for (const s of sockets) s.destroy();
                    server.close(done);
                }),
            });
        });
    });
}

module.exports = { startP2Sim };
