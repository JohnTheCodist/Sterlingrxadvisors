/**
 * Checks that the shell can actually reach a running backend, which is the
 * part a screenshot cannot tell you.
 *
 *   npx electron scripts/verify-live.js [url]
 *
 * Loads the dev server in a real window, then makes a request from inside the
 * renderer to confirm the API is reachable from where the app actually runs.
 * A window that renders perfectly and cannot talk to the server looks fine and
 * is useless.
 */

const { app, BrowserWindow } = require('electron');

const URL_UNDER_TEST = process.argv[2] || process.env.STERLINGRX_DEV_URL || 'http://localhost:5173';
const API_PROBE = process.env.STERLINGRX_API_PROBE || '/api/health';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  const problems = [];

  // A component that throws during render unmounts the whole tree, leaving a
  // blank page whose only explanation is in the console.
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(message.slice(0, 400));
  });

  try {
    await win.loadURL(URL_UNDER_TEST);
    await new Promise((r) => setTimeout(r, 2500));

    const ui = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root');
      return {
        title: document.title,
        rendered: root ? root.innerHTML.length : 0,
        mainHeight: Math.round(document.querySelector('main')?.getBoundingClientRect().height || 0),
        protocol: location.protocol,
        pathname: location.pathname,
      };
    })()`);

    console.log('\nUI');
    console.log(`  loaded          ${URL_UNDER_TEST}`);
    console.log(`  protocol        ${ui.protocol}  (router: ${ui.protocol === 'file:' ? 'Hash' : 'Browser'})`);
    console.log(`  title           ${ui.title}`);
    console.log(`  rendered        ${ui.rendered} chars`);
    console.log(`  <main> height   ${ui.mainHeight}px`);

    if (ui.rendered < 200) problems.push('UI did not render.');
    if (ui.mainHeight === 0) problems.push('<main> is empty — no route matched.');

    // Reach the API from inside the renderer, the same origin the app uses.
    const api = await win.webContents.executeJavaScript(`
      fetch(${JSON.stringify(API_PROBE)}, { method: 'GET' })
        .then(async r => ({ ok: true, status: r.status, body: (await r.text()).slice(0, 120) }))
        .catch(e => ({ ok: false, error: e.message }))
    `);

    console.log('\nAPI');
    console.log(`  probe           ${API_PROBE}`);
    if (api.ok) {
      console.log(`  status          ${api.status}`);
      console.log(`  body            ${api.body}`);
      // 401/404 still prove the server answered; only a transport failure matters.
      if (api.status >= 500) problems.push(`API returned ${api.status}.`);
    } else {
      console.log(`  FAILED          ${api.error}`);
      problems.push(`Could not reach the API: ${api.error}`);
    }

    if (consoleErrors.length > 0) {
      console.log(`\nRenderer errors (${consoleErrors.length})`);
      consoleErrors.slice(0, 6).forEach((e) => console.log(`  ! ${e}`));
    }

    console.log('\n' + '='.repeat(60));
    if (problems.length === 0) {
      console.log('LIVE CHECK PASSED — shell renders and reaches the backend.');
    } else {
      console.log('LIVE CHECK FAILED');
      problems.forEach((p) => console.log(`  - ${p}`));
    }
    console.log('='.repeat(60));

    app.exit(problems.length === 0 ? 0 : 1);
  } catch (err) {
    console.error(`\nFailed to load ${URL_UNDER_TEST}: ${err.message}`);
    console.error('Is the dev server running?  cd client && npm run dev');
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
