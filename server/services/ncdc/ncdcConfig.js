/**
 * NCDC module — configuration. All URLs and storage paths live here;
 * business logic reads from this file only, never hardcodes them itself.
 */

const path = require('path');

const NCDC_CONFIG = {
  baseUrl: 'https://ncdc.gov.ng',
  reportsPage: 'https://ncdc.gov.ng/reports/weekly',
  requestTimeoutMs: 15000,
  // PDFs are larger and slower than the HTML page fetch, so downloads get
  // their own, longer timeout.
  downloadTimeoutMs: 60000,
  // server/storage/ncdc/{year}/week{epiWeek}.pdf — kept inside server/,
  // same convention as server/data/ and server/mappings/.
  storageDir: path.join(__dirname, '..', '..', 'storage', 'ncdc'),
};

module.exports = { NCDC_CONFIG };
