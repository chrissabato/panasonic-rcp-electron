const crypto = require('node:crypto');
const { CameraResponse } = require('./cameraResponse');
const { P2Connection, parseP2Response, textOf } = require('./p2Connection');

const CONTROLLER_NAME = 'PanasonicRCP';
const AWB_SETTLED = new Set(['$Awb:sOk', '$Awb:sNg', '$Awb:sBreak']);

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Linearly maps uiValue from [uiMin, uiMax] into [nativeMin, nativeMax], clamping first. */
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
        const channels = { 1: 'A', 2: 'B', 10: 'Preset' };
        if (!Object.hasOwn(channels, mode)) {
            throw new RangeError(`Invalid AWB mode: ${mode}`);
        }
        return this.runCamCtlCommand(`$WBalSel:=${channels[mode]}`);
    }

    setWbRedGain(uiValue) {
        return this.runScaledCamCtlCommand('RGain', uiValue, 0, 100);
    }

    setWbBlueGain(uiValue) {
        return this.runScaledCamCtlCommand('BGain', uiValue, 0, 100);
    }

    // Red tally only: this camera family has a single-color lamp.
    setTally(on) {
        return this.runCamCtlCommand(`$RTlySw:=${on ? 'On' : 'Off'}`);
    }

    setIris(uiValue) {
        return this.runScaledCamCtlCommand('Irs', uiValue, 0, 100);
    }

    setAutoIris(on) {
        return this.runCamCtlCommand(`$AIrsSw:=${on ? 'On' : 'Off'}`);
    }

    /**
     * Auto iris level (exposure compensation), -50..+50. Only affects the
     * picture while auto iris is on. "$AIrsLv" holds its value, unlike an
     * "$Irs" set under auto iris, which the auto loop overrides within ~2 s.
     */
    setIrisLevel(uiValue) {
        return this.runScaledCamCtlCommand('AIrsLv', uiValue, -50, 50);
    }

    /** Zoom speed, 1-99 (50 = stop), scaled into the camera's own signed speed range. */
    setZoomSpeed(speed) {
        return this.runScaledCamCtlCommand('ZmSpd', Math.max(1, Math.min(99, speed)), 1, 99);
    }

    /** Focus speed, same 1-99 (50 = stop) scheme as zoom. */
    setFocusSpeed(speed) {
        return this.runScaledCamCtlCommand('FcSpd', Math.max(1, Math.min(99, speed)), 1, 99);
    }

    setAutoFocus(on) {
        return this.runCamCtlCommand(`$AFcSw:=${on ? 'On' : 'Off'}`);
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

    /** Runs a single boolean/enum CamCtl command through a fresh authenticated session. */
    runCamCtlCommand(command) {
        return this.withSession((session) => session.camCtl(command));
    }

    /**
     * Queries the camera's own min/max for field ("$Irs:c" -> "$Irs:i0,20000"),
     * scales uiValue into it, then sends the absolute set -- all in one session.
     */
    runScaledCamCtlCommand(field, uiValue, uiMin, uiMax) {
        return this.withSession(async (session) => {
            const bounds = await session.camCtl(`$${field}:c`);
            if (!bounds.isOk()) {
                return bounds;
            }

            const match = new RegExp(`\\$${field}:i(-?\\d+),(-?\\d+)`).exec(bounds.body);
            if (!match) {
                return CameraResponse.unexpected(bounds.body, `Could not parse ${field} bounds from camera response`);
            }

            const native = scaleToRange(uiValue, uiMin, uiMax, Number(match[1]), Number(match[2]));
            return session.camCtl(`$${field}:=${native}`);
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

    /** Best-effort teardown; failures here are not surfaced to the caller. */
    async close() {
        await this.camCtl('$Connect:=Off');
        this.conn.close();
    }
}

module.exports = { CameraClient, scaleToRange, parseDeviceInfo };
