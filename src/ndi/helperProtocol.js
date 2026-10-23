/**
 * Parser for ndi-helper.exe's stdout (see native/ndi-helper/ndi-helper.cpp):
 * a stream of u32 type, u32 length, payload messages, little endian.
 *
 * Frames are ~460 KB and arrive in pipe-sized chunks, so a message's buffer
 * is allocated once its header is known and chunks are copied straight into
 * it, rather than re-concatenating everything received so far.
 */
const MSG_JSON = 1;
const MSG_FRAME = 2;
const FRAME_HEADER_BYTES = 20;

const fourccText = (n) => String.fromCharCode(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);

/** Calls onMessage({ type: 'json', value }) or ({ type: 'frame', channel, format, width, height, stride, data }). */
function createMessageReader(onMessage) {
    let header = Buffer.alloc(8);
    let headerFilled = 0;
    let body = null;
    let bodyFilled = 0;
    let bodyType = 0;

    function finish() {
        if (bodyType === MSG_JSON) {
            onMessage({ type: 'json', value: JSON.parse(body.toString('utf8')) });
        } else if (bodyType === MSG_FRAME && body.length >= FRAME_HEADER_BYTES) {
            onMessage({
                type: 'frame',
                channel: body.readUInt32LE(0),
                format: fourccText(body.readUInt32LE(4)),
                width: body.readUInt32LE(8),
                height: body.readUInt32LE(12),
                stride: body.readUInt32LE(16),
                data: body.subarray(FRAME_HEADER_BYTES),
            });
        }
        body = null;
        headerFilled = 0;
    }

    return function push(chunk) {
        let offset = 0;
        while (offset < chunk.length) {
            if (body === null) {
                const n = Math.min(8 - headerFilled, chunk.length - offset);
                chunk.copy(header, headerFilled, offset, offset + n);
                headerFilled += n;
                offset += n;
                if (headerFilled < 8) return;
                bodyType = header.readUInt32LE(0);
                body = Buffer.allocUnsafe(header.readUInt32LE(4));
                bodyFilled = 0;
            }
            const n = Math.min(body.length - bodyFilled, chunk.length - offset);
            chunk.copy(body, bodyFilled, offset, offset + n);
            bodyFilled += n;
            offset += n;
            if (bodyFilled === body.length) finish();
        }
    };
}

module.exports = { createMessageReader, MSG_JSON, MSG_FRAME };
