/**
 * Generates the application icon from the product's own brand mark.
 *
 *   npx electron scripts/make-icon.js
 *
 * The repository has no logo files -- the "Rx" mark in the UI is drawn in CSS
 * (.brand-mark in client/src/index.css: a rounded square in --primary with the
 * monospace wordmark in --primary-foreground). Rather than approximate that by
 * hand in an image editor and let the two drift, this renders the same shape
 * and the same colour values in a window and captures the result, so the icon
 * and the in-app mark cannot disagree.
 *
 * Writes 256px and 512px PNGs. electron-builder derives the Windows .ico from
 * icon.png, and 256 is the largest size Windows actually uses.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const BUILD_DIR = path.join(__dirname, '..', 'build');

// Copied from client/src/index.css. Kept as literals because this script must
// run without the client being built.
const PRIMARY = 'oklch(0.52 0.088 194)';
const PRIMARY_FG = 'oklch(0.99 0.005 190)';

/**
 * At 256px the mark needs slightly different proportions than at 34px: the
 * corner radius scales, and the letter is set larger relative to the tile so
 * it stays legible once Windows shrinks it into a taskbar.
 *
 * One letter, not two. "Rx" had to hold its own width at 16px in a taskbar and
 * turned into a smudge; a single S keeps its counter open at that size, which
 * is the only size that decides whether an icon is recognisable.
 */
const html = (size) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .tile {
    width: ${size}px; height: ${size}px;
    border-radius: ${Math.round(size * 0.22)}px;
    background: ${PRIMARY};
    color: ${PRIMARY_FG};
    display: flex; align-items: center; justify-content: center;
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: ${Math.round(size * 0.56)}px;
    font-weight: 700;
    letter-spacing: 0;
  }
</style></head>
<body><div class="tile">S</div></body></html>`;

async function capture(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: false },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(size))}`);
  // Give the webfont a chance; the fallback is a monospace face either way.
  await new Promise((r) => setTimeout(r, 900));

  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

app.whenReady().then(async () => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  try {
    for (const size of [512, 256]) {
      const image = await capture(size);
      const out = size === 256
        ? path.join(BUILD_DIR, 'icon.png')
        : path.join(BUILD_DIR, `icon-${size}.png`);
      fs.writeFileSync(out, image.toPNG());
      const { width, height } = image.getSize();
      console.log(`  ${path.basename(out).padEnd(16)} ${width}x${height}  ${Math.round(fs.statSync(out).size / 1024)} KB`);
    }
    console.log(`\nIcons written to ${BUILD_DIR}`);
    app.exit(0);
  } catch (err) {
    console.error(`Icon generation failed: ${err.message}`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
