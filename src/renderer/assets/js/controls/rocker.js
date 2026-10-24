// Momentary rocker widget for zoom/focus speed. Center = stop. Dragging away
// from center reports a proportional speed while held; releasing (or losing
// pointer capture for any reason) always snaps back to center and reports
// the stop value -- a lens motor should never be left running.
export function createRocker({ min = 1, max = 99, center = 50, leftLabel = '', rightLabel = '', onChange } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'rocker';

    if (leftLabel) {
        const l = document.createElement('span');
        l.className = 'rocker-label';
        l.textContent = leftLabel;
        wrap.append(l);
    }

    const track = document.createElement('div');
    track.className = 'rocker-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-valuemin', String(min));
    track.setAttribute('aria-valuemax', String(max));
    track.setAttribute('aria-valuenow', String(center));

    // Chevrons at each end light up with the push, so it reads as a speed
    // control that springs back, not a position slider.
    const backArrow = document.createElement('span');
    backArrow.className = 'rocker-arrow back';
    backArrow.textContent = '‹‹';
    const fwdArrow = document.createElement('span');
    fwdArrow.className = 'rocker-arrow fwd';
    fwdArrow.textContent = '››';
    const handle = document.createElement('div');
    handle.className = 'rocker-handle';
    track.append(backArrow, fwdArrow, handle);
    wrap.append(track);

    if (rightLabel) {
        const r = document.createElement('span');
        r.className = 'rocker-label';
        r.textContent = rightLabel;
        wrap.append(r);
    }

    const HALF_RANGE = Math.max(center - min, max - center);
    const DRAG_PX_FOR_FULL_SPEED = 60;

    function render(offsetPct) {
        track.style.setProperty('--offset', String(offsetPct));
        backArrow.style.setProperty('--push', String(Math.max(0, -offsetPct)));
        fwdArrow.style.setProperty('--push', String(Math.max(0, offsetPct)));
    }

    function speedFromOffsetPct(pct) {
        if (pct === 0) return center;
        const magnitude = Math.round(Math.abs(pct) * HALF_RANGE);
        return pct > 0 ? Math.min(max, center + magnitude) : Math.max(min, center - magnitude);
    }

    let dragging = false;
    let startX = 0;

    function stop(final) {
        render(0);
        track.setAttribute('aria-valuenow', String(center));
        onChange?.(center, { final });
    }

    track.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        track.setPointerCapture(e.pointerId);
    });

    track.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const pct = Math.max(-1, Math.min(1, (e.clientX - startX) / DRAG_PX_FOR_FULL_SPEED));
        render(pct);
        const speed = speedFromOffsetPct(pct);
        track.setAttribute('aria-valuenow', String(speed));
        onChange?.(speed, { final: false });
    });

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        stop(true);
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('lostpointercapture', endDrag);

    track.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
            onChange?.(Math.max(min, center - Math.round(HALF_RANGE * 0.4)), { final: true });
            window.setTimeout(() => stop(true), 200);
        } else if (e.key === 'ArrowRight') {
            onChange?.(Math.min(max, center + Math.round(HALF_RANGE * 0.4)), { final: true });
            window.setTimeout(() => stop(true), 200);
        }
    });

    render(0);

    return {
        el: wrap,
        // Momentary control: nothing to sync from the server, always rests at center.
        setValue: () => render(0),
        getValue: () => center,
    };
}
