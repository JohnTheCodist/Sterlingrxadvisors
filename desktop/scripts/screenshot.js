/**
 * Captures the shell's window to a PNG, so what shipped can be looked at
 * without installing it.
 *
 *   npx electron scripts/screenshot.js [outfile]
 *
 * Uses webContents.capturePage(), which reads the real compositor output —
 * the same pixels a customer would see, not a re-render.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Anything after the script that looks like a URL is loaded instead of the
// bundled renderer, so the same tool can capture a dev-server page.
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const urlArg = args.find((a) => /^https?:\/\//i.test(a));
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const OUT = args.find((a) => a.toLowerCase().endsWith('.png'))
  || path.join(__dirname, '..', 'shell-window.png');

app.whenReady().then(async () => {
  if (!urlArg && !fs.existsSync(RENDERER)) {
    console.error(`No renderer at ${RENDERER} — run "npm run build:renderer" first.`);
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    backgroundColor: '#f7f8fa',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  try {
    await (urlArg ? win.loadURL(urlArg) : win.loadFile(RENDERER));
    // Let fonts, images and the first React paint settle, or the capture
    // catches a half-drawn frame and misrepresents the product.
    await new Promise((r) => setTimeout(r, 3500));

    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT, image.toPNG());
    const kb = Math.round(fs.statSync(OUT).size / 1024);
    console.log(`Captured ${OUT} (${kb} KB)`);
    app.exit(0);
  } catch (err) {
    console.error(`Capture failed: ${err.message}`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
