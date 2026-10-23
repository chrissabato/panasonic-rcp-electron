// Builds native/ndi-helper as an x64 exe (NDI ships no Windows ARM64
// library, so the helper runs under x64 emulation) and copies the NDI x64
// runtime DLL and its licenses file next to it. Needs Visual Studio with the
// x64 C++ tools and the NDI 6 SDK, found through the NDI_SDK_DIR variable its
// installer sets.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'ndi-helper', 'ndi-helper.cpp');
const OUT_DIR = path.join(ROOT, 'native', 'ndi-helper', 'build');
const NDI_DLL = 'Processing.NDI.Lib.x64.dll';
// "This file should be included with all distribution of the binary files included with the NDI SDK."
const NDI_LICENSES = 'Processing.NDI.Lib.Licenses.txt';

function fail(message) {
    console.error(`build-ndi-helper: ${message}`);
    process.exit(1);
}

if (process.platform !== 'win32') fail('Windows only');

const sdk = process.env.NDI_SDK_DIR;
if (!sdk || !fs.existsSync(path.join(sdk, 'Include', 'Processing.NDI.Lib.h'))) {
    fail('NDI 6 SDK not found: install it, or set NDI_SDK_DIR to its folder');
}

const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const vsPath = fs.existsSync(vswhere) && execFileSync(vswhere, [
    '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
], { encoding: 'utf8' }).trim();
if (!vsPath) fail('Visual Studio with the x64 C++ build tools not found');

// vcvarsall's target is x64; the host half follows the machine (arm64 here, x64 on an x64 PC).
const hostTarget = process.arch === 'arm64' ? 'arm64_x64' : 'x64';
const vcvars = path.join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
fs.mkdirSync(OUT_DIR, { recursive: true });

const cl = [
    'cl', '/nologo', '/O2', '/EHsc', '/std:c++17', '/W3', '/MT',
    `/I"${path.join(sdk, 'Include')}"`,
    `"${SOURCE}"`,
    `/Fo"${OUT_DIR}\\\\"`,
    `/Fe"${path.join(OUT_DIR, 'ndi-helper.exe')}"`,
    '/link', `/LIBPATH:"${path.join(sdk, 'Lib', 'x64')}"`,
].join(' ');

execFileSync('cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" ${hostTarget} >nul && ${cl}"`], {
    stdio: 'inherit', windowsVerbatimArguments: true,
});

for (const file of [NDI_DLL, NDI_LICENSES]) {
    fs.copyFileSync(path.join(sdk, 'Bin', 'x64', file), path.join(OUT_DIR, file));
}
console.log(`built ${path.join(OUT_DIR, 'ndi-helper.exe')}`);
