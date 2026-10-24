// Protocol-agnostic 2D pad widget (R/B paint style). Pointer position maps
// absolutely onto x/y; with Shift held the puck moves relatively at a fifth
// of the speed, for fine trims. Arrow keys nudge by 1; double-click
// recenters. Values read as offsets from center ("R +3 · B -1"). Knows
// nothing about cameras -- just reports which axis values changed.
export function createXyPad({
    min = 0, max = 100, x = 50, y = 50, xLabel = 'X', yLabel = 'Y', onChange,
} = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'xy-pad';

    const area = document.createElement('div');
    area.className = 'xy-pad-area';
    area.tabIndex = 0;
    area.setAttribute('role', 'application');
    area.setAttribute('aria-label', `${yLabel}/${xLabel} pad`);

    const puck = document.createElement('div');
    puck.className = 'xy-pad-puck';
    area.append(puck);

    const readout = document.createElement('span');
    readout.className = 'xy-pad-value';

    wrap.append(area, readout);

    const center = Math.round((min + max) / 2);
    let cx = clamp(x);
    let cy = clamp(y);

    function clamp(v) {
        return Math.min(max, Math.max(min, Math.round(v)));
    }

    function render() {
        const span = max - min || 1;
        area.style.setProperty('--x', String((cx - min) / span));
        area.style.setProperty('--y', String((cy - min) / span));
        const offset = (v) => (v > center ? `+${v - center}` : v < center ? `−${center - v}` : '+0');
        readout.textContent = `${yLabel} ${offset(cy)} · ${xLabel} ${offset(cx)}`;
        area.title = 'Drag to paint; hold Shift for fine control; double-click to reset to center';
    }

    // Reports only the axes that actually changed, so a purely horizontal drag
    // never re-sends the vertical axis.
    function moveTo(nx, ny, final) {
        nx = clamp(nx);
        ny = clamp(ny);
        const changed = {};
        if (nx !== cx) changed.x = nx;
        if (ny !== cy) changed.y = ny;
        cx = nx;
        cy = ny;
        render();
        if (changed.x !== undefined || changed.y !== undefined || final) {
            onChange?.(changed, { final });
        }
    }

    function valuesFromPointer(e) {
        const rect = area.getBoundingClientRect();
        const px = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const py = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
        return [min + px * (max - min), min + py * (max - min)];
    }

    const FINE = 0.2;
    let dragging = false;
    let last = null; // last pointer position and exact values, for Shift's relative moves

    area.addEventListener('pointerdown', (e) => {
        dragging = true;
        area.setPointerCapture(e.pointerId);
        // With Shift, a press doesn't jump the puck to the pointer: fine trims start from where it is.
        if (!e.shiftKey) moveTo(...valuesFromPointer(e), false);
        last = { px: e.clientX, py: e.clientY, x: cx, y: cy };
    });

    area.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        if (e.shiftKey) {
            const rect = area.getBoundingClientRect();
            const span = max - min;
            last.x = Math.min(max, Math.max(min, last.x + ((e.clientX - last.px) / rect.width) * span * FINE));
            last.y = Math.min(max, Math.max(min, last.y - ((e.clientY - last.py) / rect.height) * span * FINE));
            moveTo(last.x, last.y, false);
        } else {
            moveTo(...valuesFromPointer(e), false);
            last.x = cx;
            last.y = cy;
        }
        last.px = e.clientX;
        last.py = e.clientY;
    });

    // On release, re-report both axes as final so the last throttled value
    // for each always reaches the camera.
    function endDrag() {
        if (!dragging) return;
        dragging = false;
        onChange?.({ x: cx, y: cy }, { final: true });
    }
    area.addEventListener('pointerup', endDrag);
    area.addEventListener('pointercancel', endDrag);
    area.addEventListener('lostpointercapture', endDrag);

    area.addEventListener('dblclick', () => moveTo(center, center, true));

    area.addEventListener('keydown', (e) => {
        const deltas = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
        const d = deltas[e.key];
        if (!d) return;
        e.preventDefault();
        moveTo(cx + d[0], cy + d[1], true);
    });

    render();

    return {
        el: wrap,
        setX: (v) => { cx = clamp(v); render(); },
        setY: (v) => { cy = clamp(v); render(); },
        getX: () => cx,
        getY: () => cy,
    };
}
