// Trace's icon (Flight Deck Lite, docs/design/trace/DECISIONS.md): the reticle from the top bar, Codex cyan, with
// Claude's amber at its centre, on dark slate with a faint grid. Renders it with Electron and writes:
//   assets/icon.png (1024, macOS), assets/icon.ico (256…16, Windows; PNG entries),
//   phone/public/icon-512.png, icon-192.png, apple-touch-icon.png (square and opaque: the phone masks them itself).
// Run from the repository: electron scripts/make-icon.cjs --disable-gpu
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..'); const assets = path.join(root, 'assets'); const phone = path.join(root, 'phone', 'public');
/** `simple`: for 16-32 px, thicker lines and no inner ring or grid, so it stays a clear target at that size. */
/** `square`: no rounded corners (phone icons, which the phone masks to its own shape). */
function svg(size, simple, square = false) {
  const stroke = simple ? 92 : 46;
  const grid = simple ? '' : Array.from({ length: 15 }, (_, i) => `<path d="M${(i + 1) * 64} 0V1024M0 ${(i + 1) * 64}H1024"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs><clipPath id="r"><rect width="1024" height="1024" rx="${square ? 0 : simple ? 200 : 228}"/></clipPath></defs>
  <g clip-path="url(#r)">
    <rect width="1024" height="1024" fill="#0a0e12"/>
    <g stroke="#5fe1ff" stroke-opacity=".07" stroke-width="3">${grid}</g>
    <g fill="none" stroke="#5fe1ff" stroke-width="${stroke}" stroke-linecap="square">
      <circle cx="512" cy="512" r="${simple ? 290 : 300}"/>
      ${simple ? '' : `<circle cx="512" cy="512" r="150"/>`}
      <path d="M512 ${simple ? 96 : 120}V${simple ? 300 : 330}M512 ${simple ? 724 : 694}V${simple ? 928 : 904}M${simple ? 96 : 120} 512H${simple ? 300 : 330}M${simple ? 724 : 694} 512H${simple ? 928 : 904}"/>
    </g>
    <circle cx="512" cy="512" r="${simple ? 96 : 62}" fill="#ffb547"/>
  </g>
</svg>`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, frame: false });
  const render = async (size, simple, square = false) => {
    win.setContentSize(size, size);
    await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(size, simple, square)}</body></html>`));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size }).toPNG();
  };
  fs.writeFileSync(path.join(assets, 'icon.png'), await render(1024, false));
  for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) fs.writeFileSync(path.join(phone, name), await render(size, false, true));
  // The .ico: PNG-compressed entries (Windows Vista and later), 256 down to 16.
  const sizes = [256, 128, 64, 48, 32, 24, 16]; const images = [];
  for (const size of sizes) images.push(await render(size, size <= 32));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const entries = []; let offset = 6 + 16 * sizes.length;
  sizes.forEach((size, i) => { const e = Buffer.alloc(16); e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12); offset += images[i].length; entries.push(e); });
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
  app.quit();
});
