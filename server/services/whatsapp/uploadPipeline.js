/**
 * Runs a WhatsApp-uploaded workbook through the exact same steps
 * POST /api/confirm-mapping runs with no userMapping — fully automated,
 * no clarifying questions, matching the plan's "no new mapping-confidence
 * logic needed" conclusion. Trimmed to what a short WhatsApp reply and a
 * one-page PDF actually need — it skips building the multi-dashboard widget
 * manifest, which only the web dashboard renders, but still performs both
 * persistence steps (star schema AND fact store), because the AI Advisor
 * answers from those regardless of which channel the file arrived on.
 */

const { normalizeFromSheets } = require('../normalizer');
const datasetRegistry = require('../datasetRegistry');
const factStore = require('../factStore');
const { classifyDataset } = require('../datasetClassifier');
const { loadFactRecords, queryAnalytics } = require('../db');
const { computeAllMetrics } = require('../metrics');
const { computeHealthStats } = require('../businessHealthData');
const { scoreBusinessHealth } = require('../businessHealth');
const { generateInsights } = require('../recommendations');

/**
 * @param {string} organizationId
 * @param {Buffer} fileBuffer
 * @returns {Promise<{
 *   rowCount: number, skippedCount: number, analytics: object, metrics: object,
 *   bizHealth: object, bizInsights: object
 * }>}
 */
function readWorkbook(fileBuffer) {
  const xlsx = require('xlsx');
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const sheets = {};
  workbook.SheetNames.forEach((name) => {
    sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
  });
  return { workbook, sheets };
}

/**
 * @param {object} [options]
 * @param {Record<string, string>} [options.userMapping] rawHeader -> category.
 *   Carries two things the detector cannot work out on its own: columns this
 *   pharmacy has already told us the meaning of, and the answer to whatever
 *   clarifying question was asked about this file. Same override channel the
 *   web mapping screen uses, so both channels resolve a column the same way.
 */
async function processUpload(organizationId, fileBuffer, filename = 'whatsapp-upload.xlsx', options = {}) {
  const { userMapping, parsed } = options;
  // The caller inspects the sheets before deciding whether to ask a question,
  // so it can hand the parse back rather than making us redo it — parsing a
  // large workbook twice is pure waste on the slowest part of the upload.
  const { workbook, sheets } = parsed || readWorkbook(fileBuffer);

  const result = await normalizeFromSheets(sheets, { organizationId, userMapping });
  if (result.normalized.length === 0) {
    throw new Error('The file contains no processable data rows.');
  }

  const records = result.validRecords || result.normalized;

  // Register the dataset even though WhatsApp shows no registry UI — its id
  // is what makes re-loading idempotent. register() keys on a fingerprint of
  // the file contents, so sending the SAME file twice returns the SAME id and
  // loadFactRecords replaces that dataset's rows instead of appending a
  // duplicate copy. Without it every re-send silently doubled the pharmacy's
  // totals.
  const entry = await datasetRegistry.register(organizationId, {
    buffer: fileBuffer,
    filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  await loadFactRecords(organizationId, records, { datasetId: entry?.datasetId || null });

  // Also write into the fact store, mirroring what POST /api/confirm-mapping
  // does for web uploads. loadFactRecords alone only populates the star schema
  // (sale/product), which serves revenue questions — every widget-derived
  // answer (stock levels, suppliers, expiry) reads the fact store instead.
  // Without this a pharmacy could WhatsApp a full inventory file, get a
  // successful summary back, and then be told "no stock data has been
  // uploaded" when they asked about it, because none of those rows were ever
  // queryable.
  //
  // Capability is decided the same way the web path decides it — via
  // classifyDataset() on the raw sheet rows — NOT via entry.capabilities,
  // which register() always inserts as null; the web path only fills it in
  // later, from a separate /api/classify-dataset call this pipeline never
  // makes. Reading entry.capabilities here silently produced factTable:null
  // for every WhatsApp upload, inventory included, until this was traced.
  const primarySheetRows = sheets[workbook.SheetNames[0]] || [];
  const classification = classifyDataset(primarySheetRows);
  if (!entry?.isDuplicate && entry?.datasetId) {
    await datasetRegistry.update(organizationId, entry.datasetId, {
      processingStatus: 'classified',
      capabilities: classification.capabilities,
      recommended_dashboards: classification.recommended_dashboards,
      rowCount: primarySheetRows.length,
      sheetNames: workbook.SheetNames,
      assetType: classification.primary_type,
    });
  }

  // Same one-row-per-record rule as the web path: filed under its primary
  // capability, since queryAll ignores table_name and the widget engine
  // discovers what it can compute from the fields present.
  const caps = classification.capabilities;
  const hasStockSideData = !!(caps?.inventory || caps?.expiry || caps?.supplier);
  const factTable = caps?.sales ? 'FactSales' : (hasStockSideData ? 'FactInventory' : null);
  if (factTable) {
    const inserted = await factStore.append(organizationId, factTable, records, entry?.datasetId || null);
    if (inserted > 0) console.log(`[whatsapp] factStore +${inserted} ${factTable} records`);
  }

  const analytics = await queryAnalytics(organizationId);

  const metrics = computeAllMetrics(records, {
    productNormalizationStats: result.productNormalizationStats,
    cleaningReportSummary: result.cleaningReport ? result.cleaningReport.summary : null,
    qualityReport: result.qualityReport,
    cleaningStats: result.cleaningStats,
  });

  const { inventoryStats, customerStats } = await computeHealthStats(organizationId);
  const bizHealthOpts = { records };
  if (inventoryStats) bizHealthOpts.inventoryStats = inventoryStats;
  if (customerStats) bizHealthOpts.customerStats = customerStats;

  const bizHealth = scoreBusinessHealth(metrics, bizHealthOpts);
  const bizInsights = generateInsights(bizHealth, metrics, bizHealthOpts);

  return {
    rowCount: result.normalized.length,
    skippedCount: result.normalized.length - records.length,
    analytics,
    metrics,
    bizHealth,
    bizInsights,
  };
}

module.exports = { processUpload, readWorkbook };
