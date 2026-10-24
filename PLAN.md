# AG-CX370 CCU Panel — Electron + NDI plan

An Electron desktop version of the CCU panel in `/claude/panasonic-rcp`, adding a live NDI preview for each of the 4 channels. The app runs on a machine already on the camera network and talks to the cameras directly, so no web server and no firewall changes are needed.

The existing PHP app is the reference implementation. Its camera protocol behavior was confirmed against a real AG-CX370 (see [Protocol notes](#protocol-notes-confirmed-on-hardware)). Port that behavior faithfully rather than redesigning it.

> **Note:** at the time this plan was written, the PHP repo had uncommitted work (the Exp Comp control, the R/B XY pad, and the Paint/Iris row split). Commit it there first so the port starts from that version.

---

## Goals

1. Same controls, scenes and settings as the PHP panel, with the same UI.
2. A live, low-latency NDI preview at the top of each channel strip.
3. Show the camera's real values, not just the last values the app sent (see [Read-back](#phase-3--read-back-from-the-camera)).
4. A single installable app for **Windows on ARM (arm64)**, such as Snapdragon X machines. Windows x64 and macOS aren't required, but avoid choices that rule them out.

## Non-goals

- Full-resolution program monitoring. Previews use NDI's low-bandwidth stream.
- Recording, switching or tally output to other systems.
- Multi-user access. Each install has its own local database.

---

## Architecture

```
┌─────────────────────────── Electron app ───────────────────────────┐
│                                                                     │
│  Renderer (existing vanilla JS UI)                                  │
│    channel strips, knobs, XY pad, rockers, scenes modal, settings   │
│    <canvas> per channel for NDI preview                             │
│        │  window.rcp.*  (contextBridge, no Node access)             │
│        ▼                                                            │
│  Preload  ── ipcRenderer.invoke / MessagePort ──┐                   │
│                                                 │                   │
│  Main process                                   │                   │
│    ipc handlers (ports of public/api/*.php)     │                   │
│    CameraClient (P2 over TCP, node:net)  ───────┼──► cameras :P2    │
│    StateStore (better-sqlite3)                  │                   │
│    poller (health + read-back)                  │                   │
│                                                 │                   │
│  NDI utilityProcess (one per app)               │                   │
│    ndi-helper.exe (x64, emulated): find + recv ─┼──► cameras NDI|HX │
│    frames ── MessagePort (transferable) ────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
```

Key decisions:

- **Security:** use `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. The renderer only sees a small `window.rcp` API exposed through `contextBridge`. Load pages from local files only, with a strict CSP.
- **IPC replaces HTTP.** Each `public/api/*.php` endpoint becomes one `ipcMain.handle` channel. Requests and responses keep the same shape (`{ok, data}` / `{ok:false, error, code}`), so `api.js` is the only frontend file that changes much.
- **NDI runs in an Electron `utilityProcess`**, not the main process. Native decode work and crashes stay isolated from camera control, and the main process stays responsive.
- **Frames go to the renderer over a `MessagePort`** as transferable `ArrayBuffer`s, which avoids copying through `ipcRenderer`. The renderer draws them with WebGL.
- **Native arm64, except NDI.** The main process, the utilityProcess and every `.node` addon (better-sqlite3) are win32-arm64. One process can't mix architectures: an x64 addon won't load into an arm64 Electron. NDI ships no Windows ARM64 library (see Phase 0.2), so NDI receiving runs in `ndi-helper.exe`, a small separate x64 program that Windows runs under its Prism emulation. The utilityProcess starts it and reads frames from its stdout.

---

## Proposed layout

```
panasonic-rcp-electron/
  package.json
  electron-builder.yml          # or forge config
  src/
    main/
      main.js                   # app lifecycle, BrowserWindow, CSP
      ipc.js                    # registers all handlers
      camera/
        CameraClient.js         # port of src/Camera/CameraClient.php
        controlRegistry.js      # port of ControlRegistry.php (+ iris_level)
        controlApplier.js       # port of ControlApplier.php
        cameraResponse.js       # port of CameraResponse/CameraState
      state/
        StateStore.js           # port of src/State/StateStore.php
      poller.js                 # health + read-back loop (moved out of the renderer)
    ndi/
      ndiProcess.js             # utilityProcess entry: discovery + receivers
      receiver.js               # one NDI receiver, lowest bandwidth
    preload/
      preload.js                # contextBridge: window.rcp
    renderer/
      index.html                # from public/index.php
      settings.html             # from public/settings.php
      assets/                   # copied from public/assets (css, js, controls/)
      assets/js/api.js          # rewritten: fetch -> window.rcp
      assets/js/ndiView.js      # new: WebGL canvas per channel
  test/
    p2-sim/                     # optional fake P2 server for tests (see Phase 2)
```

---

## Phases

### Phase 0: Spikes (do these first; they decide whether the rest is worth doing)

Run every spike on the target hardware: a Windows ARM64 machine, using a native arm64 Electron build.

1. **NDI and P2 together.** With the camera in NDI|HX mode, open NDI Studio Monitor (or any NDI viewer) on the camera. While it's streaming, run the PHP panel's controls and its health check. Confirm that both work at once and that P2 control doesn't stop the stream. *This blocks the whole plan.* **Answered 2026-10-23:** NDI streaming and P2 control work at the same time on the camera.
2. **NDI on Windows ARM64.** The official C++ NDI SDK supports ARM natively, and the Windows ARM64 `.lib` and `.dll` binaries are available directly from NDI. Get them, and confirm that the arm64 DLL loads in an arm64 test program and can find a camera.

   **Answered 2026-10-23: there is no Windows ARM64 NDI library.** The NDI 6 SDK (6.3.2) for Windows ships x64 and x86 builds only, and NDI's docs and release notes mention ARM in general but never Windows on ARM. Chosen approach (option A): an x64 helper, `native/ndi-helper/ndi-helper.cpp`, built with `npm run build:ndi-helper` and run under emulation. It does NDI find, receive (lowest bandwidth) and frame sync, and writes frames to stdout.
3. **The native NDI addon.** *Superseded by the x64 helper in 0.2; no Node addon is needed.* Measured on the dev machine with the AG-CX370: lowest bandwidth delivers 640×360 UYVY at the camera's 24 fps. The emulated helper uses 7% of one core for one receiver and 23% for four, decode included. Original checks: pick a Node binding for the NDI SDK and confirm all of the following:
   - It builds for arm64 against the pinned Electron (`@electron/rebuild --arch arm64`) with the MSVC ARM64 build tools.
   - It links against the arm64 NDI `.lib` and loads the arm64 DLL. Most community bindings bundle only x64 DLLs.
   - It can find sources and receive from a camera.
   - It decodes NDI|HX (H.264/HEVC). Check whether decoding uses the GPU hardware or falls back to the CPU on ARM64.
   - It supports the lowest-bandwidth receive setting.

   Community bindings exist on npm, but check how recently each one was maintained and whether it supports arm64. If none is acceptable, which is likely on ARM64, write a small N-API addon around the SDK's `find`, `recv` and `framesync` calls.
4. **better-sqlite3 on arm64.** *Answered on the dev machine (win32-arm64), 2026-10-23:* better-sqlite3 13 is an N-API module and its npm package includes `prebuilds/win32-arm64.node`, which loads in Electron 44.5.1 arm64 with no rebuild. Confirm it again on the reference device if that's a different machine. One catch: npm still runs `node-gyp rebuild` on install because the package ships a `binding.gyp`, so `npm install` fails without Python and the VS build tools, even though the build step itself does nothing. Original check: whether a win32-arm64 prebuild exists for the pinned Electron. If not, confirm it builds from source with the VS 2022 (17.4 or later) ARM64 toolchain. If neither works, fall back to Node's built-in `node:sqlite`, provided it's stable in the pinned Electron's Node version, since it needs no native rebuild.
5. **Throughput.** On the target ARM64 device, receive one feed at lowest bandwidth and send its frames to a canvas. Measure latency, CPU and GPU, then repeat with 4 feeds. Also check that WebGL works on the device's GPU driver (ANGLE on D3D11).

   *Drawing side measured 2026-10-23 on the dev machine (win32-arm64, 12 cores), with generated frames instead of NDI, so no decode cost is included:* WebGL2 works. Four previews draw a steady 30 fps each. At 640×360 UYVY the whole app uses 34% of one core (2.9% of the machine). At 1920×1080 it uses 106% of one core (8.8%), mostly copying pixels through the renderer and the NDI process. Still to measure with the SDK: NDI|HX decode cost and end-to-end latency.

Exit criteria: four previews render smoothly with P2 control active at the same time, on a Windows ARM64 machine running a native arm64 build (with the x64 NDI helper, per 0.2).

### Phase 1: Scaffold

- Set up Electron with electron-builder or Electron Forge, and pin the Electron version.
- Create the secure window (see Key decisions), preload and an empty `window.rcp`.
- Copy `public/assets/` into `renderer/assets/`, and turn `index.php` and `settings.php` into static HTML. Any values that PHP injected into the pages now come from `rcp.getConfig()` instead.
- Add native-module rebuilds for `better-sqlite3` and the NDI addon, targeting arm64.
- Configure electron-builder with a `win` target of `nsis` and `arch: [arm64]`.
- Set up the toolchain: VS 2022 with "MSVC ARM64 build tools" and the Windows SDK, plus Python for node-gyp. *Done 2026-10-23 on the dev machine: Visual Studio 2026 Community (ARM64 and x64 C++ tools, Windows SDK 10.0.26100) and Python 3.13 ARM64; VS 2026 works with node-gyp. The x64 tools also build the NDI helper.*
- Run CI on a native Windows ARM64 runner (for example GitHub's `windows-11-arm`), so native modules build and tests run on the real architecture. Cross-compiling from x64 is a fallback only.
- On startup, log `process.arch` and fail with a clear message if a native module doesn't load, since that usually means an architecture mismatch.

### Phase 2: Port the backend (1:1 with the PHP)

| PHP | JS (main) | Notes |
|---|---|---|
| `src/Camera/CameraClient.php` | `camera/CameraClient.js` | `stream_socket_client` → `net.connect` with a connect timeout; `md5()` → `crypto.createHash('md5')`; SimpleXML → a small XML parser (e.g. `fast-xml-parser`). Keep the "read until the buffer parses as XML" completion rule, because some acks are a self-closing `<P2Control />`. |
| `ControlRegistry.php` | `controlRegistry.js` | Include `iris_level` (−50..50, Exp Comp). |
| `ControlApplier.php` | `controlApplier.js` | |
| `CameraResponse.php`, `CameraState.php` | `cameraResponse.js` | Rename `NOT_NDI_HX_MODE`/`ndi_hx_mode`; they're left over from the old HTTP interface. Add an explicit `AUTH_FAILED` state. |
| `src/State/StateStore.php` | `state/StateStore.js` | `better-sqlite3`, same schema, stored in `app.getPath('userData')`. Keep the "seed missing control rows on every start" behavior. |
| `public/api/channels.php` | `rcp:getChannels` | |
| `public/api/channel_set.php` | `rcp:setControl` | |
| `public/api/channel_health.php` | moved into `poller.js` | Fix the device-info parsing. The PHP version still expects `key=value` text, but P2 returns XML (`ModelName`, `SerialNo.`). |
| `public/api/config.php`, `settings.php` | `rcp:getConfig`/`setConfig`, `rcp:getSettings`/`saveSettings` | Store passwords with Electron `safeStorage` rather than plain text in SQLite. |
| `public/api/scenes.php`, `scene_recall.php` | `rcp:listScenes`/`saveScene`/`deleteScene`/`recallScene` | |
| `src/Http/*`, `src/bootstrap.php`, `.htaccess`, `config/` | — | Not needed. |
| `src/Camera/ValueMapper.php` | — | Left over from the HTTP interface; check that nothing uses it, then drop it. |

Improvements to make while porting:

- **Persistent session per camera** (optional, measure first). The PHP app reconnects and logs in for every command. In a long-running app, one authenticated session per camera, with a reconnect when it drops, removes several round trips per command and makes knob drags smoother. Serialize commands per camera through a small queue. Keep a per-command fallback if the camera drops idle sessions; the camera's discovery reply reports `CmdTimeout` 5000.
- **Coalesce drag updates.** Keep only the latest pending value per control, so a fast drag never builds up a backlog of commands to the camera.
- **Tests.** Add unit tests for scaling, XML parsing and the `:!`/`:#` handling. Optionally write a small fake P2 server (`test/p2-sim/`) that replays the replies recorded below, so CI runs without hardware.

### Phase 3: Read-back from the camera

*Done 2026-10-23 and checked on the camera.* Sets that the camera acknowledges but doesn't hold fail with the code `not_applied`, and the error names the value the camera read back. Zoom and focus speed and the AWB trigger are motion commands, so they aren't read back. A read-back counts as applied when it maps to the same UI value, so a camera that rounds to its own step size still passes.

The PHP panel shows the values the app last sent, so changes made on the camera body never appear, and ignored writes look like successes.

- **After each set**, query the value back (`$X:?`). Report a failure if it didn't change; this is the R/B gain case below.
- **Every slow poll tick**, query the current values (`$Irs:?`, `$AIrsSw:?`, `$AIrsLv:?`, `$RGain:?`, `$BGain:?`, `$WBalSel:?`, `$AFcSw:?`, `$RTlySw:?`), convert them back to UI values with the bounds from `:c`, and update the stored state.
- Keep the renderer's existing "pending" guard so a poll never overwrites a control while the user is dragging it.

### Phase 4: NDI previews

*Working with the real camera, 2026-10-23.* The utilityProcess (`src/ndi/`) starts `ndi-helper.exe`, and each channel shows the NDI source whose address is its camera's IP. The camera IPs are also given to the helper for direct discovery, so a firewall blocking mDNS can't hide them. Frames go over a MessagePort to a WebGL2 UYVY/BGRA view in each strip, with status overlays. With the AG-CX370 on CH1, the whole app uses about 2% of the machine. `RCP_FAKE_NDI=1` (or a size such as `1920x1080`) still swaps in generated test frames. Still to do: the per-channel source dropdown in Settings, and the optional NDI tally.

- **Runtime:** ~~load the arm64 NDI runtime DLL bundled in the app's `resources/`~~. There is no arm64 runtime, so the build copies the x64 `Processing.NDI.Lib.x64.dll` next to `ndi-helper.exe`, and both ship in `resources/ndi-helper/`. Don't rely on a system-installed NDI Runtime.
- **Discovery:** use NDI find in the utilityProcess, and match each source to a channel. The default match is the source name containing the camera's IP or display name. Add a per-channel "NDI source" dropdown in Settings to override it.
- **Receivers:** one per channel, set to lowest bandwidth. Use the SDK's framesync so the renderer always pulls the latest frame and never builds a backlog. Cap the preview at about 30 fps.
- **Transport:** send each frame over a `MessagePort`, with width, height, stride and pixel format (UYVY or BGRA). Between processes the data is always copied when it's sent; a transfer list can't avoid that, and Electron's `MessagePortMain` only transfers ports anyway. The renderer acks each drawn frame, and a channel's next frame waits for that ack, so a slow renderer drops frames instead of queueing them.
- **Pacing:** pace frames by due time on a short timer, not with a `1000/fps` interval. Windows timers fire on a ~15.6 ms clock, so a 33 ms interval runs at ~47 ms, which is 21 fps (measured).
- **Rendering:** add `ndiView.js` with one canvas per strip, above the tally lamp. Use WebGL, converting UYVY→RGB in a fragment shader so the CPU doesn't do it. Fall back to `putImageData` for BGRA.
- **States:** show "No source", "Connecting" and "No signal" overlays, and reconnect automatically if a source disappears.
- **Tally:** ~~the panel's tally toggle could also send NDI tally metadata to the receiver.~~ *Superseded 2026-10-23:* tally now comes from **vMix** (TCP API, `SUBSCRIBE TALLY` on port 8099) and is display-only: red ON AIR for program, green PREVIEW for preview. Each channel is mapped to a vMix input in Settings, by input key. There is no manual tally, and the app never sets the camera's `$RTlySw` lamp.

### Phase 5: Packaging

- Build the win32-arm64 NSIS installer with electron-builder and sign it with Authenticode (for example Azure Trusted Signing or an EV certificate).
- Bundle the NDI runtime (the **x64** DLL, beside `ndi-helper.exe`; `electron-builder.yml` already includes both) as the SDK's license requires, and include the required NDI trademark and license notices in an About box.
- Auto-update is optional, and only worth it if more than one or two machines will run the app. If it's added, publish an arm64-specific update feed.
- Later, if needed: Windows x64 and macOS builds. macOS would also need notarization.

---

## Protocol notes (confirmed on hardware)

Tested against an AG-CX370, serial DV24782369EC48, on 2026-10-22 and 2026-10-23.

- **Transport:** P2 Device Control Protocol over TCP, with XML request and response bodies. Each camera's port is set in its own network menu; the test camera uses **49151**, not the 49152 default.
- **Login:**
  - Send `<P2Control><Login>user</Login></P2Control>`. The reply contains `Realm` and `Nonce`.
  - `auth = md5(md5("user:realm:pass") + ":" + nonce)`.
  - A **wrong password** comes back as `<Error>Wrong User</Error>`, not as a password error. Surface it as an authentication failure.
- **Session:** send `$Connect:=On` and `$MyName:s<name>`. The reply's `CamCtl[@SessionID]` is the session ID, and every later `CamCtl` must carry it. End with `$Connect:=Off`.
- **Discovery reply** (`<Query Type="env"/>`): includes `ModelName`, `SerialNo.`, `CmdTimeout` (5000) and `RTInfo/Port` (49153/udp, a real-time status feed; not used yet).
- **Query forms:**
  - `$X:c` returns the range (`$Irs:i0,20000`), or `$X:i!` if the command has no numeric range. On/off and enum commands such as `$AIrsSw` and `$WBalSel` answer `:i!` too.
  - `$X:?` returns the current value after `:s`. Confirmed for all 8 read-back fields: numbers (`$Irs:s229`, `$AIrsLv:s-2`), `On`/`Off` (`$AIrsSw:sOn`) and the WB mode letter (`$WBalSel:sB`).
  - A set is applied by the time it's acknowledged: `$AIrsLv:=-1` read back as −1 about 20 ms later, on the first read.
  - `$X:=v` sets it. A successful set is often acknowledged with a self-closing `<P2Control />`.
- **Rejections:**
  - A reply ending `:!` with `Msg="Not Supported"` means the command isn't supported.
  - A reply ending `:#` means the camera is busy and didn't apply the command.
- **Commands and ranges:**

  | Command | Range / values | Notes |
  |---|---|---|
  | `$Irs` | 0..20000 | Under auto iris, a set is accepted but the auto loop pulls it back within about 2 s. It is **not** exposure compensation. |
  | `$AIrsSw` | On/Off | Auto iris. |
  | `$AIrsLv` | −50..50 | **Exposure compensation** (auto iris level). Holds its value; confirmed on the camera's screen. |
  | `$AIrsLvEf` | −50..50 | Probably the "auto iris level effect" menu item. Not written to yet, and its meaning is unconfirmed. |
  | `$RGain` / `$BGain` | −10..10 on 2026-10-22; **−200..200** on 2026-10-23 | The range may depend on a camera mode, which could be a clue to the ignored writes. The app reads it with `:c` on every set, so either range works. ⚠️ **Writes were acknowledged but ignored** on 2026-10-22 (R stayed 0 and B stayed −2 while WB mode was B). **On 2026-10-23 a write applied** (`$RGain:=1` read back 1, then restored), so whatever gated it has changed; possibly the WB mode. |
  | `$WBalSel` | A / B / Preset | |
  | `$Awb:Act` | — | Always answers busy (`:#`) at first; poll `$Awb:?` until it settles. |
  | `$RTlySw`, `$AFcSw` | On/Off | Tally and auto focus. |
  | `$ZmSpd`, `$FcSpd` | queried with `:c` | Zoom and focus speed; the UI uses 1..99 with 50 as stop. |
  | `$MPed` | −200..200 | Master pedestal (black level); read 16. **Writes are acknowledged but ignored** (`:=17` read back 16), like R/B gain was. Not in the app. |
  | `$RPed`, `$GPed`, `$BPed` | −100..100 | R/G/B pedestal; read 0. Writes not tried. |
  | `$MGain` | no range (`:i!`) | Master gain; reads 0. **Writes are refused**: `:=` answers `:!` "Not Supported" for 1, 2, 3, 6, −3 and 24. Not in the app. |
  | `$AgcSw` | On/Off | Auto gain; read Off. |
  | `$DtlSw`, `$OisSw` | On/Off | Detail and optical image stabiliser; both read On. |
  | `$FcPos` | 9000..82500 | Focus position range; `:?` gives no value. |

  Probed 2026-10-23 (camera at 192.168.4.24), read-only except the pedestal, gain and R gain writes above, which were restored. **No answer** from any guessed name for shutter (`$Shtr`, `$ShtrSw`, `$ShtrSel`, …), ND (`$ND`, `$NdSw`, `$NdFlt`, …) or an F-number (`$FNo`, `$IrsF`, …), so the iris fader shows the raw 0–100 value. The camera has no read-only way to list a field's options: other query forms (`:l`, `:L`, `:r`, …) answer busy (`:#`).

- **Intermittent `not_applied`:** once on 2026-10-23, auto iris Off and an Exp Comp drag were acknowledged but read back different values. Neither reproduced later the same day. The suspected cause is another controller connected at the same time; the next occurrence's error will show the camera's value.
- **Unresolved:** what gates paint and pedestal writes. R gain writes were ignored on 2026-10-22 but applied on 2026-10-23; master pedestal writes are still ignored. To investigate, compare the camera's menu settings (WB mode, scene file, any remote/paint lock) between a state where writes apply and one where they don't.

---

## Open questions

1. ~~Can NDI|HX streaming and P2 control run at the same time (Phase 0.1)?~~ Yes, confirmed on the camera on 2026-10-23.
2. ~~Which NDI binding to use, or whether to write a custom addon (Phase 0.3)?~~ Neither: there's no Windows ARM64 NDI library, so an x64 helper runs under emulation (Phase 0.2).
3. Which ARM64 device is the reference test machine?
4. ~~Should the panel's tally also drive NDI tally?~~ No: tally comes from vMix and is display-only (Phase 4).
5. Should the PHP app be kept as a fallback, or retired once the Electron app ships?
