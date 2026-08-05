/**
 * The most recently uploaded file, per organization, kept where every worker
 * can see it.
 *
 * This was a module-level `new Map()`. That works for exactly as long as the
 * app is one process. cPanel runs Node under Passenger, which starts several
 * workers and spreads requests across them arbitrarily, so the classify
 * request that stored the file and the inventory request that reads it back
 * routinely land on different processes. The second one finds an empty Map and
 * reports no data — intermittently, which is the hardest kind of bug to be
 * told about, because the same click works when you retry it.
 *
 * The fix is the filesystem, not a cache server. Every Passenger worker for an
 * app runs on one machine against one disk, so a file written by any worker is
 * readable by all of them. It also survives a restart, which the Map did not:
 * an idle app being recycled used to silently empty this.
 *
 * Deliberately NOT Postgres. These are spreadsheet blobs up to 50 MB, and
 * pushing them through the session pooler to store as bytea would spend real
 * database time and connection capacity on something a file write does in
 * milliseconds.
 *
 * Entries expire. Without a TTL this directory would grow by one spreadsheet
 * per upload forever, and shared hosting bills disk.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.UPLOAD_CACHE_DIR
  || path.join(__dirname, '..', '..', 'tmp', 'last-upload');

const TTL_MS = Number(process.env.UPLOAD_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;

/**
 * Organization ids are UUIDs from our own database, not user input — but this
 * value becomes a filename, and "it can't contain a slash today" is not a
 * property worth betting the filesystem on. Hashing makes traversal
 * structurally impossible rather than merely unlikely.
 */
function keyFor(organizationId) {
  return crypto.createHash('sha256').update(String(organizationId)).digest('hex').slice(0, 32);
}

const blobPath = (key) => path.join(DIR, `${key}.bin`);
const metaPath = (key) => path.join(DIR, `${key}.json`);

async function ensureDir() {
  await fsp.mkdir(DIR, { recursive: true });
}

/**
 * @param {string} organizationId
 * @param {Buffer} buffer
 * @param {string} mimeType
 */
async function setLastUpload(organizationId, buffer, mimeType) {
  if (!organizationId || !buffer) return;
  const key = keyFor(organizationId);
  await ensureDir();

  // Write to a unique temp name and rename into place. Rename is atomic on a
  // local filesystem, so a reader on another worker sees either the previous
  // file or the complete new one — never the half-written middle of a 50 MB
  // spreadsheet, which would fail to parse in a way that looks like a corrupt
  // upload.
  const stamp = `${process.pid}.${Date.now()}`;
  const tmpBlob = `${blobPath(key)}.${stamp}.tmp`;
  const tmpMeta = `${metaPath(key)}.${stamp}.tmp`;

  try {
    await fsp.writeFile(tmpBlob, buffer);
    await fsp.writeFile(tmpMeta, JSON.stringify({ mimeType, storedAt: Date.now() }));
    await fsp.rename(tmpBlob, blobPath(key));
    await fsp.rename(tmpMeta, metaPath(key));
  } catch (err) {
    await fsp.rm(tmpBlob, { force: true }).catch(() => {});
    await fsp.rm(tmpMeta, { force: true }).catch(() => {});
    // Caching the file is an optimisation for one screen. Failing the upload
    // because the cache could not be written would be a worse outcome than
    // that screen asking for the file again.
    console.error('[last-upload] could not cache upload:', err.message);
  }
}

/**
 * @param {string} organizationId
 * @returns {Promise<{buffer: Buffer, mimeType: string}|null>}
 */
async function getLastUpload(organizationId) {
  if (!organizationId) return null;
  const key = keyFor(organizationId);

  try {
    const raw = await fsp.readFile(metaPath(key), 'utf8');
    const meta = JSON.parse(raw);

    if (Date.now() - (meta.storedAt || 0) > TTL_MS) {
      await clearLastUpload(organizationId);
      return null;
    }

    const buffer = await fsp.readFile(blobPath(key));
    return { buffer, mimeType: meta.mimeType || 'application/octet-stream' };
  } catch (err) {
    // ENOENT is the ordinary "nothing uploaded yet" case and is not an error.
    if (err.code !== 'ENOENT') {
      console.error('[last-upload] could not read cached upload:', err.message);
    }
    return null;
  }
}

async function clearLastUpload(organizationId) {
  const key = keyFor(organizationId);
  await fsp.rm(blobPath(key), { force: true }).catch(() => {});
  await fsp.rm(metaPath(key), { force: true }).catch(() => {});
}

/**
 * Deletes entries past their TTL. Called once at startup rather than on a
 * timer: a timer would fire in every Passenger worker simultaneously, and on
 * shared hosting the app is stopped when idle anyway, so a periodic sweep is
 * neither reliable nor free. Startup is the moment we know we are running.
 */
async function sweepExpired() {
  let removed = 0;
  try {
    const entries = await fsp.readdir(DIR);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(DIR, name);
      try {
        const meta = JSON.parse(await fsp.readFile(full, 'utf8'));
        if (Date.now() - (meta.storedAt || 0) > TTL_MS) {
          await fsp.rm(full, { force: true });
          await fsp.rm(full.replace(/\.json$/, '.bin'), { force: true });
          removed++;
        }
      } catch { /* unreadable entry: leave it, the next sweep can try again */ }
    }
    // Abandoned .tmp files from a write interrupted by a restart.
    for (const name of entries) {
      if (!name.endsWith('.tmp')) continue;
      const full = path.join(DIR, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > TTL_MS) {
        await fsp.rm(full, { force: true }).catch(() => {});
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[last-upload] sweep failed:', err.message);
  }
  return removed;
}

module.exports = { setLastUpload, getLastUpload, clearLastUpload, sweepExpired, DIR, TTL_MS };
