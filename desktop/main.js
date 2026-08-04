/**
 * RxNaija Desktop — Electron shell.
 *
 * This process deliberately contains no business logic. It opens a window onto
 * the same React UI the web product serves, which talks to the same hosted
 * backend, so a desktop customer is just another organization in the system
 * that already exists. Every feature works identically because there is only
 * one implementation of each.
 *
 * What the shell buys, honestly stated, is mostly perception: a desktop icon,
 * its own window, no URL bar, no tab to close by accident, and auto-update. In
 * this market that perception is worth real money — but it is packaging, not
 * capability.
 *
 * The UI is loaded from files bundled in the app rather than fetched from the
 * website. That keeps the window up instantly, avoids a white screen when the
 * connection is slow, and means an update ships as an app update rather than a
 * silent change under the user.
 */

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');

// Where the hosted backend lives. Baked in at build time; the renderer gets it
// through VITE_API_BASE_URL when the client bundle is built.
const API_ORIGIN = process.env.RXNAIJA_API_ORIGIN || 'https://app.rxnaija.com';

// Unpackaged normally means "developing", which loads the Vite dev server.
// But the failure worth catching -- assets resolving against the filesystem
// root over file:// and leaving a blank window -- only exists on the PACKAGED
// path, so there has to be a way to exercise that without building an
// installer first.
// A CLI flag rather than an env var, because an inline `VAR=1 electron .` in an
// npm script does not work on Windows without pulling in cross-env.
const forceRenderer = process.argv.includes('--force-renderer')
  || process.env.RXNAIJA_FORCE_RENDERER === '1';
const isDev = !app.isPackaged && !forceRenderer;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false, // revealed on ready-to-show, so no white flash on launch
    backgroundColor: '#f7f8fa',
    title: 'RxNaija Analytics',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      // No Node in the renderer. The UI is ordinary web code and must not be
      // handed filesystem or process access it has no use for — an XSS in a
      // dependency would otherwise reach the pharmacy's whole machine.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Anything that is not our own UI opens in the real browser rather than
  // inside the app window, where there would be no address bar to show the
  // user where they had ended up.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const isLocalUI = target.protocol === 'file:';
    const isOurApi = target.origin === new URL(API_ORIGIN).origin;
    // In dev the UI is served from the Vite dev server, which is neither
    // file:// nor the production API origin. Without this, every full-page
    // navigation during development was ejected into the system browser and
    // the app looked like it was refusing to work.
    const isDevServer = isDev && target.origin === new URL(
      process.env.RXNAIJA_DEV_URL || 'http://localhost:5173',
    ).origin;
    if (!isLocalUI && !isOurApi && !isDevServer) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // A blank window with no explanation is the worst possible failure. Say what
  // happened and what to check.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return; // aborted by a redirect; not a real failure
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Could not load',
      message: 'RxNaija could not load part of the application.',
      detail: `${description} (${code})\n${url}\n\n`
        + 'Check your internet connection and try again. If this keeps happening, '
        + 'contact support.',
      buttons: ['Retry', 'Close'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) mainWindow.reload();
    });
  });

  if (isDev) {
    // Point at the Vite dev server so the normal edit-reload loop still works.
    mainWindow.loadURL(process.env.RXNAIJA_DEV_URL || 'http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
}

/**
 * A trimmed menu. The default Electron menu offers a pharmacist a lot of
 * developer tooling they have no use for, and a Help menu they do.
 */
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'reload', label: 'Refresh' },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Contact support',
          click: () => shell.openExternal('mailto:support@rxnaija.com'),
        },
        {
          label: 'About RxNaija',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About RxNaija Analytics',
            message: `RxNaija Analytics ${app.getVersion()}`,
            detail: `Connected to ${API_ORIGIN}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One window only. Launching a second time focuses the existing one rather
// than opening a duplicate that would confuse which is "the" app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
