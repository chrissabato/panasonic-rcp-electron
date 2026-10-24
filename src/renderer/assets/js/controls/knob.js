// Protocol-agnostic rotary knob widget. Vertical drag changes value (hold
// Shift for fine control); arrow keys nudge by 1. A knob whose range goes
// below zero shows its sign ("+3"). Knows nothing about cameras -- just
// reports value changes.
export function createKnob({ min = 0, max = 100, value = 50, onChange } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';

    const dial = document.createElement('div');
    dial.className = 'knob-dial';
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-valuemin', String(min));
    dial.setAttribute('aria-valuemax', String(max));

    const valueLabel = document.createElement('span');
    valueLabel.className = 'knob-value';

    wrap.append(dial, valueLabel);

    let current = clamp(value);
    const SENSITIVITY = (max - min) / 160; // full range over 160 px of drag
    const FINE = 0.2; // with Shift held

    function clamp(v) {
        return Math.min(max, Math.max(min, Math.round(v)));
    }

    function render() {
        const pct = (current - min) / (max - min || 1);
        const angle = -135 + pct * 270;
        dial.style.setProperty('--angle', angle.toFixed(1));
        dial.setAttribute('aria-valuenow', String(current));
        valueLabel.textContent = min < 0 && current > 0 ? `+${current}` : String(current);
    }

    function setValue(v) {
        current = clamp(v);
        render();
    }

    // Drag is accumulated per move (not from the start point), so pressing or
    // releasing Shift mid-drag changes the rate without jumping the value.
    let dragging = false;
    let lastY = 0;
    let exact = 0;

    dial.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastY = e.clientY;
        exact = current;
        dial.setPointerCapture(e.pointerId);
    });

    dial.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        exact = Math.min(max, Math.max(min, exact + (lastY - e.clientY) * SENSITIVITY * (e.shiftKey ? FINE : 1)));
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
        onChange?.(current, { final: true });
    }
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);

    dial.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            setValue(current + 1);
            onChange?.(current, { final: true });
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            setValue(current - 1);
            onChange?.(current, { final: true });
        }
    });

    render();

    return {
        el: wrap,
        setValue,
        getValue: () => current,
    };
}
