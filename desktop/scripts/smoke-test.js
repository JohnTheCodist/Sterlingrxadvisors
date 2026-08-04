/**
 * Launches the shell exactly as a customer's installed copy would, and checks
 * it actually rendered something.
 *
 * Run as an Electron main process, not with plain node:
 *   npx electron scripts/smoke-test.js
 *
 * "did-finish-load fired" is not enough to pass. The failure this exists to
 * catch is a window that loads perfectly and shows nothing: over file://, an
 * asset referenced as "/assets/index.js" resolves to the filesystem root, the
 * script 404s, React never mounts, and the page is a blank white rectangle that
 * reports no error to the main process. So the test reaches into the rendered
 * DOM and requires real mounted content.
 *
 * Exits non-zero on failure so it can gate a release.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const TIMEOUT_MS = 30000;

const problems = [];
const consoleErrors = [];
let finished = false;

function done(code) {
  if (finished) return;
  finished = true;

  console.log('\n' + '='.repeat(64));
  if (problems.length === 0) {
    console.log('SMOKE TEST PASSED — the shell renders the app.');
  } else {
    console.log('SMOKE TEST FAILED');
    problems.forEach((p) => console.log(`  - ${p}`));
  }
  if (consoleErrors.length > 0) {
    console.log(`\nRenderer console errors (${consoleErrors.length}):`);
    consoleErrors.slice(0, 12).forEach((e) => console.log(`  ! ${e}`));
  }
  console.log('='.repeat(64));

  app.exit(code);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(RENDERER)) {
    problems.push(`No renderer at ${RENDERER} — run "npm run build:renderer" first.`);
    return done(1);
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false, // no need to steal focus; the DOM is what is being checked
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    // 2 = warning, 3 = error
    if (level >= 3) consoleErrors.push(message.slice(0, 200));
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return;
    problems.push(`did-fail-load ${code} ${desc} — ${url}`);
  });

  const guard = setTimeout(() => {
    problems.push(`Timed out after ${TIMEOUT_MS}ms waiting for the app to render.`);
    done(1);
  }, TIMEOUT_MS);

  try {
    await win.loadFile(RENDERER);

    // React mounts asynchronously; give it a moment before judging the DOM.
    await new Promise((r) => setTimeout(r, 2500));

    const report = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root');
      const html = root ? root.innerHTML : '';
      return {
        title: document.title,
        hasRoot: Boolean(root),
        rootChildren: root ? root.children.length : 0,
        renderedChars: html.length,
        // Whether any asset failed to resolve, which is the file:// symptom.
        failedAssets: performance.getEntriesByType('resource')
          .filter(r => r.responseStatus >= 400 || (r.duration === 0 && r.transferSize === 0 && r.decodedBodySize === 0))
          .map(r => r.name).slice(0, 10),
        text: (root ? root.innerText || '' : '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      };
    })()`);

    clearTimeout(guard);

    console.log('\nRenderer report');
    console.log(`  document.title   ${report.title || '(none)'}`);
    console.log(`  #root present    ${report.hasRoot}`);
    console.log(`  #root children   ${report.rootChildren}`);
    console.log(`  rendered HTML    ${report.renderedChars} chars`);
    console.log(`  visible text     ${report.text ? `"${report.text}"` : '(none)'}`);

    if (!report.hasRoot) problems.push('No #root element — index.html is not the app shell.');
    if (report.rootChildren === 0) {
      problems.push('#root is empty — React did not mount. This is the blank-window failure: '
        + 'check that assets use relative "./assets/..." paths.');
    }
    if (report.renderedChars < 200) {
      problems.push(`Only ${report.renderedChars} chars rendered — the app did not draw its UI.`);
    }

    const realFailures = consoleErrors.filter((e) => /Failed to load|net::ERR|SyntaxError|is not defined/i.test(e));
    if (realFailures.length > 0) problems.push(`${realFailures.length} fatal renderer error(s) — see below.`);

    done(problems.length === 0 ? 0 : 1);
  } catch (err) {
    clearTimeout(guard);
    problems.push(`loadFile threw: ${err.message}`);
    done(1);
  }
});

app.on('window-all-closed', () => {});
