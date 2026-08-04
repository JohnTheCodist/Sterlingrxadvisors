/**
 * NCDC Report Downloader.
 *
 * Single responsibility: given an already-discovered report's metadata,
 * download its PDF and store it locally. Does NOT parse the PDF, read its
 * contents, extract disease data, generate intelligence, or touch the
 * Decision Engine / Weather / Calendar. Downloaded does not mean processed
 * — this module never marks anything as "processed" (that's
 * reportDiscovery.js's tracking, and it belongs to whichever future sprint
 * actually parses a report).
 */

const fs = require('fs');
const { NCDC_CONFIG } = require('./ncdcConfig');
const storage = require('./reportStorage');

function isPlausibleUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function fetchPdfBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NCDC_CONFIG.downloadTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SterlingRxAdvisors/1.0)' },
    });

    if (response.status === 404) {
      return { error: true, reason: 'Report PDF not found (HTTP 404).' };
    }
    if (!response.ok) {
      return { error: true, reason: `Download failed with HTTP ${response.status}.` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return { error: true, reason: 'Downloaded file was empty.' };
    }

    // Partial-download check: if the server told us how big the file
    // should be, make sure we actually got that many bytes.
    const expectedLength = response.headers.get('content-length');
    if (expectedLength && Number(expectedLength) !== buffer.length) {
      return { error: true, reason: `Partial download — expected ${expectedLength} bytes, got ${buffer.length}.` };
    }

    return { error: false, buffer };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: true, reason: 'Download timed out.' };
    }
    return { error: true, reason: `Network error during download: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Download a discovered report's PDF and store it locally.
 *
 * @param {import('./ncdcTypes').NCDCReportMetadata} reportMetadata
 * @returns {Promise<{success:true, localPath:string, downloadedAt:Date} | {success:false, reason:string}>}
 */
async function downloadReport(reportMetadata) {
  if (!reportMetadata || typeof reportMetadata !== 'object') {
    return { success: false, reason: 'No report metadata provided.' };
  }

  const { year, epiWeek, publishedDate, reportUrl, isNew } = reportMetadata;

  if (isNew === false) {
    console.log('[ncdc-downloader] Skipped — report is not new.');
    return { success: false, reason: 'Report is not new — download skipped.', skipped: true };
  }

  if (typeof year !== 'number' || typeof epiWeek !== 'number') {
    console.warn('[ncdc-downloader] Download failed: missing/invalid year or epiWeek in metadata.');
    return { success: false, reason: 'Report metadata is missing a valid year or epiWeek.' };
  }

  // Never download the same report twice.
  if (storage.fileExistsLocally(year, epiWeek)) {
    console.log('[ncdc-downloader] Already downloaded');
    const existing = storage.getRecord(year, epiWeek);
    return {
      success: true,
      localPath: storage.localPathFor(year, epiWeek),
      downloadedAt: existing ? existing.downloadedAt : null,
    };
  }

  if (!isPlausibleUrl(reportUrl)) {
    console.warn('[ncdc-downloader] Download failed: invalid report URL.');
    storage.upsertRecord({ year, epiWeek, publishedDate, reportUrl, localPath: null, downloadedAt: new Date(), status: storage.STATUS.FAILED });
    return { success: false, reason: 'Report URL is missing or invalid.' };
  }

  console.log('[ncdc-downloader] Download started');
  const fetchResult = await fetchPdfBytes(reportUrl);

  if (fetchResult.error) {
    console.warn('[ncdc-downloader] Download failed:', fetchResult.reason);
    storage.upsertRecord({ year, epiWeek, publishedDate, reportUrl, localPath: null, downloadedAt: new Date(), status: storage.STATUS.FAILED });
    return { success: false, reason: fetchResult.reason };
  }

  try {
    storage.ensureDirFor(year);
    const localPath = storage.localPathFor(year, epiWeek);
    fs.writeFileSync(localPath, fetchResult.buffer);

    const downloadedAt = new Date();
    storage.upsertRecord({ year, epiWeek, publishedDate, reportUrl, localPath, downloadedAt, status: storage.STATUS.DOWNLOADED });

    console.log('[ncdc-downloader] Download completed');
    return { success: true, localPath, downloadedAt };
  } catch (err) {
    console.warn('[ncdc-downloader] Download failed:', err.message);
    storage.upsertRecord({ year, epiWeek, publishedDate, reportUrl, localPath: null, downloadedAt: new Date(), status: storage.STATUS.FAILED });
    return { success: false, reason: `Could not save file: ${err.message}` };
  }
}

module.exports = { downloadReport };
