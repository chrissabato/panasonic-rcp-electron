import * as api from './api.js';

const statusEl = document.getElementById('settings-status');
const tableEl = document.getElementById('channel-settings-table');

let channelRows = {};

function wrapField(labelText, inputEl) {
    const wrap = document.createElement('label');
    wrap.className = 'channel-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    wrap.append(span, inputEl);
    return wrap;
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

    row.append(
        label,
        wrapField('Name', nameInput),
        wrapField('IP Address', ipInput),
        wrapField('Port', portInput),
        wrapField('Admin User', usernameInput),
        wrapField('Admin Password', passwordInput)
    );
    tableEl.append(row);

    channelRows[channelId] = { nameInput, ipInput, portInput, usernameInput, passwordInput };
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

    statusEl.textContent = 'Saving…';
    statusEl.classList.remove('error');
    try {
        const data = await api.saveSettings(payload);
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

load();
