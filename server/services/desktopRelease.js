/**
 * Serving the desktop installer for download.
 *
 * The installer is a ~78 MB binary and is deliberately NOT in git: committing
 * one per release would bloat the repository permanently and irreversibly, and
 * a build artefact rebuildable from source does not belong in version control.
 * It is read from a `releases/` directory at the repo root, which is
 * gitignored and populated by `cd desktop && npm run dist`.
 *
 * This is the shape to keep when moving to object storage later: the route
 * answers "what is downloadable and how big is it", and the client renders
 * whatever that says. Swapping the filesystem for a signed S3 URL then touches
 * this file only.
 *
 * When no build is present the API says so plainly rather than 404ing, so the
 * site can hide the button instead of offering a link that fails.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const RELEASES_DIR = process.env.RELEASES_DIR
  || path.join(__dirname, '..', '..', 'releases');

/**
 * The download page asks what is available on every render, and this used to
 * answer with a directory read plus a stat per file, synchronously, on the
 * request thread. Node has one of those per worker, so every one of those
 * calls stopped the worker serving anyone else — for a directory whose
 * contents change when someone publishes a release, which is rarely.
 *
 * Now async, and cached for a short window. A new build shows up within the
 * TTL without a restart, and a burst of traffic on the download page costs one
 * directory read between them rather than one each.
 */
const CACHE_TTL_MS = Number(process.env.RELEASES_CACHE_TTL_MS) || 60 * 1000;
let cache = { at: 0, builds: null };

/** Windows installers, newest first. */
async function listBuilds() {
  if (cache.builds && Date.now() - cache.at < CACHE_TTL_MS) return cache.builds;

  let names;
  try {
    names = await fsp.readdir(RELEASES_DIR);
  } catch (err) {
    // No releases directory is the normal state on a fresh host, not a fault.
    if (err.code !== 'ENOENT') console.error('[desktop-release] cannot read releases dir:', err.message);
    cache = { at: Date.now(), builds: [] };
    return cache.builds;
  }

  const builds = [];
  for (const f of names.filter((n) => n.toLowerCase().endsWith('.exe'))) {
    const full = path.join(RELEASES_DIR, f);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    builds.push({
      filename: f,
      path: full,
      bytes: stat.size,
      builtAt: stat.mtime.toISOString(),
      // "SterlingRx-Setup-0.1.0.exe" -> "0.1.0"
      version: (/(\d+\.\d+\.\d+)/.exec(f) || [])[1] || null,
    });
  }

  builds.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  cache = { at: Date.now(), builds };
  return builds;
}

async function latestBuild() {
  return (await listBuilds())[0] || null;
}

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/**
 * What the download button needs to render itself. Public on purpose — a
 * pharmacy has to be able to see the download before it has an account.
 */
async function releaseInfo() {
  const build = await latestBuild();
  if (!build) {
    return {
      available: false,
      reason: 'No desktop build has been published yet.',
    };
  }
  return {
    available: true,
    version: build.version,
    filename: build.filename,
    sizeBytes: build.bytes,
    sizeMB: mb(build.bytes),
    builtAt: build.builtAt,
    platform: 'windows',
    // Set honestly by whoever publishes the build. An unsigned installer
    // triggers a full-screen SmartScreen warning, and the download page has to
    // warn the user BEFORE they see it or they will assume the file is malware.
    signed: process.env.DESKTOP_BUILD_SIGNED === 'true',
    minimumOS: 'Windows 10 (64-bit) or later',
  };
}

/**
 * Streams the installer. Kept as a normal download rather than a redirect so
 * the filename and size are under our control and the browser shows a real
 * progress bar.
 */
async function sendInstaller(req, res) {
  const build = await latestBuild();
  if (!build) {
    return res.status(404).json({
      error: 'No desktop build is available for download yet.',
    });
  }

  // Guard against a filename with traversal in it ever reaching this far.
  const resolved = path.resolve(build.path);
  if (!resolved.startsWith(path.resolve(RELEASES_DIR))) {
    return res.status(400).json({ error: 'Invalid release path.' });
  }

  res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.setHeader('Content-Disposition', `attachment; filename="${build.filename}"`);
  res.setHeader('Content-Length', build.bytes);
  // A new build reuses the same URL, so caching it would hand users a stale
  // installer after an update.
  res.setHeader('Cache-Control', 'no-cache');

  const stream = fs.createReadStream(build.path);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not read the installer.' });
    else res.end();
    console.error('[desktop-release] stream failed:', err.message);
  });
  return stream.pipe(res);
}

module.exports = { releaseInfo, sendInstaller, listBuilds, latestBuild, RELEASES_DIR };
