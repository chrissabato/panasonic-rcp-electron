const crypto = require('node:crypto');
const { CameraState, CameraResponse } = require('./cameraResponse');
const { P2Connection, parseP2Response, textOf } = require('./p2Connection');

const CONTROLLER_NAME = 'PanasonicRCP';
const AWB_SETTLED = new Set(['$Awb:sOk', '$Awb:sNg', '$Awb:sBreak']);
const AWB_MODES = { 1: 'A', 2: 'B', 10: 'Preset' };

/**
 * Fields read back from the camera on each poll, and the UI control each one
 * feeds. Scaled fields carry the UI range their live "$X:c" range maps onto,
 * matching the setters below.
 */
const READBACK = [
    { control: 'iris', field: 'Irs', ui: [0, 100] },
    { control: 'iris_level', field: 'AIrsLv', ui: [-50, 50] },
    { control: 'wb_r', field: 'RGain', ui: [0, 100] },
    { control: 'wb_b', field: 'BGain', ui: [0, 100] },
    { control: 'auto_iris', field: 'AIrsSw', kind: 'switch' },
    { control: 'auto_focus', field: 'AFcSw', kind: 'switch' },
    { control: 'tally', field: 'RTlySw', kind: 'switch' },
    { control: 'awb_mode', field: 'WBalSel', kind: 'awb' },
];

const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Converts a non-scaled "$X:?" value into its UI value, or null if it isn't one the UI knows. */
function parseReadback(kind, text) {
    if (kind === 'switch') {
        if (sameText(text, 'On')) return true;
        if (sameText(text, 'Off')) return false;
        return null;
    }
    const mode = Object.keys(AWB_MODES).find((key) => sameText(AWB_MODES[key], text));
    return mode === undefined ? null : Number(mode);
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Linearly maps uiValue from [uiMin, uiMax] into [nativeMin, nativeMax],
 * clamping first. With the ranges swapped it maps a camera value back to UI.
 */
function scaleToRange(uiValue, uiMin, uiMax, nativeMin, nativeMax) {
    const clamped = Math.max(uiMin, Math.min(uiMax, uiValue));
    const ratio = (clamped - uiMin) / (uiMax - uiMin);
    return Math.round(nativeMin + ratio * (nativeMax - nativeMin));
}

/**
 * Turns an <Error> reply into a response. The camera reports a wrong
 * password as "Wrong User" (confirmed on hardware), so that maps to
 * AUTH_FAILED rather than a generic unexpected reply.
 */
function errorResponse(raw, message) {
    return /wrong user|auth/i.test(message)
        ? CameraResponse.authFailed(raw, message)
        : CameraResponse.unexpected(raw, message);
}

/** Pulls ModelName and SerialNo. out of a <Query Type="env"/> reply, wherever they're nested. */
function parseDeviceInfo(raw) {
    const info = {};
    const wanted = { ModelName: 'model', 'SerialNo.': 'serial' };
    const walk = (node) => {
        if (node === null || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            if (wanted[key] && info[wanted[key]] === undefined) {
                info[wanted[key]] = textOf(Array.isArray(value) ? value[0] : value);
            }
            walk(value);
        }
    };
    walk(parseP2Response(raw ?? ''));
    return info;
}

/**
 * P2 Device Control Protocol client for the AG-CX370. Port of
 * CameraClient.php: a TCP connection per operation, XML bodies, MD5
 * challenge-response login, then a CamCtl session.
 *
 * Numeric controls don't have a fixed native range across models/firmware,
 * so each is queried live with "$X:c" and the UI value is scaled into
 * whatever range the camera reports.
 *
 * Every non-momentary set is read back with "$X:?" in the same session, and
 * reports NOT_APPLIED if the camera acknowledged it but holds another value.
 */
class CameraClient {
    constructor({ ipAddress, port = 49152, username = '', password = '', connectTimeoutMs = 1500, totalTimeoutMs = 2500 }) {
        this.ipAddress = ipAddress;
        this.port = port;
        this.username = username;
        this.password = password;
        this.connectTimeoutMs = connectTimeoutMs;
        this.totalTimeoutMs = totalTimeoutMs;
    }

    setAwbMode(mode) {
        if (!Object.hasOwn(AWB_MODES, mode)) {
            throw new RangeError(`Invalid AWB mode: ${mode}`);
        }
        return this.runVerifiedSet('WBalSel', AWB_MODES[mode]);
    }

    setWbRedGain(uiValue) {
        return this.runScaledCamCtlCommand('RGain', uiValue, 0, 100);
    }

    setWbBlueGain(uiValue) {
        return this.runScaledCamCtlCommand('BGain', uiValue, 0, 100);
    }

    // Red tally only: this camera family has a single-color lamp.
    setTally(on) {
        return this.runVerifiedSet('RTlySw', on ? 'On' : 'Off');
    }

    setIris(uiValue) {
        return this.runScaledCamCtlCommand('Irs', uiValue, 0, 100);
    }

    setAutoIris(on) {
        return this.runVerifiedSet('AIrsSw', on ? 'On' : 'Off');
    }

    /**
     * Auto iris level (exposure compensation), -50..+50. Only affects the
     * picture while auto iris is on. "$AIrsLv" holds its value, unlike an
     * "$Irs" set under auto iris, which the auto loop overrides within ~2 s.
     */
    setIrisLevel(uiValue) {
        return this.runScaledCamCtlCommand('AIrsLv', uiValue, -50, 50);
    }

    /**
     * Zoom speed, 1-99 (50 = stop), scaled into the camera's own signed speed
     * range. A speed is a motion command, not a value that holds, so it isn't read back.
     */
    setZoomSpeed(speed) {
        return this.runScaledCamCtlCommand('ZmSpd', Math.max(1, Math.min(99, speed)), 1, 99, { verify: false });
    }

    /** Focus speed, same 1-99 (50 = stop) scheme as zoom. */
    setFocusSpeed(speed) {
        return this.runScaledCamCtlCommand('FcSpd', Math.max(1, Math.min(99, speed)), 1, 99, { verify: false });
    }

    setAutoFocus(on) {
        return this.runVerifiedSet('AFcSw', on ? 'On' : 'Off');
    }

    /**
     * One-shot AWB on the selected channel. "$Awb:Act" always answers busy
     * ("$Awb:#") at first, so its own reply is ignored and "$Awb:?" is polled
     * until it settles.
     */
    triggerAwb() {
        return this.withSession(async (session) => {
            await session.camCtl('$Awb:Act');

            let settled = null;
            let lastPoll = null;
            for (let i = 0; i < 10 && settled === null; i++) {
                await sleep(300);
                lastPoll = await session.camCtl('$Awb:?');
                if (lastPoll.isOk() && AWB_SETTLED.has(lastPoll.body)) {
                    settled = lastPoll.body;
                }
            }

            if (settled === null) {
                return lastPoll ?? CameraResponse.unexpected(null, 'AWB did not settle within timeout');
            }
            return settled === '$Awb:sOk'
                ? CameraResponse.ok(settled)
                : CameraResponse.unexpected(settled, `AWB did not succeed: ${settled}`);
        });
    }

    /** Discovery query; on success the body is the raw XML (see parseDeviceInfo). */
    async getDeviceInfo() {
        const auth = await this.authenticate();
        if (auth instanceof CameraResponse) {
            return auth;
        }
        const { conn, token } = auth;

        conn.send(`<P2Control><Auth>${token}</Auth><Query Type="env"/></P2Control>`);
        const raw = await conn.readXml(this.totalTimeoutMs);
        conn.close();

        if (raw === '') {
            return CameraResponse.unreachable('No response from camera during environment query');
        }
        const root = parseP2Response(raw);
        if (root === null) {
            return CameraResponse.unexpected(raw, 'Malformed environment query response');
        }
        if (root.Error !== undefined) {
            return errorResponse(raw, textOf(root.Error));
        }
        return CameraResponse.ok(raw);
    }

    /**
     * Reads the camera's current value for every READBACK field in one
     * session. On success the body is { control: uiValue } for each field the
     * camera answered; a field it rejects is left out rather than failing
     * the whole read.
     */
    readValues() {
        return this.withSession(async (session) => {
            const values = {};
            for (const { control, field, ui, kind } of READBACK) {
                const current = await session.readValue(field);
                if (current.state === CameraState.UNREACHABLE || current.state === CameraState.AUTH_FAILED) {
                    return current;
                }
                if (!current.isOk()) continue;

                let value;
                if (ui) {
                    const bounds = await session.readBounds(field);
                    if (!bounds.isOk() || !/^-?\d+$/.test(current.body)) continue;
                    const [min, max] = bounds.body;
                    value = scaleToRange(Number(current.body), min, max, ui[0], ui[1]);
                } else {
                    value = parseReadback(kind, current.body);
                }
                if (value !== null) values[control] = value;
            }
            return CameraResponse.ok(values);
        });
    }

    /** Sets a boolean/enum field to text through a fresh session, then reads it back. */
    runVerifiedSet(field, text) {
        return this.withSession(async (session) => {
            const set = await session.camCtl(`$${field}:=${text}`);
            return set.isOk() ? session.verifySet(field, set, (actual) => sameText(actual, text)) : set;
        });
    }

    /**
     * Queries the camera's own min/max for field ("$Irs:c" -> "$Irs:i0,20000"),
     * scales uiValue into it, sends the absolute set, then reads it back -- all
     * in one session. The read-back counts as applied when it maps to the same
     * UI value, so a camera that rounds to its own step size still passes.
     */
    runScaledCamCtlCommand(field, uiValue, uiMin, uiMax, { verify = true } = {}) {
        return this.withSession(async (session) => {
            const bounds = await session.readBounds(field);
            if (!bounds.isOk()) {
                return bounds;
            }
            const [min, max] = bounds.body;

            const native = scaleToRange(uiValue, uiMin, uiMax, min, max);
            const set = await session.camCtl(`$${field}:=${native}`);
            if (!set.isOk() || !verify) {
                return set;
            }

            const toUi = (n) => scaleToRange(n, min, max, uiMin, uiMax);
            return session.verifySet(field, set, (actual) => /^-?\d+$/.test(actual) && toUi(Number(actual)) === toUi(native));
        });
    }

    /**
     * Opens a control session, runs fn(session), and always tears the session
     * down afterwards. Returns fn's response, or the failure that stopped the
     * session from opening.
     */
    async withSession(fn) {
        const session = await this.openControlSession();
        if (session instanceof CameraResponse) {
            return session;
        }
        try {
            return await fn(session);
        } finally {
            await session.close();
        }
    }

    /**
     * Connects and performs the Login/Auth handshake (P2 protocol 6.2).
     * Returns { conn, token } on success, or a failure CameraResponse.
     * The caller owns conn and must close it.
     */
    async authenticate() {
        let conn;
        try {
            conn = await P2Connection.open(this.ipAddress, this.port, this.connectTimeoutMs);
        } catch (err) {
            return CameraResponse.unreachable(err.message || String(err.code));
        }

        conn.send(`<P2Control><Login>${this.username}</Login></P2Control>`);
        const raw = await conn.readXml(this.totalTimeoutMs);

        const fail = (response) => {
            conn.close();
            return response;
        };
        if (raw === '') {
            return fail(CameraResponse.unreachable('No response from camera during login'));
        }
        const root = parseP2Response(raw);
        if (root === null) {
            return fail(CameraResponse.unexpected(raw, 'Malformed login response'));
        }
        if (root.Error !== undefined) {
            return fail(errorResponse(raw, textOf(root.Error)));
        }
        const realm = textOf(root.Response?.Realm);
        const nonce = textOf(root.Response?.Nonce);
        if (realm === null || nonce === null) {
            return fail(CameraResponse.unexpected(raw, 'Login response missing Realm/Nonce'));
        }

        const inner = md5(`${this.username}:${realm}:${this.password}`);
        return { conn, token: md5(`${inner}:${nonce}`) };
    }

    /**
     * Authenticates, then registers as a controller ("$Connect:=On" +
     * "$MyName:s...") to get the SessionID every later CamCtl must carry.
     */
    async openControlSession() {
        const auth = await this.authenticate();
        if (auth instanceof CameraResponse) {
            return auth;
        }
        const { conn, token } = auth;

        conn.send(`<P2Control><Auth>${token}</Auth><SessionID></SessionID>`
            + `<CamCtl>$Connect:=On</CamCtl><CamCtl>$MyName:s${CONTROLLER_NAME}</CamCtl></P2Control>`);
        const raw = await conn.readXml(this.totalTimeoutMs);

        const fail = (response) => {
            conn.close();
            return response;
        };
        if (raw === '') {
            return fail(CameraResponse.unreachable('No response from camera during connect'));
        }
        const root = parseP2Response(raw);
        if (root === null) {
            return fail(CameraResponse.unexpected(raw, 'Malformed connect response'));
        }
        if (root.Error !== undefined) {
            return fail(errorResponse(raw, textOf(root.Error)));
        }
        const sessionId = root.CamCtl?.[0]?.['@_SessionID'];
        if (!sessionId) {
            return fail(CameraResponse.unexpected(raw, 'No SessionID in connect response'));
        }

        return new ControlSession(conn, token, sessionId, this.totalTimeoutMs);
    }
}

/** An open, authenticated CamCtl session on one connection. */
class ControlSession {
    constructor(conn, token, sessionId, totalTimeoutMs) {
        this.conn = conn;
        this.token = token;
        this.sessionId = sessionId;
        this.totalTimeoutMs = totalTimeoutMs;
    }

    /** Sends one CamCtl command; on success the response body is the first <CamCtl> reply text. */
    async camCtl(command) {
        this.conn.send(`<P2Control><Auth>${this.token}</Auth><SessionID>${this.sessionId}</SessionID>`
            + `<CamCtl>${command}</CamCtl></P2Control>`);
        const raw = await this.conn.readXml(this.totalTimeoutMs);

        if (raw === '') {
            return CameraResponse.unreachable('No response from camera');
        }
        const root = parseP2Response(raw);
        if (root === null) {
            return CameraResponse.unexpected(raw, 'Malformed CamCtl response');
        }
        if (root.Error !== undefined) {
            return errorResponse(raw, textOf(root.Error));
        }

        const text = textOf(root.CamCtl?.[0]);

        // Per-command rejections aren't <Error> elements: they're a trailing
        // ":!" (not supported) or ":#" (busy, not applied) on the CamCtl text.
        if (text !== null && text.endsWith(':!')) {
            return CameraResponse.unexpected(raw, `Command not supported by camera: ${command}`);
        }
        if (text !== null && text.endsWith(':#')) {
            return CameraResponse.unexpected(raw, `Camera busy, command not applied: ${command}`);
        }

        return CameraResponse.ok(text ?? raw);
    }

    /** "$X:?" -> on success the body is the value text after ":s" ("$Irs:s3363" -> "3363"). */
    async readValue(field) {
        const response = await this.camCtl(`$${field}:?`);
        if (!response.isOk()) {
            return response;
        }
        const prefix = `$${field}:s`;
        return typeof response.body === 'string' && response.body.startsWith(prefix)
            ? CameraResponse.ok(response.body.slice(prefix.length))
            : CameraResponse.unexpected(response.body, `Could not parse ${field} value from camera response`);
    }

    /** "$X:c" -> on success the body is [min, max] ("$Irs:i0,20000" -> [0, 20000]). */
    async readBounds(field) {
        const response = await this.camCtl(`$${field}:c`);
        if (!response.isOk()) {
            return response;
        }
        const match = new RegExp(`\\$${field}:i(-?\\d+),(-?\\d+)`).exec(response.body);
        return match
            ? CameraResponse.ok([Number(match[1]), Number(match[2])])
            : CameraResponse.unexpected(response.body, `Could not parse ${field} bounds from camera response`);
    }

    /**
     * Reads field back after an acknowledged set. NOT_APPLIED if matches()
     * rejects the camera's value; if the read itself fails, the set's own
     * result stands, since the camera did acknowledge it.
     */
    async verifySet(field, setResponse, matches) {
        const actual = await this.readValue(field);
        if (!actual.isOk() || matches(actual.body)) {
            return setResponse;
        }
        return CameraResponse.notApplied(actual.body, `Camera acknowledged ${field} but reads back ${actual.body}`);
    }

    /** Best-effort teardown; failures here are not surfaced to the caller. */
    async close() {
        await this.camCtl('$Connect:=Off');
        this.conn.close();
    }
}

module.exports = { CameraClient, scaleToRange, parseDeviceInfo };
