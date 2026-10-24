/**
 * Single source of truth for every control this app exposes. Port of
 * ControlRegistry.php -- deliberately limited to commands the AG-CX370
 * actually supports over P2.
 *
 * 'momentary' controls (zoom/focus speed, AWB trigger) are commands, not
 * state: they're never persisted to channel_state and never appear in saved
 * scenes -- recalling a "look" should never move the lens.
 *
 * Tally isn't a control: it comes from vMix and is shown, never set (see
 * main/vmix). Scenes saved when it was a control still hold a tally value;
 * recall skips it because it's no longer in this list.
 */
const DEFS = Object.freeze({
    awb_mode: {
        type: 'select', default: 1,
        options: { 1: 'AWB A', 2: 'AWB B', 10: 'PRESET' },
        label: 'AWB', group: 'paint',
    },
    trigger_awb: {
        type: 'button', default: false,
        label: 'Trigger AWB', group: 'paint', momentary: true,
    },
    wb_r: {
        type: 'knob', min: 0, max: 100, default: 50,
        label: 'R Paint', group: 'paint',
    },
    wb_b: {
        type: 'knob', min: 0, max: 100, default: 50,
        label: 'B Paint', group: 'paint',
    },
    iris: {
        type: 'knob', min: 0, max: 100, default: 50,
        label: 'Iris', group: 'iris',
    },
    auto_iris: {
        type: 'toggle', default: false,
        label: 'Auto Iris', group: 'iris',
    },
    iris_level: {
        type: 'knob', min: -50, max: 50, default: 0,
        label: 'Exp Comp', group: 'iris',
    },
    zoom: {
        type: 'rocker', min: 1, max: 99, default: 50,
        label: 'Zoom', group: 'lens', momentary: true,
        left_label: 'W', right_label: 'T',
    },
    focus: {
        type: 'rocker', min: 1, max: 99, default: 50,
        label: 'Focus', group: 'lens', momentary: true,
        left_label: 'N', right_label: 'F',
    },
    auto_focus: {
        type: 'toggle', default: true,
        label: 'Auto Focus', group: 'lens',
    },
});

function all() {
    return DEFS;
}

function get(control) {
    return Object.hasOwn(DEFS, control) ? DEFS[control] : null;
}

function isValid(control) {
    return get(control) !== null;
}

function isMomentary(control) {
    return !!get(control)?.momentary;
}

function defaultValue(control) {
    return get(control)?.default ?? null;
}

// PHP's (int) cast: truncate toward zero, and anything non-numeric becomes 0.
function toInt(raw) {
    const n = Math.trunc(Number(raw));
    return Number.isFinite(n) ? n : 0;
}

/** Coerces/clamps a raw request value into the shape the control expects; throws on invalid select options. */
function coerceValue(control, raw) {
    const def = get(control);
    if (def === null) {
        throw new RangeError(`Unknown control '${control}'`);
    }

    switch (def.type) {
        case 'toggle':
            return Boolean(raw);
        case 'select': {
            const value = toInt(raw);
            if (!Object.hasOwn(def.options, String(value))) {
                throw new RangeError(`Invalid option for '${control}': ${raw}`);
            }
            return value;
        }
        case 'knob':
        case 'rocker':
            return Math.max(def.min, Math.min(def.max, toInt(raw)));
        case 'button':
            return true;
        default:
            return raw;
    }
}

module.exports = { all, get, isValid, isMomentary, defaultValue, coerceValue, toInt };
