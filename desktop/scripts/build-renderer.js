#!/usr/bin/env node
/**
 * Builds the SAME client the website uses, configured for the desktop shell,
 * and copies the result to desktop/renderer/.
 *
 * Two settings differ from a web build, and both are required:
 *
 *   --base ./              Electron loads the UI over file://, where an asset
 *                          referenced as "/assets/index.js" resolves to the
 *                          filesystem ROOT and 404s. Vite defaults to absolute
 *                          paths, so without this the packaged app opens to a
 *                          blank white window with console errors and no other
 *                          clue what went wrong.
 *
 *   --outDir               Writes straight to desktop/renderer. This build used
 *                          to land in client/dist and get copied here, which
 *                          meant building the desktop app silently replaced the
 *                          WEBSITE's bundle with one that has relative asset
 *                          paths and a hard-coded API origin. Deploying after a
 *                          desktop build then pointed the live site at whatever
 *                          machine built it. Nothing writes to client/dist from
 *                          here any more.
 *
 *   VITE_API_BASE_URL      The web build leaves this empty and uses relative
 *                          '/api/...' against its own origin. From file:// there
 *                          is no origin to be relative to, so the desktop build
 *                          needs the absolute address of the hosted backend.
 *                          See client/src/lib/apiClient.js.
 *
 * Nothing else changes. Same source, same components, same behaviour.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');
const CLIENT_DIST = path.join(CLIENT_DIR, 'dist');
const RENDERER_DIR = path.join(DESKTOP_DIR, 'renderer');

const API_ORIGIN = process.env.STERLINGRX_API_ORIGIN || 'https://app.sterlingrxadvisors.com';

function run(cmd, args, opts) {
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

function main() {
  if (!fs.existsSync(CLIENT_DIR)) {
    console.error(`Cannot find the client at ${CLIENT_DIR}`);
    process.exit(1);
  }

  console.log(`Building renderer against ${API_ORIGIN}`);

  // Replace wholesale rather than merging, so a renamed or deleted asset from a
  // previous build cannot linger and get shipped. --emptyOutDir is required
  // because the target sits outside the Vite root; without it Vite refuses to
  // clear a directory it did not create.
  fs.rmSync(RENDERER_DIR, { recursive: true, force: true });

  run('npx', ['vite', 'build', '--base', './', '--outDir', RENDERER_DIR, '--emptyOutDir'], {
    cwd: CLIENT_DIR,
    // VITE_DESKTOP lets the UI hide anything that cannot work from file://,
    // notably OAuth, which needs a real web origin to redirect back to.
    env: { ...process.env, VITE_API_BASE_URL: API_ORIGIN, VITE_DESKTOP: 'true' },
  });

  if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) {
    console.error('Renderer build produced no index.html — aborting.');
    process.exit(1);
  }

  // The website's bundle must be exactly what it was before this ran. If a
  // future change reintroduces a write to client/dist, the deploy that follows
  // would put desktop asset paths and a compiled-in API origin on the live
  // site, so it is worth one assertion here rather than a production incident.
  if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    const webHtml = fs.readFileSync(path.join(CLIENT_DIST, 'index.html'), 'utf8');
    if (/(?:src|href)="\.\//.test(webHtml)) {
      console.error('\nclient/dist now contains relative asset paths — the desktop build leaked into the web bundle.');
      console.error('Rebuild the site with:  cd client && npx vite build');
      process.exit(1);
    }
  }

  // A packaged app that quietly ships absolute asset paths opens to a blank
  // window and is painful to diagnose after the fact. Catch it here instead.
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const absolute = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
  if (absolute.length > 0) {
    console.error('\nBuilt HTML still references absolute paths, which cannot load over file://:');
    absolute.forEach((a) => console.error(`  ${a}`));
    console.error('The --base ./ flag did not take effect. Aborting.');
    process.exit(1);
  }

  const files = fs.readdirSync(RENDERER_DIR);
  console.log(`\nRenderer ready at desktop/renderer (${files.length} entries)`);
  console.log('Asset paths are relative — safe to load over file://');
}

main();
