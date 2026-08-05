/**
 * The root package.json must list every runtime dependency the server has.
 *
 * There are two manifests: server/package.json, which is convenient for local
 * work, and the root one, which is what actually gets installed on the host.
 * cPanel runs npm install from inside its own virtualenv directory rather than
 * the app root, so a nested `npm --prefix server install` resolves the prefix
 * against the wrong directory and dies with ENOENT -- one manifest at the root
 * is the only layout that survives it.
 *
 * That leaves a gap worth guarding. Add a package to server/package.json and
 * everything works locally, because server/node_modules exists on a dev
 * machine. Deploy, and the host installs only the root manifest, so the
 * require fails at startup -- a crash that appears exclusively in production,
 * after the code looked fine everywhere it was tested.
 *
 * This test closes that gap cheaply: keep the two in step, or find out here
 * rather than from a 503.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const rootPkg = require(path.join(__dirname, '..', '..', 'package.json'));
const serverPkg = require(path.join(__dirname, '..', 'package.json'));

test('root package.json lists every server runtime dependency', () => {
  const rootDeps = rootPkg.dependencies || {};
  const serverDeps = serverPkg.dependencies || {};

  const missing = Object.keys(serverDeps).filter((name) => !(name in rootDeps));

  assert.deepStrictEqual(
    missing,
    [],
    `These are in server/package.json but not the root manifest, so they would `
    + `be absent on the host and crash at startup: ${missing.join(', ')}. `
    + `Add them to the root "dependencies" as well.`,
  );
});

test('the two manifests agree on versions', () => {
  const rootDeps = rootPkg.dependencies || {};
  const serverDeps = serverPkg.dependencies || {};

  // A version that differs between the two means the host installs something
  // other than what was tested locally -- the same class of surprise, just
  // quieter, since the require succeeds and the behaviour is what changes.
  const mismatched = Object.entries(serverDeps)
    .filter(([name, range]) => name in rootDeps && rootDeps[name] !== range)
    .map(([name, range]) => `${name} (server: ${range}, root: ${rootDeps[name]})`);

  assert.deepStrictEqual(mismatched, [], `Version ranges disagree: ${mismatched.join('; ')}`);
});
