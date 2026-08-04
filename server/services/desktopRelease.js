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
const path = require('path');

const RELEASES_DIR = process.env.RELEASES_DIR
  || path.join(__dirname, '..', '..', 'releases');

/** Windows installers, newest first. */
function listBuilds() {
  if (!fs.existsSync(RELEASES_DIR)) return [];
  return fs.readdirSync(RELEASES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => {
      const full = path.join(RELEASES_DIR, f);
      const stat = fs.statSync(full);
      return {
        filename: f,
        path: full,
        bytes: stat.size,
        builtAt: stat.mtime.toISOString(),
        // "RxNaija-Setup-0.1.0.exe" -> "0.1.0"
        version: (/(\d+\.\d+\.\d+)/.exec(f) || [])[1] || null,
      };
    })
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt));
}

function latestBuild() {
  return listBuilds()[0] || null;
}

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/**
 * What the download button needs to render itself. Public on purpose — a
 * pharmacy has to be able to see the download before it has an account.
 */
function releaseInfo() {
  const build = latestBuild();
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
function sendInstaller(req, res) {
  const build = latestBuild();
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
