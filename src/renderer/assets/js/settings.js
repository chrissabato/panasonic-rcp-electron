import * as api from './api.js';

const statusEl = document.getElementById('settings-status');
const tableEl = document.getElementById('channel-settings-table');

let channelRows = {};
let vmix = { host: '', port: 8099, channels: {}, status: 'disabled', inputs: [] };
const vmixHostInput = document.getElementById('set-vmix-host');
const vmixPortInput = document.getElementById('set-vmix-port');
const vmixStatusEl = document.getElementById('vmix-status');

function wrapField(labelText, inputEl) {
    const wrap = document.createElement('label');
    wrap.className = 'channel-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    wrap.append(span, inputEl);
    return wrap;
}

/** Fills a channel's vMix input dropdown, keeping its selection (or the saved input while vMix is away). */
function fillVmixInputs(select, channelId) {
    const selected = select.dataset.touched ? select.value : (vmix.channels[channelId]?.key ?? '');
    select.innerHTML = '';
    select.append(new Option('(none)', ''));
    for (const input of vmix.inputs) {
        select.append(new Option(`${input.number}: ${input.title}`, input.key));
    }
    if (selected && !vmix.inputs.some((i) => i.key === selected)) {
        const saved = vmix.channels[channelId];
        const title = saved?.key === selected ? saved.title : '';
        select.append(new Option(`${title || 'Saved input'} (not in vMix now)`, selected));
    }
    select.value = selected;
}

function showVmixStatus() {
    const text = {
        disabled: 'Off (no address)',
        connecting: 'Connecting…',
        unreachable: 'Not reachable',
        connected: `Connected${vmix.version ? ` to vMix ${vmix.version}` : ''}, ${vmix.inputs.length} inputs`,
    }[vmix.status] ?? vmix.status;
    vmixStatusEl.textContent = text;
    vmixStatusEl.className = `vmix-status ${vmix.status}`;
}

async function refreshVmix({ fillAddress = false } = {}) {
    try {
        vmix = await api.getVmix();
    } catch (err) {
        vmixStatusEl.textContent = `Unavailable: ${err.message}`;
        return;
    }
    if (fillAddress) {
        vmixHostInput.value = vmix.host;
        vmixPortInput.value = vmix.port;
    }
    showVmixStatus();
    for (const [channelId, row] of Object.entries(channelRows)) fillVmixInputs(row.vmixSelect, channelId);
}

function buildChannelRow(channelId, cfg) {
    const row = document.createElement('div');
    row.className = 'channel-settings-row';

    const label = document.createElement('div');
    label.className = 'channel-settings-label';
    label.textContent = `CH${channelId}`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 24;
    nameInput.value = cfg.display_name;

    const ipInput = document.createElement('input');
    ipInput.type = 'text';
    ipInput.placeholder = '192.168.0.1x';
    ipInput.value = cfg.ip_address;

    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.min = 1;
    portInput.max = 65535;
    portInput.placeholder = '49152';
    portInput.value = cfg.port;

    const usernameInput = document.createElement('input');
    usernameInput.type = 'text';
    usernameInput.autocomplete = 'off';
    usernameInput.placeholder = '(none)';
    usernameInput.value = cfg.username;

    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.autocomplete = 'off';
    // The main process never sends stored passwords; leaving this blank keeps the current one.
    passwordInput.placeholder = cfg.has_password ? '(unchanged)' : '(none)';
    passwordInput.value = '';

    const vmixSelect = document.createElement('select');
    vmixSelect.addEventListener('change', () => { vmixSelect.dataset.touched = '1'; });
    fillVmixInputs(vmixSelect, channelId);

    row.append(
        label,
        wrapField('Name', nameInput),
        wrapField('IP Address', ipInput),
        wrapField('Port', portInput),
        wrapField('Admin User', usernameInput),
        wrapField('Admin Password', passwordInput),
        wrapField('vMix Input (tally)', vmixSelect)
    );
    tableEl.append(row);

    channelRows[channelId] = { nameInput, ipInput, portInput, usernameInput, passwordInput, vmixSelect };
}

async function load() {
    try {
        const data = await api.getSettings();

        document.getElementById('set-connect-ms').value = data.timeouts.connect_ms;
        document.getElementById('set-total-ms').value = data.timeouts.total_ms;
        document.getElementById('set-fast-ms').value = data.poll.fast_ms;
        document.getElementById('set-slow-ms').value = data.poll.slow_ms;

        tableEl.innerHTML = '';
        channelRows = {};
        for (const channelId of [1, 2, 3, 4]) {
            buildChannelRow(channelId, data.channels[channelId]);
        }
    } catch (err) {
        statusEl.textContent = `Failed to load settings: ${err.message}`;
        statusEl.classList.add('error');
    }
}

async function save() {
    const payload = {
        timeouts: {
            connect_ms: Number(document.getElementById('set-connect-ms').value),
            total_ms: Number(document.getElementById('set-total-ms').value),
        },
        poll: {
            fast_ms: Number(document.getElementById('set-fast-ms').value),
            slow_ms: Number(document.getElementById('set-slow-ms').value),
        },
        channels: {},
    };

    for (const channelId of Object.keys(channelRows)) {
        const row = channelRows[channelId];
        payload.channels[channelId] = {
            display_name: row.nameInput.value.trim(),
            ip_address: row.ipInput.value.trim(),
            port: Number(row.portInput.value) || 49152,
            username: row.usernameInput.value.trim(),
        };
        if (row.passwordInput.value !== '') {
            payload.channels[channelId].password = row.passwordInput.value;
        }
    }

    const vmixPayload = {
        host: vmixHostInput.value.trim(),
        port: Number(vmixPortInput.value) || 8099,
        channels: Object.fromEntries(Object.entries(channelRows).map(([id, row]) => [id, row.vmixSelect.value])),
    };

    statusEl.textContent = 'Saving…';
    statusEl.classList.remove('error');
    try {
        const data = await api.saveSettings(payload);
        vmix = await api.saveVmix(vmixPayload);
        showVmixStatus();
        statusEl.textContent = 'Saved.';
        tableEl.innerHTML = '';
        channelRows = {};
        for (const channelId of [1, 2, 3, 4]) {
            buildChannelRow(channelId, data.channels[channelId]);
        }
    } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}`;
        statusEl.classList.add('error');
    }
}

document.getElementById('settings-save-btn').addEventListener('click', save);

// vMix first, so the channel rows' dropdowns are filled when they're built.
refreshVmix({ fillAddress: true }).then(load);
setInterval(() => refreshVmix(), 2000);
