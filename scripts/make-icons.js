// Renders assets/logo.svg and assets/tray.svg to the PNGs the app uses.
// Run with Electron (it has a full SVG renderer): `npm run icons`.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const jobs = [
  { svg: 'logo.svg', out: 'icon.png', size: 1024 },
  { svg: 'tray.svg', out: 'trayTemplate.png', size: 18 },
  { svg: 'tray.svg', out: 'trayTemplate@2x.png', size: 36 },
];

async function render(svgFile, size) {
  const svg = fs.readFileSync(path.join(assets, svgFile), 'utf8');
  const win = new BrowserWindow({ show: false, width: size, height: size, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.on('window-all-closed', () => {}); // keep going between renders
app.whenReady().then(async () => {
  for (const j of jobs) {
    fs.writeFileSync(path.join(assets, j.out), await render(j.svg, j.size));
    console.log(`wrote assets/${j.out}`);
  }
  app.quit();
});
