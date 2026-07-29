/**
 * NCDC Report Storage.
 *
 * Owns two things only:
 *   1. The local filesystem layout for downloaded PDFs
 *      (storage/ncdc/{year}/week{epiWeek}.pdf).
 *   2. The DownloadedReport metadata record for each one
 *      (server/data/ncdc-downloads.json).
 *
 * This is deliberately a separate concern from reportDownloader.js, which
 * only knows how to fetch bytes over HTTP — it asks this module where to
 * put them and whether they're already there.
 *
 * Not to be confused with reportDiscovery.js's own tracking file — that
 * one tracks "what's the latest report I've compared against" for the
 * isNew calculation; this one tracks "what have I actually downloaded and
 * where is it." Two different questions, two different files.
 */

const fs = require('fs');
const path = require('path');
const { NCDC_CONFIG } = require('./ncdcConfig');

const RECORDS_PATH = path.join(__dirname, '..', '..', 'data', 'ncdc-downloads.json');

const STATUS = { DOWNLOADED: 'DOWNLOADED', FAILED: 'FAILED' };

// ---- filesystem layout ----------------------------------------------------

function localPathFor(year, epiWeek) {
  return path.join(NCDC_CONFIG.storageDir, String(year), `week${epiWeek}.pdf`);
}

function ensureDirFor(year) {
  const dir = path.join(NCDC_CONFIG.storageDir, String(year));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileExistsLocally(year, epiWeek) {
  return fs.existsSync(localPathFor(year, epiWeek));
}

// ---- DownloadedReport records ----------------------------------------------

function loadRecords() {
  try {
    if (fs.existsSync(RECORDS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(RECORDS_PATH, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (_) { /* corrupt file — start fresh rather than crash */ }
  return [];
}

function saveRecords(records) {
  try {
    fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });
    fs.writeFileSync(RECORDS_PATH, JSON.stringify(records, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function getRecord(year, epiWeek) {
  return loadRecords().find((r) => r.year === year && r.epiWeek === epiWeek) || null;
}

/**
 * Insert or update the DownloadedReport record for (year, epiWeek).
 * @param {{year:number, epiWeek:number, publishedDate:*, reportUrl:string, localPath:string, downloadedAt:*, status:'DOWNLOADED'|'FAILED'}} record
 */
function upsertRecord(record) {
  const records = loadRecords();
  const idx = records.findIndex((r) => r.year === record.year && r.epiWeek === record.epiWeek);
  const normalized = {
    ...record,
    publishedDate: record.publishedDate instanceof Date ? record.publishedDate.toISOString() : record.publishedDate,
    downloadedAt: record.downloadedAt instanceof Date ? record.downloadedAt.toISOString() : record.downloadedAt,
  };
  if (idx === -1) records.push(normalized);
  else records[idx] = normalized;
  saveRecords(records);
  return normalized;
}

module.exports = {
  STATUS,
  localPathFor,
  ensureDirFor,
  fileExistsLocally,
  getRecord,
  upsertRecord,
  loadRecords,
};
