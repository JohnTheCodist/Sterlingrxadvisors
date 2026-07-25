/**
 * Reproduction test for the multi-file upload "Analyze hangs on second file" bug.
 *
 * Simulates the server-side processing of two files sequentially through the
 * same path that /api/confirm-mapping takes.
 *
 * Run:  node tests/multi-file-repro.test.js
 */

const path = require('path');
const xlsx = require('xlsx');

const { normalizeFromSheets } = require('../services/normalizer');
const { loadFactRecords, queryAnalytics, closeDb } = require('../services/database');
const { computeAllMetrics } = require('../services/metrics');
const { scoreBusinessHealth } = require('../services/businessHealth');
const { generateInsights } = require('../services/recommendations');
const { computeHealthStats } = require('../services/businessHealthData');
const { evaluate: evaluateWidgets } = require('../services/widgetEngine');
const factStore = require('../services/factStore');
const datasetRegistry = require('../services/datasetRegistry');

// ---- test runner --------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.stack || e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Value mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- helper: simulate one file's confirm-mapping flow ----------------

function processFile(sheets, userMapping, label) {
  console.log(`\n--- Processing ${label} ---`);

  // Step 1: Normalize
  console.log(`  [${label}] Starting normalizeFromSheets...`);
  const result = normalizeFromSheets(sheets, { pharmacyId: 'test', userMapping });
  console.log(`  [${label}] Normalized: ${result.normalized.length} records`);
  if (result.normalized.length === 0) {
    console.log(`  [${label}] WARNING: No normalized records produced.`);
    return null;
  }

  // Step 2: Load fact records
  console.log(`  [${label}] Loading fact records...`);
  const inserted = loadFactRecords(result.normalized);
  console.log(`  [${label}] Inserted: ${inserted} fact records`);

  // Step 3: Query analytics
  console.log(`  [${label}] Querying analytics...`);
  const analyticsResult = queryAnalytics();
  console.log(`  [${label}] Revenue: ${analyticsResult.metrics.totalRevenue}`);

  // Step 4: Compute metrics
  console.log(`  [${label}] Computing metrics...`);
  const metrics = computeAllMetrics(result.validRecords || result.normalized, {
    productNormalizationStats: result.productNormalizationStats,
  });
  console.log(`  [${label}] Metrics computed OK`);

  // Step 5: Business health
  console.log(`  [${label}] Computing business health...`);
  const { inventoryStats, customerStats } = computeHealthStats();
  const bizHealthOpts = {};
  if (inventoryStats) bizHealthOpts.inventoryStats = inventoryStats;
  if (customerStats) bizHealthOpts.customerStats = customerStats;
  bizHealthOpts.records = result.validRecords || result.normalized;
  const bizHealth = scoreBusinessHealth(metrics, bizHealthOpts);
  const bizInsights = generateInsights(bizHealth, metrics, bizHealthOpts);
  console.log(`  [${label}] Business health score: ${bizHealth.overall}`);

  // Step 6: Widget manifest
  console.log(`  [${label}] Evaluating widgets...`);
  const widgetManifest = evaluateWidgets(result.validRecords || result.normalized);
  console.log(`  [${label}] Widgets available: ${widgetManifest.summary.availableWidgets}`);

  // Step 7: Fact store
  console.log(`  [${label}] Writing to fact store...`);
  const records = result.validRecords || result.normalized;
  const id = label;
  const insertedSales = factStore.append('FactSales', records, id);
  console.log(`  [${label}] FactStore: +${insertedSales} FactSales`);

  console.log(`  [${label}] DONE`);
  return { analyticsResult, metrics, widgetManifest };
}

// ---- test: two files with completely different headers -----------------

console.log('=== Multi-File Sequential Processing ===\n');

// File 1: Pharmacy sales export — one header style
const sheets1 = {
  'SalesData': [
    { 'Drug Name': 'Paracetamol 500mg', 'Qty Sold': '2', 'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-01-15', 'Payment': 'Cash' },
    { 'Drug Name': 'Ibuprofen 400mg',   'Qty Sold': '1', 'Selling Price': '₦500', 'Cost Price': '₦300', 'Sale Date': '2024-01-16', 'Payment': 'POS' },
    { 'Drug Name': 'Amoxicillin 500mg', 'Qty Sold': '3', 'Selling Price': '₦150', 'Cost Price': '₦90',  'Sale Date': '2024-02-01', 'Payment': 'Transfer' },
    { 'Drug Name': 'Paracetamol 500mg', 'Qty Sold': '1', 'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-02-15', 'Payment': 'Cash' },
  ],
};

// File 2: Different header naming convention (typical of multi-file scenarios)
const sheets2 = {
  'Sheet1': [
    { 'Product': 'Coartem 80/480',   'Quantity': '2', 'Revenue': '2400',  'Purchase Cost': '1200', 'TransactionDate': '2024-03-01', 'PayMethod': 'Cash' },
    { 'Product': 'Vitamin C 1000mg', 'Quantity': '5', 'Revenue': '1500',  'Purchase Cost': '500',  'TransactionDate': '2024-03-02', 'PayMethod': 'POS' },
    { 'Product': 'Coartem 80/480',   'Quantity': '3', 'Revenue': '3600',  'Purchase Cost': '1800', 'TransactionDate': '2024-03-15', 'PayMethod': 'Transfer' },
  ],
};

// File 1 mapping
const mapping1 = {
  'Drug Name': 'product_name',
  'Qty Sold': 'quantity',
  'Selling Price': 'selling_price',
  'Cost Price': 'cost_price',
  'Sale Date': 'transaction_date',
  'Payment': 'payment_method',
};

// File 2 mapping
const mapping2 = {
  'Product': 'product_name',
  'Quantity': 'quantity',
  'Revenue': 'revenue',
  'Purchase Cost': 'cost_price',
  'TransactionDate': 'transaction_date',
  'PayMethod': 'payment_method',
};

// Clear any stale data before test
console.log('Clearing databases...');
try { factStore.clear(); } catch (_) {}
try { datasetRegistry._clear(); } catch (_) {}
try {
  const db = require('../services/database').getDb();
  db.prepare('DELETE FROM fact_sales').run();
  db.prepare('DELETE FROM dim_product').run();
  db.prepare('DELETE FROM dim_calendar').run();
  console.log('  SQLite cleared.');
} catch (e) { console.log('  SQLite clear skipped:', e.message); }

// ---- Test 1: Process file 1 -------------------------------------------------
console.log('\n>>> TEST: File 1 should complete successfully');
test('file 1 processes without error', () => {
  const result = processFile(sheets1, mapping1, 'file1');
  assert(result !== null, 'file 1 should produce a result');
  assert(result.analyticsResult.metrics.totalRevenue > 0, 'file 1 should have revenue');
});

// ---- Test 2: Process file 2 (should NOT hang/break) -------------------------
console.log('\n>>> TEST: File 2 should also complete successfully (the bug)');
test('file 2 processes without error', () => {
  const result = processFile(sheets2, mapping2, 'file2');
  assert(result !== null, 'file 2 should produce a result');
  assert(result.analyticsResult.metrics.totalRevenue > 0, 'file 2 should have revenue');
});

// ---- Test 3: File 2's data should be file 2's, not file 1's leftovers -----
console.log('\n>>> TEST: File 2 analytics should reflect file 2 data, not file 1');
test('file 2 analytics show file 2 products', () => {
  const analyticsResult = queryAnalytics();
  const topProducts = analyticsResult.topProducts.map(p => p.name);
  // File 2 products should be present
  const hasFile2Product = topProducts.some(p => p.toLowerCase().includes('coartem') || p.toLowerCase().includes('vitamin'));
  assert(hasFile2Product, `Top products should include file 2 products, got: ${JSON.stringify(topProducts)}`);
});

// ---- Test 4: widgetEngine works on both datasets independently ----------
console.log('\n>>> TEST: Widget engine works for file 2\'s records');
test('widget engine evaluates file 2 data independently', () => {
  const result2 = normalizeFromSheets(sheets2, { pharmacyId: 'test', userMapping: mapping2 });
  const manifest = evaluateWidgets(result2.validRecords || result2.normalized);
  assert(manifest.summary.availableWidgets > 0, 'Should have available widgets for file 2');
});

// ---- Test 5: columnMapper mappingStore key collision ---------------------
console.log('\n>>> TEST: columnMapper does not leak state between calls');
test('mappingStore keys are file-specific', () => {
  const { saveMapping, loadMapping } = require('../services/columnMapper');
  const headers1 = ['Drug Name', 'Qty Sold', 'Selling Price', 'Cost Price', 'Sale Date', 'Payment'];
  const headers2 = ['Product', 'Quantity', 'Revenue', 'Purchase Cost', 'TransactionDate', 'PayMethod'];

  saveMapping('test', headers1, mapping1);
  saveMapping('test', headers2, mapping2);

  const loaded1 = loadMapping('test', headers1);
  const loaded2 = loadMapping('test', headers2);

  assert(loaded1 !== null, 'should load mapping for file 1');
  assert(loaded2 !== null, 'should load mapping for file 2');

  // Verify different keys
  assertEquals(loaded1['Drug Name'], 'product_name', 'file 1 mapping should persist');
  assertEquals(loaded2['Product'], 'product_name', 'file 2 mapping should persist');

  // Verify no collision
  assert(loaded2['Drug Name'] === undefined, 'file 2 should NOT have file 1 headers');
  assert(loaded1['Product'] === undefined, 'file 1 should NOT have file 2 headers');
});

// ---- summary -----------------------------------------------------------

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'='.repeat(50)}\n`);

// Cleanup
try { closeDb(); } catch (_) {}

process.exit(failed > 0 ? 1 : 0);
