/**
 * Stand-in for an NDI receiver until the SDK addon exists: generates UYVY
 * frames shaped like the real thing (75% colour bars, a sweeping white bar
 * so motion is visible, and one block per channel number in the top-left
 * corner so feeds can't be confused).
 */
const BARS = [ // 75% colour bars, RGB 0..1
    [0.75, 0.75, 0.75], [0.75, 0.75, 0], [0, 0.75, 0.75], [0, 0.75, 0],
    [0.75, 0, 0.75], [0.75, 0, 0], [0, 0, 0.75], [0, 0, 0],
];
const SWEEP_PERIOD_MS = 4000;

/** BT.709 limited-range Y'CbCr for an RGB colour, as 0..255 bytes. */
function rgbToYuv709([r, g, b]) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return {
        y: Math.round(16 + 219 * y),
        u: Math.round(128 + 224 * ((b - y) / 1.8556)),
        v: Math.round(128 + 224 * ((r - y) / 1.5748)),
    };
}

/** Fills pixels [x0, x1) of row y with one colour. x0 and x1 must be even: UYVY packs pixel pairs. */
function fillSpan(buf, stride, y, x0, x1, { y: luma, u, v }) {
    for (let x = x0; x < x1; x += 2) {
        const i = y * stride + x * 2;
        buf[i] = u;
        buf[i + 1] = luma;
        buf[i + 2] = v;
        buf[i + 3] = luma;
    }
}

const even = (n) => n - (n % 2);

function createFakeSource(channelId, { width = 640, height = 360 } = {}) {
    const stride = width * 2;
    const base = Buffer.alloc(stride * height);
    const frame = Buffer.alloc(stride * height);

    const bars = BARS.map(rgbToYuv709);
    for (let y = 0; y < height; y++) {
        bars.forEach((colour, i) => {
            fillSpan(base, stride, y, even(Math.round((i * width) / bars.length)), even(Math.round(((i + 1) * width) / bars.length)), colour);
        });
    }

    const white = rgbToYuv709([1, 1, 1]);
    const block = even(Math.max(8, Math.round(height / 18)));
    for (let n = 0; n < channelId; n++) {
        const x0 = block + n * block * 2;
        for (let y = block; y < block * 2; y++) fillSpan(base, stride, y, x0, x0 + block, white);
    }

    const sweepWidth = even(Math.max(4, Math.round(width / 80)));
    return {
        width,
        height,
        stride,
        format: 'UYVY',
        /** The frame for time t (ms). Reuses one buffer, so copy it before the next call if it must persist. */
        frameAt(t) {
            base.copy(frame);
            const x0 = even(Math.round(((t % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * (width - sweepWidth)));
            for (let y = 0; y < height; y++) fillSpan(frame, stride, y, x0, x0 + sweepWidth, white);
            return frame;
        },
    };
}

module.exports = { createFakeSource, rgbToYuv709 };
