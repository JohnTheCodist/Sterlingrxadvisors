/**
 * Where an in-flight upload lives while it is being received.
 *
 * It used to be memory. multer.memoryStorage() accumulates the whole file in
 * RAM before any handler runs, so with a 50 MB limit, five people uploading at
 * once put 250 MB into the heap on top of everything the parser then allocates.
 * On shared cPanel hosting — commonly 512 MB to 1 GB for the whole
 * application — that is enough to have the worker killed, which reads to the
 * user as an upload that silently died.
 *
 * Streaming to disk instead means concurrent uploads cost disk, not heap. Peak
 * memory stops scaling with how many people happen to be uploading at the same
 * moment.
 *
 * BACKWARD COMPATIBILITY IS THE WHOLE DESIGN HERE. Roughly twenty call sites
 * read `file.buffer`, and diskStorage does not populate it — it gives you
 * `file.path`. Rewriting all of them would be a large diff through every
 * upload route in the application for no behavioural gain. So `buffer` is
 * redefined as a lazy getter that reads the file on first access and caches
 * it. Every existing call site keeps working, unchanged and unaware.
 *
 * What that does and does not buy:
 *
 *   IT DOES   remove the concurrency multiplier. Ten simultaneous uploads no
 *             longer mean ten buffers resident at once; each is materialised
 *             only inside the request that asks for it.
 *
 *   IT DOES NOT make parsing cheaper. parseSheet() takes a Buffer, so one
 *             request still holds one file in memory, and the parsed
 *             representation is several times larger than the file itself.
 *             That is the remaining ceiling and it needs a streaming parser to
 *             lift, which is a change to xlsx, not to storage.
 *
 * Temp files are removed when the response finishes. Without that, this
 * directory grows by one spreadsheet per upload until the disk quota is gone.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');

const TMP_DIR = process.env.UPLOAD_TMP_DIR
  || path.join(__dirname, '..', '..', 'tmp', 'uploads');

/** 50 MB, unchanged — this is a memory fix, not a policy change. */
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 50 * 1024 * 1024;

fs.mkdirSync(TMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  // The generated name is random and extension-free. The original filename is
  // attacker-controlled and is preserved on file.originalname for display, but
  // it never reaches the filesystem, so "../../..%2fetc/passwd" cannot decide
  // where anything is written.
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}`),
});

/**
 * Gives a disk-backed multer file the `buffer` property every existing caller
 * expects. Read once, then cached, so two reads in one request do not mean two
 * trips to disk.
 */
function attachLazyBuffer(file) {
  if (!file || !file.path || Object.prototype.hasOwnProperty.call(file, 'buffer')) return;
  let cached = null;
  Object.defineProperty(file, 'buffer', {
    configurable: true,
    enumerable: false,
    get() {
      // Synchronous on purpose. Callers do `parseSheet(file.buffer)` inline,
      // and an async getter is not a thing a property access can await. The
      // read is one file, already local, inside a request that is about to
      // spend far longer parsing it.
      if (cached === null) cached = fs.readFileSync(this.path);
      return cached;
    },
  });
}

/** Every file on the request, whichever multer shape produced it. */
function filesOn(req) {
  const out = [];
  if (req.file) out.push(req.file);
  if (Array.isArray(req.files)) out.push(...req.files);
  else if (req.files && typeof req.files === 'object') {
    for (const list of Object.values(req.files)) {
      if (Array.isArray(list)) out.push(...list);
    }
  }
  return out;
}

/**
 * Wraps a multer middleware so callers get `file.buffer` and the temp file is
 * deleted once the response is done.
 *
 * Cleanup hangs off the response rather than the end of the handler because
 * handlers return early on a dozen validation paths, and a leak on the
 * error paths is exactly the leak that fills a disk — errors are common and
 * the happy path is the one people remember to clean up.
 */
function withDiskUpload(mw) {
  return function (req, res, done) {
    mw(req, res, (err) => {
      const files = filesOn(req);
      files.forEach(attachLazyBuffer);

      if (files.length > 0) {
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          for (const f of files) {
            if (!f.path) continue;
            fsp.rm(f.path, { force: true })
              .catch((e) => console.error('[upload] could not remove temp file:', e.message));
          }
        };
        // 'close' fires on aborted connections too, which 'finish' does not —
        // and an upload the user cancelled mid-request is precisely when a
        // temp file would otherwise be orphaned.
        res.on('close', cleanup);
        res.on('finish', cleanup);
      }

      done(err);
    });
  };
}

/** Removes temp files left behind by a worker that was killed mid-request. */
async function sweepOrphans(maxAgeMs = 6 * 60 * 60 * 1000) {
  let removed = 0;
  try {
    for (const name of await fsp.readdir(TMP_DIR)) {
      const full = path.join(TMP_DIR, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.isFile() && Date.now() - stat.mtimeMs > maxAgeMs) {
        await fsp.rm(full, { force: true }).catch(() => {});
        removed++;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[upload] orphan sweep failed:', err.message);
  }
  return removed;
}

module.exports = { storage, withDiskUpload, sweepOrphans, TMP_DIR, MAX_BYTES, os };
