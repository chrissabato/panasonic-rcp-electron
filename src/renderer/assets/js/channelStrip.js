import { createFader } from './controls/fader.js';
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
 *
 * Ganging: every change the user makes here is reported through
 * onLocalChange, and app.js replays it on the other ganged strips with
 * mirror(), which runs the same path minus the report, so it never echoes.
 *
 * Locking: a locked strip sends nothing to its camera -- not from its own
 * controls, not from a ganged strip -- so a stray click can't move a camera
 * that's on air. Polls still update it, so it keeps showing the real values.
 */
export function createChannelStrip(channelId, root, { onConfigOpen, onQuickRecall, onLocalChange, onLinkToggle, onLockToggle } = {}) {
    const widgets = {};
    const pendingUntil = {};
    const lastSentAt = {};
    const els = {};
    const preview = createNdiView();
    let locked = false;
    let currentConfig = {};

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
        els.ip.addEventListener('click', () => onConfigOpen?.(channelId, currentConfig));

        els.link = document.createElement('button');
        els.link.type = 'button';
        els.link.className = 'strip-pill';
        els.link.textContent = 'GANG';
        els.link.title = 'Gang this strip: a change on any ganged strip applies to all ganged strips';
        els.link.setAttribute('aria-pressed', 'false');
        els.link.addEventListener('click', () => onLinkToggle?.(channelId));

        els.lock = document.createElement('button');
        els.lock.type = 'button';
        els.lock.className = 'strip-pill strip-lock';
        els.lock.textContent = 'LOCK';
        els.lock.title = 'Lock this strip so nothing can change its camera';
        els.lock.setAttribute('aria-pressed', 'false');
        els.lock.addEventListener('click', () => onLockToggle?.(channelId));

        const pills = document.createElement('div');
        pills.className = 'strip-pills';
        pills.append(els.link, els.lock);

        header.append(title, pills, els.ip);

        els.healthNote = document.createElement('div');
        els.healthNote.className = 'health-note';

        // Tally comes from vMix and is shown, never set (see setTally).
        els.tally = document.createElement('div');
        els.tally.className = 'tally-lamp';
        els.tally.setAttribute('role', 'status');
        setTally(channelData.tally ?? null);

        // Two columns: Paint and Lens on the left (set and leave), and iris on
        // the right as a tall fader, because it's what the operator rides.
        const controls = document.createElement('div');
        controls.className = 'strip-body camera-controls';

        const main = document.createElement('div');
        main.className = 'strip-col';
        const paintRow = document.createElement('div');
        paintRow.className = 'paint-awb';
        paintRow.append(buildSelect('awb_mode', schema.awb_mode), buildButton('trigger_awb', schema.trigger_awb));
        main.append(section('Paint', [paintRow, buildPaintPad(schema.wb_r, schema.wb_b)]));
        main.append(section('Lens', [
            buildRockerRow('zoom', schema.zoom),
            buildRockerRow('focus', schema.focus),
        ], buildInlineToggle('auto_focus', schema.auto_focus, 'AF')));

        // Only one of Iris and Exp Comp applies at a time: manual iris is
        // overridden by the camera's auto loop, and Exp Comp only steers auto
        // iris. updateIrisMode() shows the one that matches Auto Iris.
        els.irisCell = buildFaderCell('iris', schema.iris, 'Iris');
        els.expCompCell = buildFaderCell('iris_level', schema.iris_level, 'Exp Comp');
        const irisCol = document.createElement('div');
        irisCol.className = 'strip-col strip-col-iris';
        const autoIris = buildInlineToggle('auto_iris', schema.auto_iris, 'AUTO');
        autoIris.classList.add('fader-auto');
        irisCol.append(section('Iris', [els.irisCell, els.expCompCell, autoIris]));

        controls.append(main, irisCol);

        // Shown instead of the controls while the channel has no camera IP.
        els.emptyCard = document.createElement('div');
        els.emptyCard.className = 'strip-empty';
        const emptyText = document.createElement('p');
        emptyText.textContent = 'No camera';
        const setIpBtn = document.createElement('button');
        setIpBtn.type = 'button';
        setIpBtn.className = 'control-button';
        setIpBtn.textContent = 'Set camera IP';
        setIpBtn.addEventListener('click', () => onConfigOpen?.(channelId, currentConfig));
        els.emptyCard.append(emptyText, setIpBtn);

        const recallRow = document.createElement('div');
        recallRow.className = 'strip-recall-row';
        const recallBtn = document.createElement('button');
        recallBtn.className = 'strip-recall-btn';
        recallBtn.type = 'button';
        recallBtn.textContent = 'Recall last scene';
        recallBtn.title = 'Recall the last-recalled scene onto this channel only';
        recallBtn.addEventListener('click', () => onQuickRecall?.(channelId));
        recallRow.append(recallBtn);

        root.append(header, els.healthNote, preview.el, els.tally, controls, recallRow, els.emptyCard);

        update(channelData);
    }

    /** A titled block of controls; extra (e.g. a toggle) sits at the right of the title. */
    function section(title, children, extra) {
        const el = document.createElement('section');
        el.className = 'strip-section';
        const head = document.createElement('div');
        head.className = 'section-head';
        const label = document.createElement('span');
        label.className = 'group-label';
        label.textContent = title;
        head.append(label);
        if (extra) head.append(extra);
        el.append(head, ...children);
        return el;
    }

    function buildFaderCell(control, def, label) {
        const fader = createFader({
            min: def.min, max: def.max, value: def.default,
            onChange: (v, { final }) => handleChange(control, v, final),
        });
        widgets[control] = fader;
        const el = document.createElement('div');
        el.className = 'fader-cell';
        const caption = document.createElement('span');
        caption.className = 'fader-label';
        caption.textContent = label;
        el.append(fader.el, caption);
        return el;
    }

    /** A small labelled switch, for section titles (AF, AUTO). */
    function buildInlineToggle(control, def, shortLabel) {
        const toggle = createToggle({
            value: def.default,
            onChange: (v) => handleChange(control, v, true),
        });
        widgets[control] = toggle;
        const el = document.createElement('label');
        el.className = 'inline-toggle';
        el.title = def.label;
        const text = document.createElement('span');
        text.textContent = shortLabel;
        el.append(text, toggle.el);
        return el;
    }

    // One pad drives two independent controls: B on the x axis, R on the y
    // axis. Each axis keeps its own pending guard/throttle via handleChange.
    function buildPaintPad(rDef, bDef) {
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
        pad.el.classList.add('paint-pad');
        return pad.el;
    }

    /** "Zoom  W ‹‹ ● ›› T" on one line. */
    function buildRockerRow(control, def) {
        const rocker = createRocker({
            min: def.min, max: def.max, center: def.default,
            leftLabel: def.left_label, rightLabel: def.right_label,
            onChange: (v, { final }) => handleChange(control, v, final),
        });
        widgets[control] = rocker;
        const el = document.createElement('div');
        el.className = 'rocker-row';
        const label = document.createElement('span');
        label.className = 'rocker-row-label';
        label.textContent = def.label;
        el.append(label, rocker.el);
        return el;
    }

    function buildSelect(control, def) {
        const select = document.createElement('select');
        select.className = 'control-select';
        for (const [optValue, optLabel] of Object.entries(def.options)) {
            const opt = document.createElement('option');
            opt.value = optValue;
            opt.textContent = optLabel;
            select.append(opt);
        }
        select.addEventListener('change', () => handleChange(control, Number(select.value), true));
        select.title = def.label;
        widgets[control] = {
            setValue: (v) => { select.value = String(v); },
            getValue: () => Number(select.value),
        };
        return select;
    }

    function buildButton(control, def) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'control-button';
        button.textContent = def.label;
        button.addEventListener('click', async () => {
            if (locked) return;
            button.disabled = true;
            onLocalChange?.(channelId, control, true, true);
            try {
                await send(control, true);
            } finally {
                button.disabled = false;
            }
        });
        widgets[control] = { setValue: () => {}, getValue: () => true };
        return button;
    }

    function updateIrisMode() {
        const auto = widgets.auto_iris.getValue();
        els.irisCell.hidden = auto;
        els.expCompCell.hidden = !auto;
    }

    /** A change made on this strip: apply it, and report it so linked strips follow. */
    function handleChange(control, value, final) {
        // Locked: drop it. The widget may already show the new value (a key
        // press, say); the next fast poll puts back the camera's value.
        if (locked) return;
        applyChange(control, value, final);
        onLocalChange?.(channelId, control, value, final);
    }

    /** A change made on a linked strip: show it here and send it to this camera too. */
    function mirror(control, value, final) {
        if (locked) return;
        if (control === 'trigger_awb') {
            send(control, true);
            return;
        }
        widgets[control]?.setValue(value);
        applyChange(control, value, final);
    }

    function setLinked(on) {
        root.classList.toggle('linked', on);
        els.link.classList.toggle('on', on);
        els.link.setAttribute('aria-pressed', String(on));
    }

    /**
     * vMix tally for this camera's input: 'program' (red ON AIR, and the strip
     * glows red so it reads from across the room), 'preview' (green), 'off',
     * or null when there's no input assigned or vMix isn't connected.
     */
    function setTally(state) {
        els.tally.classList.toggle('on', state === 'program');
        els.tally.classList.toggle('preview', state === 'preview');
        els.tally.classList.toggle('unknown', state === null);
        els.tally.textContent = state === 'program' ? 'ON AIR' : state === 'preview' ? 'PREVIEW' : 'TALLY';
        els.tally.title = state === null ? 'No vMix tally: assign this channel a vMix input in Settings' : 'Tally from vMix';
        root.classList.toggle('on-air', state === 'program');
        root.classList.toggle('on-preview', state === 'preview');
    }

    function setLocked(on) {
        locked = on;
        root.classList.toggle('locked', on);
        els.lock.classList.toggle('on', on);
        els.lock.textContent = on ? 'LOCKED' : 'LOCK';
        els.lock.title = on ? 'Unlock this strip' : 'Lock this strip so nothing can change its camera';
        els.lock.setAttribute('aria-pressed', String(on));
    }

    function applyChange(control, value, final) {
        if (control === 'auto_iris') updateIrisMode();
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
        currentConfig = channelData.config;
        els.name.textContent = channelData.config.display_name;
        els.ip.textContent = channelData.config.ip_address || '(no IP set)';
        root.classList.toggle('unconfigured', !channelData.config.ip_address);

        for (const [control, value] of Object.entries(channelData.state)) {
            if (pendingUntil[control] && Date.now() < pendingUntil[control]) continue;
            widgets[control]?.setValue(value);
        }
        updateIrisMode();

        updateHealth(channelData.health);
        if ('tally' in channelData) setTally(channelData.tally);
    }

    // status is a CameraState from the main process: ok, unreachable,
    // auth_failed or unexpected (null until the first probe). The note always
    // says the connection state in words, beside the dot's colour.
    function updateHealth(health) {
        if (!health) return;
        els.dot.classList.remove('ok', 'amber', 'offline');
        els.healthNote.classList.remove('ok');
        let note = 'Connecting…';
        let amber = false;
        if (health.status === 'ok') {
            els.dot.classList.add('ok');
            els.healthNote.classList.add('ok');
            note = 'Connected';
        } else if (health.status === 'auth_failed') {
            amber = true;
            note = 'Login failed: check user/password';
        } else if (health.status === 'unexpected') {
            amber = true;
            note = 'Unexpected camera response';
        } else if (health.status === 'unreachable') {
            els.dot.classList.add('offline');
            note = health.last_error === 'No IP address set' ? 'No IP address set' : 'Offline';
        }
        if (amber) els.dot.classList.add('amber');
        els.dot.title = health.info ? [health.info.model, health.info.serial].filter(Boolean).join(' · ') : '';
        els.healthNote.textContent = note;
        els.healthNote.classList.toggle('amber', amber);
        root.classList.toggle('offline', health.status === 'unreachable');
    }

    return {
        init, update, updateHealth, preview, mirror, setLinked, setLocked, setTally,
        isConfigured: () => Boolean(currentConfig.ip_address),
    };
}
