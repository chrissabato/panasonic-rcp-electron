/**
 * Outcome of one camera operation. Port of CameraResponse.php/CameraState.php.
 *
 * The PHP NOT_NDI_HX_MODE state is gone: it was left over from the old HTTP
 * interface and the P2 client never produced it. AUTH_FAILED is new, because
 * the camera reports a wrong password as a generic <Error>, which used to be
 * indistinguishable from any other unexpected reply.
 */
const CameraState = Object.freeze({
    OK: 'ok',
    UNREACHABLE: 'unreachable',
    AUTH_FAILED: 'auth_failed',
    UNEXPECTED: 'unexpected',
});

class CameraResponse {
    constructor(state, body = null, error = null) {
        this.state = state;
        this.body = body;
        this.error = error;
    }

    isOk() {
        return this.state === CameraState.OK;
    }

    static ok(body) {
        return new CameraResponse(CameraState.OK, body);
    }

    static unreachable(error) {
        return new CameraResponse(CameraState.UNREACHABLE, null, error);
    }

    static authFailed(body, error) {
        return new CameraResponse(CameraState.AUTH_FAILED, body, error);
    }

    static unexpected(body, error) {
        return new CameraResponse(CameraState.UNEXPECTED, body, error);
    }
}

module.exports = { CameraState, CameraResponse };
