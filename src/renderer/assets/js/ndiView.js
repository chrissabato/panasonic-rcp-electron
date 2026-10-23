// NDI preview: one WebGL2 canvas per channel strip, fed over a MessagePort
// straight from the NDI utilityProcess. UYVY is converted to RGB in the
// fragment shader (BT.709, limited range), so the CPU never touches pixels.

const STATUS_TEXT = {
    stopped: 'Preview off',
    no_source: 'No source',
    connecting: 'Connecting…',
    no_signal: 'No signal',
};
const NO_SIGNAL_AFTER_MS = 2000; // connected but no frame for this long
const STATS_INTERVAL_MS = 5000;

const VERTEX_SHADER = `#version 300 es
void main() {
    // One triangle that covers the viewport.
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform int uyvy;   // 1: UYVY, 4:2:2 packed as one RGBA texel per pixel pair; 0: BGRA
uniform int height;
out vec4 colour;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    p.y = height - 1 - p.y;
    if (uyvy == 1) {
        vec4 t = texelFetch(frame, ivec2(p.x >> 1, p.y), 0); // U Y0 V Y1
        float y = ((p.x & 1) == 0 ? t.g : t.a) * 255.0;
        float luma = (y - 16.0) / 219.0;
        float cb = (t.r * 255.0 - 128.0) / 224.0;
        float cr = (t.b * 255.0 - 128.0) / 224.0;
        colour = vec4(clamp(vec3(
            luma + 1.5748 * cr,
            luma - 0.1873 * cb - 0.4681 * cr,
            luma + 1.8556 * cb), 0.0, 1.0), 1.0);
    } else {
        colour = vec4(texelFetch(frame, p, 0).bgr, 1.0);
    }
}`;

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
}

function createRenderer(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) return null;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    const uniforms = {
        uyvy: gl.getUniformLocation(program, 'uyvy'),
        height: gl.getUniformLocation(program, 'height'),
    };

    gl.bindVertexArray(gl.createVertexArray());
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let texSize = '';
    return {
        draw({ width, height, stride, format, data }) {
            // Both formats are 4 bytes per texel: a UYVY texel is a pixel pair.
            const texWidth = stride / 4;
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            gl.viewport(0, 0, width, height);
            const size = `${texWidth}x${height}`;
            if (size !== texSize) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, texWidth, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
                texSize = size;
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texWidth, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            }
            gl.uniform1i(uniforms.uyvy, format === 'UYVY' ? 1 : 0);
            gl.uniform1i(uniforms.height, height);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
    };
}

/** One channel's preview: a canvas, a status overlay, and a start/stop button in the corner. */
export function createNdiView() {
    const el = document.createElement('div');
    el.className = 'ndi-preview';
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const overlay = document.createElement('div');
    overlay.className = 'ndi-overlay';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ndi-toggle';
    let onToggle = null;
    toggle.addEventListener('click', () => onToggle?.());
    el.append(canvas, overlay, toggle);

    let renderer = null;
    let unavailable = null;
    try {
        renderer = createRenderer(canvas);
        if (!renderer) unavailable = 'Preview unavailable (no WebGL2)';
    } catch (err) {
        unavailable = 'Preview unavailable';
        console.warn(`NDI preview: WebGL setup failed: ${err.message}`);
    }
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        unavailable = 'Preview unavailable (GPU reset)';
        showStatus();
    });
    canvas.addEventListener('webglcontextrestored', () => {
        renderer = createRenderer(canvas);
        unavailable = renderer ? null : 'Preview unavailable';
        showStatus();
    });

    let status = 'stopped';
    let lastFrameAt = 0;

    function showStatus() {
        let text = unavailable ?? STATUS_TEXT[status] ?? '';
        if (!unavailable && status === 'connected' && performance.now() - lastFrameAt > NO_SIGNAL_AFTER_MS) {
            text = STATUS_TEXT.no_signal;
        }
        overlay.textContent = text;
        overlay.hidden = text === '';
        el.classList.toggle('live', text === '');
    }
    showStatus();

    return {
        el,
        setStatus(next) {
            status = next;
            if (next === 'connected') lastFrameAt = performance.now();
            showStatus();
        },
        draw(frame) {
            renderer?.draw(frame);
            lastFrameAt = performance.now();
            showStatus();
        },
        /** Re-evaluates "no signal" when frames stop arriving. */
        refresh: showStatus,
        /** Shows whether this preview is on; the corner button offers the opposite. */
        setRunning(on) {
            toggle.textContent = on ? '■ Stop' : '▶ Start';
            toggle.title = on ? 'Stop this preview' : 'Start this preview';
            toggle.classList.toggle('on', on);
        },
        /** fn runs when the corner button is clicked. */
        onToggle(fn) {
            onToggle = fn;
        },
    };
}

/**
 * Connects the views ({ channelId: view }) to the NDI process. Frames are
 * drawn on the next animation frame, and only the newest one per channel;
 * each draw is acked so the NDI process sends that channel's next frame.
 * Previews start stopped. Each view's corner button starts or stops its own
 * channel; the returned controller's setAll(on) does every channel, and
 * onChange(fn) reports changes so the header button can update.
 */
export function startNdiPreviews(views) {
    let port = null;
    const running = new Set();
    let changed = null;

    const sendRunning = () => port?.postMessage({ type: 'previews', channels: [...running] });

    function setChannel(channel, on) {
        if (on) running.add(channel);
        else {
            running.delete(channel);
            pending.delete(channel);
        }
        views[channel].setRunning(on);
    }

    for (const [id, view] of Object.entries(views)) {
        const channel = Number(id);
        view.setRunning(false);
        view.onToggle(() => {
            setChannel(channel, !running.has(channel));
            sendRunning();
            changed?.();
        });
    }
    const pending = new Map();
    const drawn = new Map();
    let scheduled = false;

    function drawPending() {
        scheduled = false;
        for (const [channel, frame] of pending) {
            views[channel]?.draw(frame);
            drawn.set(channel, (drawn.get(channel) ?? 0) + 1);
            port?.postMessage({ type: 'ack', channel });
        }
        pending.clear();
    }

    function onMessage({ data }) {
        if (data?.type === 'status') {
            views[data.channel]?.setStatus(data.status);
        } else if (data?.type === 'frame') {
            pending.set(data.channel, data);
            if (!scheduled) {
                scheduled = true;
                requestAnimationFrame(drawPending);
            }
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== 'rcp:ndi-port') return;
        port?.close();
        port = event.ports[0];
        pending.clear();
        port.onmessage = onMessage;
        // A new port means a new or restarted NDI process: tell it which previews are on.
        sendRunning();
    });
    window.rcp.ndiConnect();

    setInterval(() => {
        for (const view of Object.values(views)) view.refresh();
    }, 500);

    // Report the drawn frame rate to the NDI process, which logs it when running fake sources.
    let statsSince = performance.now();
    setInterval(() => {
        const seconds = (performance.now() - statsSince) / 1000;
        const fps = Object.fromEntries(Object.keys(views).map((id) => [id, (drawn.get(Number(id)) ?? 0) / seconds]));
        drawn.clear();
        statsSince = performance.now();
        port?.postMessage({ type: 'stats', fps });
    }, STATS_INTERVAL_MS);

    return {
        setAll(on) {
            for (const id of Object.keys(views)) setChannel(Number(id), on);
            sendRunning();
            changed?.();
        },
        allRunning: () => running.size === Object.keys(views).length,
        onChange(fn) {
            changed = fn;
        },
    };
}
