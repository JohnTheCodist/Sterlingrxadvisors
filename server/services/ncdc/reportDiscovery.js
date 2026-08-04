/**
 * NCDC Report Discovery Service.
 *
 * Single responsibility: detect the latest published NCDC Weekly
 * Epidemiological Report and its metadata. Does NOT download files, parse
 * PDFs, extract disease data, generate recommendations, or connect to any
 * other module (Decision Engine, Inventory, Weather, Calendar). Those are
 * later phases.
 *
 * The extraction regexes below are grounded in the actual live page
 * structure (fetched and inspected directly), not guessed:
 *   <h1>Weekly Epidemiological Report</h1>
 *   <h2>July 2026 <span class="pull-right">Week 27</span></h2>
 *   <h5>Posted: 22-07-2026 02:21:55 PM</h5>
 *   <a ... href="/themes/common/docs/wers/689_1784726515.pdf" download="27_July_2026.pdf">
 * If NCDC changes this markup, parsing fails gracefully (structured error),
 * it does not crash or silently return wrong data.
 */

const path = require('path');
const fs = require('fs');
const { NCDC_CONFIG } = require('./ncdcConfig');

const TRACKING_PATH = path.join(__dirname, '..', '..', 'data', 'ncdc-last-processed.json');

// ---- fetch --------------------------------------------------------------

async function fetchReportsPageHtml() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NCDC_CONFIG.requestTimeoutMs);

  try {
    const response = await fetch(NCDC_CONFIG.reportsPage, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SterlingRxAdvisors/1.0)' },
    });
    if (!response.ok) {
      return { error: true, reason: `NCDC reports page returned HTTP ${response.status}.` };
    }
    const html = await response.text();
    return { error: false, html };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: true, reason: 'Request to NCDC reports page timed out.' };
    }
    return { error: true, reason: `Could not reach NCDC reports page: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// ---- parse (pure — no I/O) -----------------------------------------------

/**
 * Extracts title/year/epiWeek/publishedDate/reportUrl from the reports
 * page HTML. Returns a structured error (never throws) if the page is
 * empty, malformed, or its structure doesn't match what this parser knows.
 */
function parseLatestReportMetadata(html) {
  if (!html || typeof html !== 'string' || html.length < 200) {
    return { error: true, reason: 'Invalid or empty HTML received from NCDC reports page.' };
  }

  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const headerMatch = html.match(/<h2>\s*([A-Za-z]+)\s+(\d{4})\s*<span class="pull-right">\s*Week\s+(\d+)\s*<\/span>\s*<\/h2>/i);
  const postedMatch = html.match(/Posted:\s*(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  const pdfMatch = html.match(/href="([^"]+\.pdf)"[^>]*download=/i);

  if (!headerMatch) {
    return { error: true, reason: 'No reports found — could not locate the report week/year header. The page structure may have changed.' };
  }
  if (!postedMatch) {
    return { error: true, reason: 'Could not locate the report published date. The page structure may have changed.' };
  }

  const title = titleMatch ? titleMatch[1].trim() : 'Weekly Epidemiological Report';
  const year = parseInt(headerMatch[2], 10);
  const epiWeek = parseInt(headerMatch[3], 10);

  const [, day, month, postedYear, hourStr, minute, second, ampm] = postedMatch;
  let hour = parseInt(hourStr, 10);
  if (/pm/i.test(ampm) && hour < 12) hour += 12;
  if (/am/i.test(ampm) && hour === 12) hour = 0;
  const publishedDate = new Date(
    parseInt(postedYear, 10), parseInt(month, 10) - 1, parseInt(day, 10),
    hour, parseInt(minute, 10), parseInt(second, 10)
  );

  if (Number.isNaN(publishedDate.getTime()) || Number.isNaN(year) || Number.isNaN(epiWeek)) {
    return { error: true, reason: 'Report metadata was found but could not be parsed into valid values.' };
  }

  let reportUrl = null;
  if (pdfMatch) {
    const href = pdfMatch[1];
    reportUrl = href.startsWith('http') ? href : `${NCDC_CONFIG.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
  }

  return { error: false, year, epiWeek, title, publishedDate, reportUrl };
}

// ---- local tracking (JSON file, same pattern as pharmacyProfile.js) -----

function loadLastProcessed() {
  try {
    if (fs.existsSync(TRACKING_PATH)) {
      return JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
    }
  } catch (_) { /* corrupt file — treat as no record */ }
  return null;
}

/**
 * Records a report as processed. Discovery itself never calls this — it
 * only compares against whatever's already on record. A later phase (once
 * it has actually downloaded/parsed a report) is what should call this.
 */
function markReportProcessed(metadata) {
  try {
    fs.writeFileSync(TRACKING_PATH, JSON.stringify({
      year: metadata.year,
      epiWeek: metadata.epiWeek,
      publishedDate: metadata.publishedDate instanceof Date ? metadata.publishedDate.toISOString() : metadata.publishedDate,
      reportUrl: metadata.reportUrl,
    }, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function isNewerReport(latest, stored) {
  if (!stored) return true;
  if (latest.year !== stored.year) return latest.year > stored.year;
  return latest.epiWeek > stored.epiWeek;
}

// ---- public API -----------------------------------------------------------

/**
 * Discover the latest NCDC Weekly Epidemiological Report and determine
 * whether it's newer than the last processed one on record. Read-only —
 * does not mark anything as processed (see markReportProcessed above).
 *
 * @returns {Promise<import('./ncdcTypes').NCDCReportMetadata | {error: true, reason: string}>}
 */
async function discoverLatestReport() {
  console.log('[ncdc] Discovery started');

  const fetchResult = await fetchReportsPageHtml();
  if (fetchResult.error) {
    console.warn('[ncdc] Discovery failed:', fetchResult.reason);
    return { error: true, reason: fetchResult.reason };
  }

  const parsed = parseLatestReportMetadata(fetchResult.html);
  if (parsed.error) {
    console.warn('[ncdc] Discovery failed:', parsed.reason);
    return { error: true, reason: parsed.reason };
  }

  console.log(`[ncdc] Latest report found: Year ${parsed.year}, Epi-Week ${parsed.epiWeek}`);

  const stored = loadLastProcessed();
  const isNew = isNewerReport(parsed, stored);
  console.log(isNew ? '[ncdc] New report detected' : '[ncdc] No new report available');

  return {
    error: false,
    year: parsed.year,
    epiWeek: parsed.epiWeek,
    title: parsed.title,
    publishedDate: parsed.publishedDate,
    reportUrl: parsed.reportUrl,
    isNew,
  };
}

module.exports = {
  discoverLatestReport,
  markReportProcessed,
  loadLastProcessed,
  // exported for direct unit testing without a live network call
  parseLatestReportMetadata,
};
