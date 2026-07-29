/**
 * NCDC PDF Parser.
 *
 * Single responsibility: open a downloaded report PDF and convert it into
 * a neutral ParsedNCDCReport (see ncdcTypes.js) — page text, structural
 * sections, and best-effort tables. It does NOT interpret disease trends,
 * calculate demand, generate recommendations, or touch Weather / Calendar
 * / the Decision Engine. Extraction only — it does not decide what's
 * important, it exposes what it finds.
 *
 * markReportProcessed() (from reportDiscovery.js) is called ONLY after
 * every page in the document has been successfully extracted. If parsing
 * fails on any page, nothing is marked processed, so a retry is possible.
 *
 * pdfjs-dist's Node ("legacy") build expects a couple of browser globals
 * that don't exist in plain Node — polyfilled minimally below rather than
 * pulling in a native canvas dependency, since this module only needs text
 * positions, never rendering.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { markReportProcessed } = require('./reportDiscovery');

if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
    multiplySelf() { return this; }
    translateSelf() { return this; }
    scaleSelf() { return this; }
  };
}

let pdfjsLibPromise = null;
function getPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(
        require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      ).href;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

// ---- structural (non-semantic) helpers -------------------------------

/**
 * Groups a page's positioned text items into visual rows (by y-proximity)
 * and, within each row, left-to-right cells. Purely geometric — it does
 * not know or care what the text means.
 */
function groupIntoRows(items) {
  const Y_TOLERANCE = 3;
  const rows = [];
  for (const item of items) {
    const y = item.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  rows.sort((a, b) => b.y - a.y); // top of page first
  rows.forEach((r) => r.items.sort((a, b) => a.transform[4] - b.transform[4]));
  return rows;
}

/**
 * Best-effort table detection: a page "looks tabular" where several
 * consecutive rows each have 3+ distinct text items (i.e. real column
 * separation, not just wrapped prose). Rows that don't meet that bar are
 * left out — this is deliberately conservative rather than guessing.
 */
function detectTable(rows) {
  const tabularRows = rows.filter((r) => r.items.length >= 3);
  if (tabularRows.length < 3) return null;
  const cellRows = tabularRows.map((r) => r.items.map((i) => i.str.trim()).filter(Boolean));
  return cellRows.filter((r) => r.length >= 3);
}

/**
 * Structural heading guess: the text in the row with the largest font
 * size on the page (transform[0] is the horizontal scale, a reasonable
 * proxy for font size). A typographic signal, not a semantic one.
 */
function guessHeading(rows) {
  let best = null;
  for (const row of rows) {
    for (const item of row.items) {
      const size = Math.abs(item.transform[0]);
      if (item.str.trim() && (!best || size > best.size)) {
        best = { size, text: item.str.trim() };
      }
    }
  }
  return best ? best.text : null;
}

// ---- main entry point ---------------------------------------------------

/**
 * @param {import('./ncdcTypes').NCDCReportMetadata & {localPath: string}} reportMetadata
 * @returns {Promise<{success:true, metadata:Object, pages:number, sections:Array, tables:Array, parsedAt:Date} | {success:false, reason:string}>}
 */
async function parseReport(reportMetadata) {
  if (!reportMetadata || typeof reportMetadata !== 'object' || !reportMetadata.localPath) {
    return { success: false, reason: 'No local PDF path provided.' };
  }

  const { localPath, year, epiWeek, title, publishedDate, reportUrl } = reportMetadata;

  if (!fs.existsSync(localPath)) {
    console.warn('[ncdc-parser] Parsing failed: file not found at', localPath);
    return { success: false, reason: `PDF file not found at ${localPath}.` };
  }

  console.log('[ncdc-parser] Parsing started');

  let buffer;
  try {
    buffer = fs.readFileSync(localPath);
  } catch (err) {
    console.warn('[ncdc-parser] Parsing failed:', err.message);
    return { success: false, reason: `Could not read PDF file: ${err.message}` };
  }

  if (buffer.length === 0) {
    console.warn('[ncdc-parser] Parsing failed: empty PDF file.');
    return { success: false, reason: 'PDF file is empty.' };
  }

  let pdfjsLib;
  let doc;
  try {
    pdfjsLib = await getPdfjsLib();
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  } catch (err) {
    const name = err && err.name;
    if (name === 'PasswordException') {
      console.warn('[ncdc-parser] Parsing failed: password-protected PDF.');
      return { success: false, reason: 'PDF is password-protected.' };
    }
    if (name === 'InvalidPDFException') {
      console.warn('[ncdc-parser] Parsing failed: corrupt or invalid PDF.');
      return { success: false, reason: 'PDF is corrupt or not a valid PDF file.' };
    }
    console.warn('[ncdc-parser] Parsing failed:', err.message);
    return { success: false, reason: `Could not open PDF: ${err.message}` };
  }

  console.log('[ncdc-parser] PDF opened');

  if (!doc.numPages || doc.numPages === 0) {
    console.warn('[ncdc-parser] Parsing failed: PDF has no pages.');
    return { success: false, reason: 'PDF has no pages.' };
  }

  const sections = [];
  const tables = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    let rows;
    let pageText;
    try {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pageText = content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      rows = groupIntoRows(content.items);
    } catch (err) {
      console.warn(`[ncdc-parser] Parsing failed: text extraction failed on page ${pageNumber}: ${err.message}`);
      return { success: false, reason: `Text extraction failed on page ${pageNumber}: ${err.message}` };
    }

    sections.push({ pageNumber, heading: guessHeading(rows), text: pageText });

    try {
      const tableRows = detectTable(rows);
      if (tableRows) tables.push({ pageNumber, rows: tableRows });
    } catch (err) {
      console.warn(`[ncdc-parser] Parsing failed: table extraction failed on page ${pageNumber}: ${err.message}`);
      return { success: false, reason: `Table extraction failed on page ${pageNumber}: ${err.message}` };
    }
  }

  console.log('[ncdc-parser] Text extracted');
  console.log('[ncdc-parser] Tables extracted');

  const parsedAt = new Date();

  // Only mark the report processed once every page has been successfully
  // extracted — a partial failure above already returned early, so
  // reaching here means the whole document succeeded.
  markReportProcessed({ year, epiWeek, publishedDate, reportUrl });

  console.log('[ncdc-parser] Parsing completed');

  return {
    success: true,
    metadata: { year, epiWeek, title, publishedDate, reportUrl, localPath },
    pages: doc.numPages,
    sections,
    tables,
    parsedAt,
  };
}

module.exports = { parseReport };
