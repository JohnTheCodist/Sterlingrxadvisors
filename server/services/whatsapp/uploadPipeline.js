/**
 * Runs a WhatsApp-uploaded workbook through the exact same steps
 * POST /api/confirm-mapping runs with no userMapping — fully automated,
 * no clarifying questions, matching the plan's "no new mapping-confidence
 * logic needed" conclusion. Trimmed to what a short WhatsApp reply and a
 * one-page PDF actually need (skips dataset-registry bookkeeping and the
 * multi-dashboard widget manifest, which only the web dashboard uses).
 */

const { normalizeFromSheets } = require('../normalizer');
const datasetRegistry = require('../datasetRegistry');
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
async function processUpload(organizationId, fileBuffer, filename = 'whatsapp-upload.xlsx') {
  const xlsx = require('xlsx');
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const sheets = {};
  workbook.SheetNames.forEach((name) => {
    sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
  });

  const result = await normalizeFromSheets(sheets, { organizationId });
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

module.exports = { processUpload };
