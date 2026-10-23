// Protocol-agnostic rotary knob widget. Vertical drag changes value; arrow keys
// nudge by 1. Knows nothing about cameras -- just reports value changes.
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
    const SENSITIVITY = (max - min) / 160; // px of drag for full range

    function clamp(v) {
        return Math.min(max, Math.max(min, Math.round(v)));
    }

    function render() {
        const pct = (current - min) / (max - min || 1);
        const angle = -135 + pct * 270;
        dial.style.setProperty('--angle', angle.toFixed(1));
        dial.setAttribute('aria-valuenow', String(current));
        valueLabel.textContent = String(current);
    }

    function setValue(v) {
        current = clamp(v);
        render();
    }

    let dragging = false;
    let startY = 0;
    let startValue = 0;

    dial.addEventListener('pointerdown', (e) => {
        dragging = true;
        startY = e.clientY;
        startValue = current;
        dial.setPointerCapture(e.pointerId);
    });

    dial.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const deltaY = startY - e.clientY;
        current = clamp(startValue + deltaY * SENSITIVITY);
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
