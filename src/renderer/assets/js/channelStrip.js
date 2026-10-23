import { createKnob } from './controls/knob.js';
import { createToggle } from './controls/toggle.js';
import { createRocker } from './controls/rocker.js';
import { createXyPad } from './controls/xyPad.js';
import { createNdiView } from './ndiView.js';
import * as api from './api.js';

const PENDING_GUARD_MS = 1500; // ignore poller values for a control we just set, until confirmed or this expires
const DRAG_THROTTLE_MS = 120;

/**
 * Owns one channel's DOM subtree. Every widget here sends through
 * rcp.setControl, which forwards it straight to the camera. A per-control
 * "pending" guard stops a stale poll from clobbering a value the user just
 * dragged before the set's reply (or next poll) confirms it.
 */
export function createChannelStrip(channelId, root, { onConfigOpen, onQuickRecall } = {}) {
    const widgets = {};
    const pendingUntil = {};
    const lastSentAt = {};
    const els = {};
    const preview = createNdiView();

    function init(schema, channelData) {
        root.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'strip-header';

        const title = document.createElement('div');
        title.className = 'strip-title';
        els.dot = document.createElement('span');
        els.dot.className = 'health-dot';
        els.name = document.createElement('span');
        els.name.textContent = channelData.config.display_name;
        title.append(els.dot, els.name);

        els.ip = document.createElement('div');
        els.ip.className = 'strip-ip';
        els.ip.title = 'Click to edit IP / name';
        els.ip.addEventListener('click', () => onConfigOpen?.(channelId, channelData.config));

        header.append(title, els.ip);

        els.healthNote = document.createElement('div');
        els.healthNote.className = 'health-note';

        els.tally = document.createElement('div');
        els.tally.className = 'tally-lamp';
        els.tally.textContent = 'TALLY';
        els.tally.addEventListener('click', () => {
            const next = !widgets.tally.getValue();
            widgets.tally.setValue(next);
            send('tally', next);
        });
        widgets.tally = {
            setValue: (v) => { els.tally.classList.toggle('on', !!v); widgets.tally._v = !!v; },
            getValue: () => !!widgets.tally._v,
        };

        const controlGroup = document.createElement('div');
        controlGroup.className = 'control-group camera-controls';

        controlGroup.append(groupLabel('Paint'));
        controlGroup.append(buildLine([
            buildStack([
                buildSelectCell('awb_mode', schema.awb_mode),
                buildButtonCell('trigger_awb', schema.trigger_awb),
            ]),
            buildPaintPadCell(schema.wb_r, schema.wb_b),
        ]));

        controlGroup.append(groupLabel('Iris'));
        controlGroup.append(buildLine([
            buildKnobCell('iris', schema.iris),
            buildKnobCell('iris_level', schema.iris_level),
            buildToggleCell('auto_iris', schema.auto_iris),
        ]));

        controlGroup.append(groupLabel('Lens'));
        controlGroup.append(buildLine([
            buildRockerCell('zoom', schema.zoom),
            buildRockerCell('focus', schema.focus),
            buildToggleCell('auto_focus', schema.auto_focus),
        ]));

        const recallRow = document.createElement('div');
        recallRow.className = 'strip-recall-row';
        const recallBtn = document.createElement('button');
        recallBtn.className = 'strip-recall-btn';
        recallBtn.type = 'button';
        recallBtn.textContent = 'Recall last scene';
        recallBtn.title = 'Recall the last-recalled scene onto this channel only';
        recallBtn.addEventListener('click', () => onQuickRecall?.(channelId));
        recallRow.append(recallBtn);

        root.append(header, els.healthNote, preview.el, els.tally, controlGroup, recallRow);

        update(channelData);
    }

    function groupLabel(text) {
        const el = document.createElement('div');
        el.className = 'group-label';
        el.textContent = text;
        return el;
    }

    function buildLine(cells) {
        const line = document.createElement('div');
        line.className = 'control-line';
        line.append(...cells);
        return line;
    }

    function buildStack(cells) {
        const stack = document.createElement('div');
        stack.className = 'control-stack';
        stack.append(...cells);
        return stack;
    }

    function cell(labelText, widgetEl) {
        const el = document.createElement('div');
        el.className = 'control-cell';
        const label = document.createElement('span');
        label.className = 'control-cell-label';
        label.textContent = labelText;
        el.append(label, widgetEl);
        return el;
    }

    function buildKnobCell(control, def) {
        const knob = createKnob({
            min: def.min, max: def.max, value: def.default,
            onChange: (v, { final }) => handleChange(control, v, final),
        });
        widgets[control] = knob;
        return cell(def.label, knob.el);
    }

    // One pad drives two independent controls: B on the x axis, R on the y
    // axis. Each axis keeps its own pending guard/throttle via handleChange.
    function buildPaintPadCell(rDef, bDef) {
        const pad = createXyPad({
            min: rDef.min, max: rDef.max, x: bDef.default, y: rDef.default,
            xLabel: 'B', yLabel: 'R',
            onChange: ({ x, y }, { final }) => {
                if (y !== undefined) handleChange('wb_r', y, final);
                if (x !== undefined) handleChange('wb_b', x, final);
            },
        });
        widgets.wb_r = { setValue: pad.setY, getValue: pad.getY };
        widgets.wb_b = { setValue: pad.setX, getValue: pad.getX };
        const padCell = cell('R / B Paint', pad.el);
        padCell.classList.add('xy-pad-cell');
        return padCell;
    }

    function buildToggleCell(control, def) {
        const toggle = createToggle({
            value: def.default,
            onChange: (v) => handleChange(control, v, true),
        });
        widgets[control] = toggle;
        return cell(def.label, toggle.el);
    }

    function buildRockerCell(control, def) {
        const rocker = createRocker({
            min: def.min, max: def.max, center: def.default,
            leftLabel: def.left_label, rightLabel: def.right_label,
            onChange: (v, { final }) => handleChange(control, v, final),
        });
        widgets[control] = rocker;
        return cell(def.label, rocker.el);
    }

    function buildSelectCell(control, def) {
        const select = document.createElement('select');
        select.className = 'control-select';
        for (const [optValue, optLabel] of Object.entries(def.options)) {
            const opt = document.createElement('option');
            opt.value = optValue;
            opt.textContent = optLabel;
            select.append(opt);
        }
        select.addEventListener('change', () => handleChange(control, Number(select.value), true));
        widgets[control] = {
            setValue: (v) => { select.value = String(v); },
            getValue: () => Number(select.value),
        };
        return cell(def.label, select);
    }

    function buildButtonCell(control, def) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'control-button';
        button.textContent = 'Trigger';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await send(control, true);
            } finally {
                button.disabled = false;
            }
        });
        widgets[control] = { setValue: () => {}, getValue: () => true };
        return cell(def.label, button);
    }

    function handleChange(control, value, final) {
        pendingUntil[control] = Date.now() + PENDING_GUARD_MS;
        const now = Date.now();
        if (!final && lastSentAt[control] && now - lastSentAt[control] < DRAG_THROTTLE_MS) {
            return;
        }
        lastSentAt[control] = now;
        send(control, value);
    }

    async function send(control, value) {
        try {
            await api.setControl(channelId, control, value);
            pendingUntil[control] = 0;
        } catch (err) {
            // The camera kept its own value, and the main process has already
            // stored it: drop the guard so the next fast poll snaps back to it.
            if (err.code === 'not_applied') pendingUntil[control] = 0;
            // Otherwise leave the optimistic UI value in place; the slow poll's
            // read-back reconciles it once the camera is reachable. Non-fatal by design.
            console.warn(`CH${channelId} ${control} -> ${value} failed: ${err.message}`);
        }
    }

    function update(channelData) {
        if (!channelData) return;
        els.name.textContent = channelData.config.display_name;
        els.ip.textContent = channelData.config.ip_address || '(no IP set)';

        for (const [control, value] of Object.entries(channelData.state)) {
            if (pendingUntil[control] && Date.now() < pendingUntil[control]) continue;
            widgets[control]?.setValue(value);
        }

        updateHealth(channelData.health);
    }

    // status is a CameraState from the main process: ok, unreachable,
    // auth_failed or unexpected (null until the first probe).
    function updateHealth(health) {
        if (!health) return;
        els.dot.classList.remove('ok', 'amber', 'offline');
        let note = '';
        let amber = false;
        if (health.status === 'ok') {
            els.dot.classList.add('ok');
        } else if (health.status === 'auth_failed') {
            amber = true;
            note = 'Login failed: check user/password';
        } else if (health.status === 'unexpected') {
            amber = true;
            note = 'Unexpected camera response';
        } else if (health.status === 'unreachable') {
            els.dot.classList.add('offline');
            note = health.last_error === 'No IP address set' ? 'No IP address set' : 'Camera unreachable';
        }
        if (amber) els.dot.classList.add('amber');
        els.dot.title = health.info ? [health.info.model, health.info.serial].filter(Boolean).join(' · ') : '';
        els.healthNote.textContent = note;
        els.healthNote.classList.toggle('amber', amber);
        root.classList.toggle('offline', health.status === 'unreachable');
    }

    return { init, update, updateHealth, preview };
}
