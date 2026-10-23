// Renders build/icon.svg to build/icon.png (1024 px) and build/icon.ico (every
// size Windows asks for, PNG-compressed), which electron-builder picks up from
// build/ by default. Runs under Electron so Chromium does the rasterizing:
//   npm run build:icons
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PNG_SIZE = 1024;

/** Packs PNG images into an .ico: a 6-byte header, a 16-byte entry per image, then the PNG data. */
function packIco(images) {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, i) => {
        const e = 6 + 16 * i;
        header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
        header.writeUInt8(size >= 256 ? 0 : size, e + 1);
        header.writeUInt16LE(1, e + 4); // colour planes
        header.writeUInt16LE(32, e + 6); // bits per pixel
        header.writeUInt32LE(png.length, e + 8);
        header.writeUInt32LE(offset, e + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...images.map((image) => image.png)]);
}

app.whenReady().then(async () => {
    const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'));
    const win = new BrowserWindow({ show: false });
    await win.loadURL('about:blank');

    // Chromium rasterizes the vector at each target size, rather than downscaling one bitmap.
    const render = (size) => win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = ${size};
            canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('icon.svg failed to load'));
        img.src = 'data:image/svg+xml;base64,${svg.toString('base64')}';
    })`);
    const png = async (size) => Buffer.from((await render(size)).split(',')[1], 'base64');

    fs.writeFileSync(path.join(BUILD, 'icon.png'), await png(PNG_SIZE));
    const images = [];
    for (const size of ICO_SIZES) images.push({ size, png: await png(size) });
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), packIco(images));

    console.log(`wrote build/icon.png (${PNG_SIZE} px) and build/icon.ico (${ICO_SIZES.join(', ')} px)`);
    app.quit();
}).catch((err) => {
    console.error(err);
    app.exit(1);
});
