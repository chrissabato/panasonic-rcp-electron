// Protocol-agnostic vertical fader with a large value readout, for the
// control an operator rides constantly (iris). Dragging is relative, from
// anywhere on the track: a press never jumps the value, so a stray click
// can't swing it. Shift drags at a fifth of the speed; arrow keys nudge by
// 1 and Page Up/Down by 5. A range below zero shows its sign ("+3").
// Knows nothing about cameras -- just reports value changes.
export function createFader({ min = 0, max = 100, value = 50, onChange } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'fader';

    const readout = document.createElement('div');
    readout.className = 'fader-value';

    const track = document.createElement('div');
    track.className = 'fader-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-orientation', 'vertical');
    track.setAttribute('aria-valuemin', String(min));
    track.setAttribute('aria-valuemax', String(max));
    track.title = 'Drag up or down; hold Shift for fine control';

    const fill = document.createElement('div');
    fill.className = 'fader-fill';
    const thumb = document.createElement('div');
    thumb.className = 'fader-thumb';
    track.append(fill, thumb);
    wrap.append(readout, track);

    const FULL_TRAVEL_PX = 220; // drag distance for the whole range
    const FINE = 0.2;
    let current = clamp(value);

    function clamp(v) {
        return Math.min(max, Math.max(min, Math.round(v)));
    }

    function render() {
        const pct = (current - min) / (max - min || 1);
        track.style.setProperty('--pos', pct.toFixed(4));
        track.setAttribute('aria-valuenow', String(current));
        readout.textContent = min < 0 && current > 0 ? `+${current}` : String(current);
    }

    function setValue(v) {
        current = clamp(v);
        render();
    }

    let dragging = false;
    let lastY = 0;
    let exact = 0;

    track.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastY = e.clientY;
        exact = current;
        track.setPointerCapture(e.pointerId);
        track.classList.add('dragging');
    });

    track.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const perPx = (max - min) / FULL_TRAVEL_PX;
        exact = Math.min(max, Math.max(min, exact + (lastY - e.clientY) * perPx * (e.shiftKey ? FINE : 1)));
        lastY = e.clientY;
        const next = clamp(exact);
        if (next === current) return;
        current = next;
        render();
        onChange?.(current, { final: false });
    });

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        track.classList.remove('dragging');
        onChange?.(current, { final: true });
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('lostpointercapture', endDrag);

    track.addEventListener('keydown', (e) => {
        const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 };
        if (!(e.key in steps)) return;
        e.preventDefault();
        const next = clamp(current + steps[e.key]);
        if (next === current) return;
        setValue(next);
        onChange?.(current, { final: true });
    });

    render();

    return {
        el: wrap,
        setValue,
        getValue: () => current,
    };
}
