# AG-CX370 CCU Panel

A desktop camera control panel for up to four Panasonic AG-CX370 camcorders, with a live NDI preview of each camera. Built with Electron for Windows on ARM (arm64).

The app talks to the cameras directly over their P2 control port, so it needs a machine on the camera network, with no server in between.

## Features

- Four channel strips: iris, auto iris, exposure compensation, zoom, focus, auto focus, R/B paint, and AWB with a trigger.
- The panel reads values back from each camera, so it shows the camera's real settings and not only the last ones the app sent.
- Live low-bandwidth NDI preview at the top of each strip, found automatically for each camera's IP.
- Tally from vMix, shown as display only: red ON AIR for program and green PREVIEW for preview. Each channel is mapped to a vMix input in Settings.
- Scenes (saved control states), channel ganging and fine control.
- Camera passwords are stored with Electron `safeStorage`, not in plain text.

## Requirements

- Windows 11 on ARM (arm64), such as a Snapdragon X machine. The NDI helper is x64 and runs under Windows' emulation, because NDI ships no Windows ARM64 library.
- AG-CX370 cameras on the same network, with their admin username and password.
- To build:
  - Node.js 20+
  - Visual Studio with the x64 C++ build tools
  - The [NDI 6 SDK](https://ndi.video/for-developers/ndi-sdk/), whose installer sets `NDI_SDK_DIR`

## Building

```sh
npm install
npm run build:ndi-helper   # builds ndi-helper.exe and copies in the NDI runtime DLL and its licenses file
npm run dist               # one-click per-user installer in dist/
```

To run from source instead, use `npm start`. To try the panel without NDI, set `RCP_FAKE_NDI=1` (or a size such as `1920x1080`) and every channel shows generated test frames.

## Tests

```sh
npm test
```

The tests run against `test/p2-sim`, a fake AG-CX370 control port that replays reply shapes recorded on real hardware. No camera is needed.

## Project notes

[PLAN.md](PLAN.md) holds the design, the build phases and the camera protocol behavior confirmed on hardware.

## License

[MIT](LICENSE). The NDI SDK and runtime are not part of this repository and are covered by NDI's own license. The built app includes NDI's licenses file and notices.

NDI® is a registered trademark of Vizrt NDI AB. Panasonic and AG-CX370 are trademarks of their respective owners. This project is not affiliated with or endorsed by either company.
