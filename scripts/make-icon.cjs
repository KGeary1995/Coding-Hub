// Trace's icon (docs/design/trace/DECISIONS.md): 2a-2 "Lip", chosen 2026-11-08 from the Claude Design rounds. An amber
// keycap (#ffb547) on a darker amber lip (#b9700f), with a bold T cut out of it, on a near-black tile. The top bar
// (Topbar.tsx) and the phone (phone/main.ts) draw the same keycap from the 32 px drawing below; change all three together.
// Renders it with Electron and writes:
//   assets/icon.png (1024, macOS), assets/icon.ico (256…16, Windows; PNG entries),
//   phone/public/icon-512.png, icon-192.png, apple-touch-icon.png (square and opaque: the phone masks them itself).
// Run from the repository: electron scripts/make-icon.cjs --disable-gpu
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..'); const assets = path.join(root, 'assets'); const phone = path.join(root, 'phone', 'public');
/** A keycap outline on the 256 grid: x from `left` to `256 - left`, top at `top`, `height` tall, the design's squircle corners. */
function cap(left, top, height) {
  const right = 256 - left; const c = (n) => n.toFixed(3);
  return `M${left + 62} ${top}H${right - 62}c19.570 0 29.354 0 37.073 3.197a42 42 0 0 1 22.730 22.730c3.197 7.718 3.197 17.503 3.197 37.073V${c(top + height - 63)}c0 19.570 0 29.354 -3.197 37.073a42 42 0 0 1 -22.730 22.730c-7.718 3.197 -17.503 3.197 -37.073 3.197H${left + 62}c-19.570 0 -29.354 0 -37.073 -3.197a42 42 0 0 1 -22.730 -22.730c-3.197 -7.718 -3.197 -17.503 -3.197 -37.073V${c(top + 63)}c0 -19.570 0 -29.354 3.197 -37.073a42 42 0 0 1 22.730 -22.730c7.718 -3.197 17.503 -3.197 37.073 -3.197Z`;
}
/**
 * The three optical drawings from the design, on a 256 grid: `large` (48 px and up), `small` (24-32 px: heavier T,
 * deeper lip) and `tiny` (16 px: bigger keycap, deeper lip, heavier T). `tile`: the dark tile's inset and border width.
 */
const DRAWINGS = {
  large: { tile: [1, 2], face: cap(41, 37, 168), lip: 14, t: 'M79 70H177A9 9 0 0 1 186 79V95A9 9 0 0 1 177 104H154A7 7 0 0 0 147 111V167A9 9 0 0 1 138 176H118A9 9 0 0 1 109 167V111A7 7 0 0 0 102 104H79A9 9 0 0 1 70 95V79A9 9 0 0 1 79 70Z' },
  small: { tile: [4, 8], face: cap(39, 35, 168), lip: 16, t: 'M76 66H180A8 8 0 0 1 188 74V94A8 8 0 0 1 180 102H154A6 6 0 0 0 148 108V166A8 8 0 0 1 140 174H116A8 8 0 0 1 108 166V108A6 6 0 0 0 102 102H76A8 8 0 0 1 68 94V74A8 8 0 0 1 76 66Z' },
  tiny: { tile: [8, 16], face: cap(31, 26, 182), lip: 22, t: 'M69 60H187A7 7 0 0 1 194 67V97A7 7 0 0 1 187 104H157A5 5 0 0 0 152 109V169A7 7 0 0 1 145 176H111A7 7 0 0 1 104 169V109A5 5 0 0 0 99 104H69A7 7 0 0 1 62 97V67A7 7 0 0 1 69 60Z' },
};
/** `square`: a full opaque square with no tile border (phone icons, which the phone masks to its own shape). */
function svg(size, drawing, square = false) {
  const { tile: [inset, border], face, lip, t } = DRAWINGS[drawing];
  const background = square
    ? '<rect width="256" height="256" fill="url(#g)"/>'
    : `<rect x="${inset}" y="${inset}" width="${256 - 2 * inset}" height="${256 - 2 * inset}" rx="56" fill="url(#g)" stroke="#2a2e33" stroke-width="${border}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141619"/><stop offset="1" stop-color="#090a0b"/></linearGradient></defs>
  ${background}
  <path transform="translate(0 ${lip})" d="${face}" fill="#b9700f"/>
  <path d="${face}" fill="#ffb547"/>
  <path d="${t}" fill="#0b0c0e"/>
</svg>`;
}
const drawingFor = (size) => size <= 16 ? 'tiny' : size <= 32 ? 'small' : 'large';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, frame: false });
  const render = async (size, square = false) => {
    win.setContentSize(size, size);
    await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(size, drawingFor(size), square)}</body></html>`));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size }).toPNG();
  };
  fs.writeFileSync(path.join(assets, 'icon.png'), await render(1024));
  for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) fs.writeFileSync(path.join(phone, name), await render(size, true));
  // The .ico: PNG-compressed entries (Windows Vista and later), 256 down to 16.
  const sizes = [256, 128, 64, 48, 32, 24, 16]; const images = [];
  for (const size of sizes) images.push(await render(size));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const entries = []; let offset = 6 + 16 * sizes.length;
  sizes.forEach((size, i) => { const e = Buffer.alloc(16); e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12); offset += images[i].length; entries.push(e); });
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
  app.quit();
});
