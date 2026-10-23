// Runs the test suite under Electron's own Node (ELECTRON_RUN_AS_NODE), so
// native modules load with the same build the app uses, on every OS, without
// shell-specific env syntax.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const files = process.argv.length > 2 ? process.argv.slice(2) : ['test/**/*.test.js'];

const result = spawnSync(electron, ['--test', ...files], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

process.exit(result.status ?? 1);
