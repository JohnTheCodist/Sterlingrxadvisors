/**
 * Automated tests for the RxNaija Analytics cleaning pipeline.
 *
 * Run:  node tests/pipeline.test.js
 *
 * Covers: invalid dates, missing quantities, duplicate rows, duplicate columns,
 *        currency parsing, whitespace trimming, product normalization,
 *        payment method normalization.
 */

const path = require('path');

// Import all modules under test
const { normalize, normalizeFromSheets } = require('../services/normalizer');
const { analyze } = require('../services/analytics');
const { validate } = require('../services/validator');
const { cleanData, parseCurrency, serialToDate, parseDateString, parseYYYYMMDD, normalizePaymentMethod, deduplicateTransactions, fillMissingValues } = require('../services/dataCleaner');
const { normalizeProductText, normalizeProductName, identifyDrug } = require('../services/productNormalizer');
const { normalizeHeader } = require('../services/schemaDetector');
const { joinSheets } = require('../services/sheetJoiner');
const { DICTIONARY } = require('../services/dictionary');
const { parseDrugName } = require('../services/productParser');

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
    console.log(`        ${e.message}`);
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

function assertDeepEquals(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg || 'Object mismatch'}: expected ${b}, got ${a}`);
  }
}

// ---- tests --------------------------------------------------------------

console.log('\n=== Currency Parsing ===');
test('strips naira symbol and commas', () => {
  assertEquals(parseCurrency('₦1,500'), 1500);
});
test('handles plain number string', () => {
  assertEquals(parseCurrency('1200'), 1200);
});
test('handles number type', () => {
  assertEquals(parseCurrency(3500), 3500);
});
test('handles negative values', () => {
  assertEquals(parseCurrency('-100'), -100);
});
test('returns null for empty string', () => {
  assertEquals(parseCurrency(''), null);
});
test('returns null for null', () => {
  assertEquals(parseCurrency(null), null);
});
test('handles dollar sign', () => {
  assertEquals(parseCurrency('$500'), 500);
});

console.log('\n=== Date Parsing ===');
test('recognizes YYYY-MM-DD', () => {
  assertEquals(parseDateString('2026-07-15'), '2026-07-15');
});
test('recognizes DD/MM/YYYY', () => {
  assertEquals(parseDateString('15/01/2026'), '2026-01-15');
});
test('recognizes YYYY-MM', () => {
  assertEquals(parseDateString('2026-07'), '2026-07-01');
});
test('converts Excel serial date', () => {
  // Excel serial 45801 → mid-2025 (exact date depends on Excel's leap-year handling)
  const result = serialToDate(45801);
  assert(result.startsWith('2025-05'), `Expected May 2025, got ${result}`);
});
test('returns null for invalid date string', () => {
  assertEquals(parseDateString('not-a-date'), null);
});
test('returns null for empty', () => {
  assertEquals(parseDateString(''), null);
});

console.log('\n=== YYYYMMDD Date Parsing ===');
test('parses 20240101 as date', () => {
  assertEquals(parseYYYYMMDD(20240101), '2024-01-01');
});
test('parses 20261231 as date', () => {
  assertEquals(parseYYYYMMDD(20261231), '2026-12-31');
});
test('rejects non-8-digit number', () => {
  assertEquals(parseYYYYMMDD(202401), null);
});
test('rejects invalid month', () => {
  assertEquals(parseYYYYMMDD(20241301), null);
});
test('rejects year before 1900', () => {
  assertEquals(parseYYYYMMDD(18990101), null);
});
test('rejects float', () => {
  assertEquals(parseYYYYMMDD(20240101.5), null);
});

console.log('\n=== Enterprise Date Parsing — Multiple Separators ===');
// Slash
test('DD/MM/YYYY with slashes', () => assertEquals(parseDateString('20/05/2024'), '2024-05-20'));
// Dash
test('DD-MM-YYYY with dashes', () => assertEquals(parseDateString('20-05-2024'), '2024-05-20'));
// Dot
test('DD.MM.YYYY with dots', () => assertEquals(parseDateString('20.05.2024'), '2024-05-20'));
// Space
test('DD MM YYYY with spaces', () => assertEquals(parseDateString('20 05 2024'), '2024-05-20'));
// Backslash
test('DD\\MM\\YYYY with backslash', () => assertEquals(parseDateString('20\\05\\2024'), '2024-05-20'));
// Underscore
test('YYYY_MM_DD with underscore', () => assertEquals(parseDateString('2024_05_20'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — YMD Formats ===');
test('YYYY/MM/DD with slashes', () => assertEquals(parseDateString('2024/05/20'), '2024-05-20'));
test('YYYY-MM-DD ISO', () => assertEquals(parseDateString('2024-05-20'), '2024-05-20'));
test('YYYY.MM.DD with dots', () => assertEquals(parseDateString('2024.05.20'), '2024-05-20'));
test('YYYY MM DD with spaces', () => assertEquals(parseDateString('2024 05 20'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — US Format (MM/DD/YYYY) ===');
test('MM/DD/YYYY — auto-detected (month > 12 impossible as day)', () => assertEquals(parseDateString('05/20/2024'), '2024-05-20'));
test('MM-DD-YYYY with dashes', () => assertEquals(parseDateString('05-20-2024'), '2024-05-20'));
test('MM.DD.YYYY with dots', () => assertEquals(parseDateString('05.20.2024'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — Month Names ===');
test('DD Mon YYYY', () => assertEquals(parseDateString('20 May 2024'), '2024-05-20'));
test('DD MON YYYY (uppercase)', () => assertEquals(parseDateString('20 MAY 2024'), '2024-05-20'));
test('DD-Mon-YYYY with dashes', () => assertEquals(parseDateString('20-May-2024'), '2024-05-20'));
test('Mon DD, YYYY', () => assertEquals(parseDateString('May 20, 2024'), '2024-05-20'));
test('Mon DD YYYY (no comma)', () => assertEquals(parseDateString('May 20 2024'), '2024-05-20'));
test('Mon-DD-YYYY with dashes', () => assertEquals(parseDateString('May-20-2024'), '2024-05-20'));
test('Full month name', () => assertEquals(parseDateString('20 January 2024'), '2024-01-20'));
test('Abbreviated month name', () => assertEquals(parseDateString('20 Jan 2024'), '2024-01-20'));
test('Sept abbreviation', () => assertEquals(parseDateString('20 Sept 2024'), '2024-09-20'));
test('February full name', () => assertEquals(parseDateString('February 20 2024'), '2024-02-20'));

console.log('\n=== Enterprise Date Parsing — Compact Formats ===');
test('YYYYMMDD as string', () => assertEquals(parseDateString('20240520'), '2024-05-20'));
test('DDMMYYYY as string', () => assertEquals(parseDateString('20052024'), '2024-05-20'));
test('DDMMYY (6-digit compact)', () => assertEquals(parseDateString('240520'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — Ordinal Dates ===');
test('20th May 2024', () => assertEquals(parseDateString('20th May 2024'), '2024-05-20'));
test('1st January 2025', () => assertEquals(parseDateString('1st January 2025'), '2025-01-01'));
test('2nd Feb 2023', () => assertEquals(parseDateString('2nd Feb 2023'), '2023-02-02'));
test('3rd Mar 2022', () => assertEquals(parseDateString('3rd Mar 2022'), '2022-03-03'));

console.log('\n=== Enterprise Date Parsing — Date-Time Values ===');
test('ISO datetime with T separator', () => assertEquals(parseDateString('2024-05-20T14:32:21'), '2024-05-20'));
test('ISO datetime with space separator', () => assertEquals(parseDateString('2024-05-20 14:32'), '2024-05-20'));
test('Slash date with time', () => assertEquals(parseDateString('20/05/2024 9:45'), '2024-05-20'));
test('US format with time', () => assertEquals(parseDateString('05-20-2024 22:30'), '2024-05-20'));
test('YMD with time', () => assertEquals(parseDateString('2024/05/20 13:45:30'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — Timezone Formats ===');
test('ISO with Z timezone', () => assertEquals(parseDateString('2024-05-20T15:30:45Z'), '2024-05-20'));
test('ISO with +01:00 timezone', () => assertEquals(parseDateString('2024-05-20T15:30:45+01:00'), '2024-05-20'));
test('ISO with milliseconds and Z', () => assertEquals(parseDateString('2024-05-20T15:30:45.000Z'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — Two-Digit Years ===');
test('DD/MM/YY → 2024', () => assertEquals(parseDateString('20/05/24'), '2024-05-20'));
test('DD-MM-YY with 50+ year → 19xx', () => assertEquals(parseDateString('20-05-99'), '1999-05-20'));
test('MM/DD/YY US format', () => assertEquals(parseDateString('05/20/24'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — Nigerian Priority ===');
test('05/06/2024 → 5 June (not 6 May)', () => assertEquals(parseDateString('05/06/2024'), '2024-06-05'));
test('13/05/2024 — day >12 forces DD/MM', () => assertEquals(parseDateString('13/05/2024'), '2024-05-13'));
test('05/20/2024 — month >12 forces MM/DD→DD/MM', () => assertEquals(parseDateString('05/20/2024'), '2024-05-20'));
test('2024/20/05 — second part >12 forces YYYY/DD/MM', () => assertEquals(parseDateString('2024/20/05'), '2024-05-20'));

console.log('\n=== Enterprise Date Parsing — Invalid Dates ===');
test('32/05/2024 — day impossible', () => assertEquals(parseDateString('32/05/2024'), null));
test('20/15/2024 — month impossible', () => assertEquals(parseDateString('20/15/2024'), null));
test('99/99/9999 — both impossible', () => assertEquals(parseDateString('99/99/9999'), null));
test('abc123 — nonsense', () => assertEquals(parseDateString('abc123'), null));
test('banana — pure text', () => assertEquals(parseDateString('banana'), null));

console.log('\n=== Enterprise Date Parsing — Excel Serial Dates ===');
test('Excel serial 45412 → 2024-04-29', () => {
  const result = serialToDate(45412);
  assertEquals(result, '2024-04-29');
});
test('Excel serial in normalizeDate', () => {
  // normalizeDate should handle Excel serial and return ISO
  const { normalize } = require('../services/normalizer');
  const rows = [{ Product: 'X', Qty: '2', Price: '100', Date: 45412 }];
  const result = normalize(rows);
  assertEquals(result.normalized[0].transaction_date, '2024-04-29');
});

console.log('\n=== Enterprise Date Parsing — Edge Cases ===');
test('empty string returns null', () => assertEquals(parseDateString(''), null));
test('whitespace only returns null', () => assertEquals(parseDateString('   '), null));
test('null returns null', () => assertEquals(parseDateString(null), null));
test('YYYY-MM returns first of month', () => assertEquals(parseDateString('2025-03'), '2025-03-01'));
test('normalizeDate handles null', () => {
  const { normalize } = require('../services/normalizer');
  const rows = [{ Product: 'X', Qty: '2', Price: '100', Date: null }];
  const result = normalize(rows);
  assertEquals(result.normalized[0].transaction_date, null);
});
test('normalizeDate handles empty string', () => {
  const { normalize } = require('../services/normalizer');
  const rows = [{ Product: 'X', Qty: '2', Price: '100', Date: '' }];
  const result = normalize(rows);
  assertEquals(result.normalized[0].transaction_date, null);
});

console.log('\n=== Sheet Joining ===');
test('detects DimProduct sheet', () => {
  const r = joinSheets({
    'Sales': [{ ProductID: 'P1', Qty: 2 }],
    'DimProduct': [{ ProductID: 'P1', ProductName: 'Paracetamol' }],
  });
  assert(r.meta.joined.includes('product'), 'DimProduct should be joined');
});
test('enriches product name from DimProduct', () => {
  const r = joinSheets({
    'Sales': [{ ProductID: 'P1', Qty: 2 }],
    'DimProduct': [{ ProductID: 'P1', ProductName: 'Paracetamol' }],
  });
  assertEquals(r.rows[0]['_productName'], 'Paracetamol');
});
test('handles missing dimension values gracefully', () => {
  const r = joinSheets({
    'Sales': [{ ProductID: 'P99', Qty: 2 }],
    'DimProduct': [{ ProductID: 'P1', ProductName: 'Paracetamol' }],
  });
  assertEquals(r.rows[0]['_productName'] || null, null);
});
test('joins pharmacy dimension', () => {
  const r = joinSheets({
    'Sales': [{ PharmacyID: 'PH1', Revenue: 100 }],
    'DimPharmacy': [{ PharmacyID: 'PH1', PharmacyName: 'Main Branch' }],
  });
  assertEquals(r.rows[0]['_pharmacyName'], 'Main Branch');
});

console.log('\n=== Quantity Parsing ===');
test('converts string to number', () => {
  const r = normalize([{ Product: 'X', Qty: '5', Price: '100' }]);
  assertEquals(r.normalized[0].quantity, 5);
});
test('converts comma-separated number', () => {
  const r = normalize([{ Product: 'X', Qty: '1,200', Price: '100' }]);
  assertEquals(r.normalized[0].quantity, 1200);
});
test('defaults missing quantity to 1 when price exists', () => {
  const r = normalize([{ Product: 'X', Price: '100', Date: '2024-01-15' }]);
  assertEquals(r.normalized[0].quantity, 1);
});
test('fills null quantity with 1', () => {
  const r = normalize([{ Product: 'X', Date: '2024-01-15' }]);
  assertEquals(r.normalized[0].quantity, 1);
});

console.log('\n=== Whitespace Trimming ===');
test('trims product names', () => {
  const r = normalize([{ 'Medicine  ': '  Paracetamol  ', 'Qty': '2', 'Price': '200' }]);
  assert(r.normalized[0].product_name != null);
  assert(r.normalized[0].product_name.toLowerCase().includes('paracetamol'),
    `Got: ${r.normalized[0].product_name}`);
});

console.log('\n=== Product Name Normalization (Phase 4) ===');
test('normalizes 500MG TAB to canonical', () => {
  const result = normalizeProductName('PARACETAMOL 500MG TAB');
  assertEquals(result.recognized, true);
  assertEquals(result.generic, 'Paracetamol');
  assertEquals(result.strength, '500mg');
  assertEquals(result.form, 'Tablet');
  // Business identity = generic only — KB-inferred strength/form are NOT injected
  assertEquals(result.normalized, 'Paracetamol');
  assert(result.confidence >= 0.7);
});
test('normalizes lowercase variant', () => {
  const result = normalizeProductName('paracetamol 500mg');
  assertEquals(result.recognized, true);
  assertEquals(result.generic, 'Paracetamol');
  // Business identity = generic only
  assertEquals(result.normalized, 'Paracetamol');
});
test('normalizes PCM abbreviation', () => {
  const result = normalizeProductName('PCM 500');
  assertEquals(result.recognized, true);
  assertEquals(result.generic, 'Paracetamol');
  assertEquals(result.strength, '500mg');
});
test('normalizes Ampiclox brand', () => {
  const result = normalizeProductName('Ampiclox 500MG CAP');
  assertEquals(result.recognized, true);
  assert(result.generic.includes('Ampicillin'), `Generic: ${result.generic}`);
  // Business identity = brand name (what the pharmacy uploaded)
  assertEquals(result.normalized, 'Ampiclox');
});
test('handles null', () => {
  const result = normalizeProductName(null);
  assertEquals(result.recognized, false);
  assertEquals(result.flag, 'EMPTY');
});
test('handles empty string', () => {
  const result = normalizeProductName('');
  assertEquals(result.recognized, false);
  assertEquals(result.flag, 'EMPTY');
});
test('flags unrecognized drug names', () => {
  // A name that should not match any known pattern
  const result = normalizeProductName('!!@#$ Unknown 12345');
  assertEquals(result.recognized, false, `Should not recognize: ${result.normalized}`);
  assert(result.flag != null, `Flag should exist, got: ${JSON.stringify(result)}`);
});
test('provides canonical ID for known drugs', () => {
  const result = normalizeProductName('Paracetamol 500mg');
  assertEquals(result.recognized, true);
  assert(result.canonicalId != null);
  assert(result.canonicalId.startsWith('DRUG-'));
});

console.log('\n=== Payment Method Normalization ===');
test('normalizes CASH', () => {
  assertEquals(normalizePaymentMethod('CASH'), 'Cash');
});
test('normalizes Cash Payment', () => {
  assertEquals(normalizePaymentMethod('Cash Payment'), 'Cash');
});
test('normalizes TRF', () => {
  assertEquals(normalizePaymentMethod('TRF'), 'Transfer');
});
test('normalizes Bank Transfer', () => {
  assertEquals(normalizePaymentMethod('Bank Transfer'), 'Transfer');
});
test('normalizes POS Terminal', () => {
  assertEquals(normalizePaymentMethod('POS Terminal'), 'POS');
});
test('normalizes Card Payment', () => {
  assertEquals(normalizePaymentMethod('Card Payment'), 'POS');
});
test('normalizes NHIS', () => {
  assertEquals(normalizePaymentMethod('NHIS'), 'Insurance');
});
test('returns null for unrecognized', () => {
  assertEquals(normalizePaymentMethod('XYZ'), null);
});

console.log('\n=== Duplicate Transaction Removal ===');
test('removes exact duplicates', () => {
  const records = [
    { product: 'Paracetamol', quantity: 2, price: 200, transaction_date: '2024-01-15' },
    { product: 'Paracetamol', quantity: 2, price: 200, transaction_date: '2024-01-15' },
    { product: 'Ibuprofen',  quantity: 1, price: 500, transaction_date: '2024-01-16' },
  ];
  const { records: deduped, duplicatesRemoved } = deduplicateTransactions(records);
  assertEquals(deduped.length, 2);
  assertEquals(duplicatesRemoved, 1);
});
test('keeps non-duplicates', () => {
  const records = [
    { product: 'A', quantity: 1, price: 100, transaction_date: '2024-01-01' },
    { product: 'A', quantity: 2, price: 100, transaction_date: '2024-01-01' },
  ];
  const { records: deduped, duplicatesRemoved } = deduplicateTransactions(records);
  assertEquals(deduped.length, 2);
  assertEquals(duplicatesRemoved, 0);
});

console.log('\n=== Duplicate Column Handling ===');
test('removes rows that match column headers', () => {
  const rows = [
    { Drug: 'Paracetamol', Qty: '2', Price: '200' },
    { Drug: 'Drug', Qty: 'Qty', Price: 'Price' },
    { Drug: 'Ibuprofen', Qty: '3', Price: '500' },
  ];
  const headers = ['Drug', 'Qty', 'Price'];
  const { records, stats } = cleanData(rows, headers);
  assertEquals(records.length, 2);
  assertEquals(stats.headersRemoved, 1);
});

console.log('\n=== Missing Value Handling ===');
test('fills null product with Unknown', () => {
  const records = [
    { product: null, quantity: 2, price: 200, transaction_date: '2024-01-01' },
  ];
  const filled = fillMissingValues(records);
  assertEquals(filled[0].product, 'Unknown');
});
test('fills null quantity with 1', () => {
  const records = [
    { product: 'X', quantity: null, price: 200, transaction_date: '2024-01-01' },
  ];
  const filled = fillMissingValues(records);
  assertEquals(filled[0].quantity, 1);
});

console.log('\n=== Empty Row Removal ===');
test('removes completely empty rows', () => {
  const rows = [
    { Drug: 'Paracetamol', Qty: '2', Price: '200' },
    { Drug: null, Qty: null, Price: null },
    { Drug: 'Ibuprofen', Qty: '3', Price: '500' },
  ];
  const { records, stats } = cleanData(rows, ['Drug', 'Qty', 'Price']);
  assertEquals(records.length, 2);
  assertEquals(stats.emptyRemoved, 1);
});

console.log('\n=== Full Pipeline Integration (Phase 3+4) ===');
test('handles complete pharmacy export correctly', () => {
  const rows = [
    { 'Drug Name': 'PARACETAMOL 500MG TAB', 'Qty Sold': '2', 'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-01-15', 'Payment': 'CASH' },
    { 'Drug Name': 'paracetamol 500mg',     'Qty Sold': '1', 'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-01-15', 'Payment': 'Cash Payment' },
    { 'Drug Name': 'PCM 500',               'Qty Sold': '',  'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-01-16', 'Payment': 'TRF' },
    { 'Drug Name': '',                      'Qty Sold': '1', 'Selling Price': '₦500', 'Cost Price': '₦300', 'Sale Date': '2024-01-17', 'Payment': '' },
    // duplicate rows (should be removed)
    { 'Drug Name': 'PARACETAMOL 500MG TAB', 'Qty Sold': '2', 'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-01-15', 'Payment': 'CASH' },
    { 'Drug Name': 'PARACETAMOL 500MG TAB', 'Qty Sold': '2', 'Selling Price': '₦200', 'Cost Price': '₦100', 'Sale Date': '2024-01-15', 'Payment': 'CASH' },
    { 'Drug Name': 'Ampiclox 500mg Capsule','Qty Sold': '5', 'Selling Price': '₦1,500', 'Cost Price': '₦950', 'Sale Date': '2024-01-18', 'Payment': 'POS Terminal' },
  ];

  const result = normalize(rows);
  const a = analyze(result.normalized);

  // 7 input rows, 2 duplicates removed = 5 unique records
  assertEquals(result.normalized.length, 5, 'Normalized row count');
  assertEquals(result.cleaningStats.duplicatesRemoved, 2, 'Duplicates removed');
  assertEquals(a.metrics.recordCount, 5, 'Analytics record count');

  // All paracetamol variants unified to the same business identity
  // (PARACETAMOL, paracetamol, PCM all map to Paracetamol/PCM — same canonical)
  const paracetamolRows = result.normalized.filter(r =>
    r.product_name && (
      r.product_name.toLowerCase().includes('paracetamol') ||
      r.product_name.toLowerCase().includes('pcm')
    )
  );
  assertEquals(paracetamolRows.length, 3, 'Paracetamol variant row count');

  // Payment methods should be normalized
  const paymentMethods = [...new Set(result.normalized.map(r => r.payment_method))].sort();
  assertDeepEquals(paymentMethods.sort(), [null, 'Cash', 'POS', 'Transfer'].sort(),
    'Normalized payment methods');
});

console.log('\n=== Validation Report ===');
test('generates validation report with before/after comparison', () => {
  const rows = [
    { 'Medicine': 'Paracetamol', 'Qty': '2', 'Price': '200', 'Cost': '100' },
    { 'Medicine': 'Paracetamol', 'Qty': '2', 'Price': '200', 'Cost': '100' }, // duplicate
    { 'Medicine': 'Ibuprofen',  'Qty': '3', 'Price': '500', 'Cost': '300' },
  ];
  const result = normalize(rows);
  const a = analyze(result.normalized);
  const report = validate(rows, result, a);

  assertEquals(report.pipelineStages.duplicatesRemoved, 1);
  assert(report.pipelineStages.inputRows >= report.pipelineStages.afterDedup,
    'Rows should decrease after dedup');
  assertEquals(report.pipelineStages.afterDedup, 2);
});

console.log('\n=== Dictionary Integrity ===');
test('all required dictionary categories exist', () => {
  const expected = ['product_name', 'quantity', 'revenue', 'cost_price', 'selling_price', 'transaction_date', 'payment_method'];
  for (const cat of expected) {
    assert(Array.isArray(DICTIONARY[cat]), `${cat} is missing from dictionary`);
    assert(DICTIONARY[cat].length > 0, `${cat} has no synonyms`);
  }
});
test('no duplicate synonyms within a category', () => {
  for (const [cat, synonyms] of Object.entries(DICTIONARY)) {
    const unique = new Set(synonyms);
    assertEquals(unique.size, synonyms.length, `Duplicates in ${cat}`);
  }
});

console.log('\n=== Multi-Sheet Dimension Joining ===');
test('normalizeFromSheets enriches product names', () => {
  const sheets = {
    'Sales': [
      { ProductID: 'P1', Qty: '2', Price: '200', DateKey: 20240115 },
      { ProductID: 'P2', Qty: '1', Price: '500', DateKey: 20240116 },
    ],
    'DimProduct': [
      { ProductID: 'P1', ProductName: 'Paracetamol 500mg' },
      { ProductID: 'P2', ProductName: 'Augmentin 625mg' },
    ],
  };
  const result = normalizeFromSheets(sheets);
  // Phase 4 product normalization may canonicalize names
  assert(result.normalized[0].product_name.includes('Paracetamol'), `Got: ${result.normalized[0].product_name}`);
  assert(result.normalized[1].product_name.includes('Amoxicillin') || result.normalized[1].product_name.includes('Augmentin'),
    `Got: ${result.normalized[1].product_name}`);
});
test('normalizeFromSheets parses YYYYMMDD DateKey', () => {
  const sheets = {
    'Sales': [{ ProductID: 'P1', Qty: '2', Price: '200', DateKey: 20240715 }],
    'DimProduct': [{ ProductID: 'P1', ProductName: 'Paracetamol' }],
  };
  const result = normalizeFromSheets(sheets);
  assertEquals(result.normalized[0].transaction_date, '2024-07-15');
});
test('normalizeFromSheets handles single sheet (no dims)', () => {
  const sheets = {
    'Sheet1': [{ Product: 'X', Qty: '1', Price: '100' }],
  };
  const result = normalizeFromSheets(sheets);
  assertEquals(result.normalized.length, 1);
  assertEquals(result.joinMeta.joined.length, 0);
});

console.log('\n=== Header Normalization ===');
test('strips currency symbols', () => {
  assertEquals(normalizeHeader('Selling Price (₦)'), 'selling price');
});
test('lowercases and collapses whitespace', () => {
  assertEquals(normalizeHeader('  Product  NAME  '), 'product name');
});
test('replaces underscores with spaces', () => {
  assertEquals(normalizeHeader('Qty_Sold'), 'qty sold');
});

// ---- Manufacturer-Aware Resolution Tests -------------------------------

const { resolveIdentity, enrichIdentity, resolveProductIdentities, computeResolutionMethod } = require('../services/productIdentityResolver');

console.log('\n=== Product Identity Resolution ===');

test('Rule 1: direct product_name column is used as-is', () => {
  const r = resolveIdentity({ product_name: 'Paracetamol 500mg', brand: null, generic_name: null, strength: null, dosage_form: null });
  assert(r !== null, 'Should resolve');
  assertEquals(r.rule, 1, 'Should use Rule 1');
  assertEquals(r.product_name, 'Paracetamol 500mg');
});

test('Rule 2: brand + strength + dosage_form compose product name', () => {
  const r = resolveIdentity({ product_name: null, brand: 'Amoxil', generic_name: null, strength: '500mg', dosage_form: 'Capsule' });
  assert(r !== null, 'Should resolve');
  assertEquals(r.rule, 2);
  assert(r.product_name.includes('Amoxil'), `Got: ${r.product_name}`);
  assert(r.product_name.includes('500mg'), `Got: ${r.product_name}`);
});

test('Rule 3: generic_name + strength compose product name', () => {
  const r = resolveIdentity({ product_name: null, brand: null, generic_name: 'Ibuprofen', strength: '400mg', dosage_form: null });
  assert(r !== null, 'Should resolve');
  assertEquals(r.rule, 3);
  assertEquals(r.product_name, 'Ibuprofen 400mg');
});

test('Rule 5: brand only falls back to brand name', () => {
  const r = resolveIdentity({ product_name: null, brand: 'Coartem', generic_name: null, strength: null, dosage_form: null });
  assert(r !== null, 'Should resolve');
  assertEquals(r.rule, 5);
  assertEquals(r.product_name, 'Coartem');
});

test('Rule 7: no identity fields returns null', () => {
  const r = resolveIdentity({ product_name: null, brand: null, generic_name: null, strength: null, dosage_form: null });
  assertEquals(r, null, 'Should return null when nothing to resolve');
});

test('Case 5: product not in NAFDAC keeps original uploaded value', () => {
  const rows = [{ 'Product': 'SuperCure Plus XR-7000', 'Qty': '2', 'Price': '500' }];
  const result = normalize(rows);
  const rec = result.normalized[0];
  assert(rec.canonical_product != null, 'canonical_product should be set');
  assert(rec.canonical_product.includes('SuperCure') || rec.product_name.includes('SuperCure'),
    `Should keep original name, got: ${rec.canonical_product}`);
});

test('canonical_product and display_product fields exist in normalized records', () => {
  const rows = [
    { 'Drug': 'Paracetamol 500mg', 'Qty': '5', 'Price': '200', 'Cost': '100', 'Date': '2024-01-15' },
  ];
  const result = normalize(rows);
  assert(result.normalized.length > 0, 'Should produce normalized records');
  const rec = result.normalized[0];
  assert('canonical_product' in rec, 'canonical_product field should exist');
  assert('display_product' in rec, 'display_product field should exist');
  assert(rec.canonical_product != null, 'canonical_product should not be null');
});

test('canonical_product drives analytics grouping via productOf', () => {
  // Two records with same canonical_product should group together in top products
  const rows = [
    { 'Drug': 'Paracetamol 500mg', 'Qty': '3', 'Price': '200', 'Date': '2024-01-10' },
    { 'Drug': 'Paracetamol 500mg', 'Qty': '2', 'Price': '200', 'Date': '2024-01-11' },
    { 'Drug': 'Ibuprofen 400mg',   'Qty': '1', 'Price': '150', 'Date': '2024-01-12' },
  ];
  const result = normalize(rows);
  const a = analyze(result.normalized);
  // Paracetamol should be top product (qty 5 vs 1)
  assert(a.topProducts && a.topProducts.length > 0, 'Should have top products');
  const top = a.topProducts[0];
  assert(top.name.toLowerCase().includes('paracetamol'), `Top product should be Paracetamol, got: ${top.name}`);
});

test('resolveProductIdentities adds canonical_product to all records', () => {
  const rows = [
    { drug_name: 'Amoxicillin 250mg', qty: '1', price: '300' },
    { drug_name: 'SuperFake 999', qty: '2', price: '100' },
  ];
  const mapping = { product_name: { rawHeader: 'drug_name' } };
  const { records, summary } = resolveProductIdentities(rows, mapping);
  assert(records.length === 2, 'Should process all rows');
  for (const rec of records) {
    assert(rec.canonical_product != null, `canonical_product should be set, got: ${rec.canonical_product}`);
  }
  assert(summary.total === 2, 'Summary total should match');
});

console.log('\n=== Manufacturer-Aware Disambiguation ===');

test('Case 2: manufacturer column disambiguates multi-manufacturer brand', () => {
  // Amlodipine Tablets has 2 manufacturers in NAFDAC:
  //   Skg - Pharma Limited, Jucheck Malt Pharmaceutical Limited
  // Test via resolveProductIdentities to isolate resolution from product normalization
  const rows = [
    { Drug: 'Amlodipine Tablets', strength_col: '10mg', mfr: 'Skg - Pharma Limited', qty: '2', price: '500' },
  ];
  const mapping = {
    product_name: { rawHeader: 'Drug' },
    strength: { rawHeader: 'strength_col' },
    manufacturer: { rawHeader: 'mfr' },
  };
  const { records } = resolveProductIdentities(rows, mapping);
  const rec = records[0];
  // source_product_name and canonical_product should NOT include manufacturer (source is preserved)
  assert(rec.canonical_product != null, 'canonical_product should be set');
  assert(rec.canonical_product.toLowerCase().includes('amlodipine'), `Expected amlodipine in canonical, got: ${rec.canonical_product}`);
  assert(!rec.canonical_product.includes('Skg'), `Source identity should NOT include manufacturer, got: ${rec.canonical_product}`);
  // Resolved manufacturer stored separately
  assert(rec._resolved_manufacturer != null, '_resolved_manufacturer should be set');
  assert(rec._resolved_manufacturer.includes('Skg'), `_resolved_manufacturer should include Skg, got: ${rec._resolved_manufacturer}`);
  // display_product CAN include manufacturer for UI
  assert(rec.display_product.includes('Skg'), `display_product should include manufacturer, got: ${rec.display_product}`);
});

test('Case 3: no manufacturer column falls back to best-guess manufacturer', () => {
  // Amlodipine Tablets — without manufacturer column, should pick top manufacturer for enrichment
  const rows = [
    { 'Drug Name': 'Amlodipine Tablets', 'Strength': '10mg', 'Qty': '2', 'Price': '500', 'Date': '2024-03-10' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  // canonical_product should be source identity, NOT enriched with manufacturer
  assert(rec.canonical_product != null, 'canonical_product should be set');
  assert(rec.canonical_product.toLowerCase().includes('amlodipine'), `Expected amlodipine in canonical, got: ${rec.canonical_product}`);
  // Resolved manufacturer from NAFDAC should be in resolved_manufacturer field
  assert(rec.resolved_manufacturer != null || rec.manufacturer != null, 'resolved manufacturer should be inferred from NAFDAC');
  // Source identity should NOT contain manufacturer suffix
  assert(!rec.canonical_product.includes('('), `Source identity should not include manufacturer: ${rec.canonical_product}`);
  // Case 3: ambiguous/inferred manufacturer — must NOT appear in display_product
  assert(!rec.display_product.includes('('), `Ambiguous manufacturer should not appear in display: ${rec.display_product}`);
  assert(rec.resolution_status === 'AMBIGUOUS_MATCH' || rec.resolution_status === 'enriched', `Expected ambiguous status, got: ${rec.resolution_status}`);
});

test('has_variants is set correctly for multi-manufacturer brands', () => {
  // Test enrichIdentity directly with a multi-manufacturer brand
  const resolved = { product_name: 'Amlodipine Tablets', rule: 5, ruleLabel: 'Brand Name only', confidence: 0.60, parts_used: ['brand'] };
  const fields = { brand: 'Amlodipine Tablets' };
  const enriched = enrichIdentity(resolved, fields);
  assert(enriched.has_variants === true, `Expected has_variants=true for multi-manufacturer brand, got: ${enriched.has_variants}`);
});

test('has_variants is false for single-manufacturer or unknown brands', () => {
  // A product not in NAFDAC should have has_variants=false
  const resolved = { product_name: 'SuperFake Drug 999', rule: 1, ruleLabel: 'Direct PRODUCT column', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'SuperFake Drug 999' };
  const enriched = enrichIdentity(resolved, fields);
  assert(enriched.has_variants === false, `Expected has_variants=false for unknown product, got: ${enriched.has_variants}`);
});

test('unknown products remain unchanged (no false normalization)', () => {
  const rows = [
    { 'Drug Name': 'TotallyFake Medicine X9000', 'Qty': '1', 'Price': '999' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  // Unknown products should keep their original name, not get incorrectly normalized
  assert(rec.canonical_product.includes('TotallyFake'), `Unknown product should keep original name, got: ${rec.canonical_product}`);
  assertEquals(rec.product_name, 'TotallyFake Medicine X9000', 'Product name should be unchanged');
});

test('Case 2 resolution_source is nafdac_weighted', () => {
  const rows = [
    { 'Drug Name': 'Amlodipine Tablets', 'Manufacturer': 'Skg - Pharma Limited', 'Qty': '1', 'Price': '300' },
  ];
  const mapping = { product_name: { rawHeader: 'Drug Name' }, manufacturer: { rawHeader: 'Manufacturer' } };
  const { records, summary } = resolveProductIdentities(rows, mapping);
  assertEquals(records[0].resolution_source, 'nafdac_weighted',
    `Expected nafdac_weighted, got: ${records[0].resolution_source}`);
  assert(summary.variantDisambiguated >= 1, `Expected variantDisambiguated >= 1, got: ${summary.variantDisambiguated}`);
});

test('Case 3 resolution_source is nafdac_weighted', () => {
  const rows = [
    { 'Drug Name': 'Amlodipine Tablets', 'Qty': '1', 'Price': '300' },
  ];
  const mapping = { product_name: { rawHeader: 'Drug Name' } };
  const { records, summary } = resolveProductIdentities(rows, mapping);
  assertEquals(records[0].resolution_source, 'nafdac_weighted',
    `Expected nafdac_weighted, got: ${records[0].resolution_source}`);
  assert(summary.variantDisambiguated >= 1, `Expected variantDisambiguated >= 1, got: ${summary.variantDisambiguated}`);
});

console.log('\n=== Dual Product Identity ===');

test('source_product_name is set and never includes manufacturer suffix', () => {
  const rows = [
    { 'Drug Name': 'Ibuprofen 400mg', 'Qty': '3', 'Price': '350', 'Date': '2024-03-15' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  assert(rec.source_product_name != null, 'source_product_name should be set');
  assert(rec.source_product_name.toLowerCase().includes('ibuprofen'), `Expected ibuprofen in source, got: ${rec.source_product_name}`);
  assert(!rec.source_product_name.includes('('), `Source should NOT include manufacturer: ${rec.source_product_name}`);
});

test('canonical_product equals source identity (not enriched)', () => {
  const rows = [
    { 'Drug Name': 'Ibuprofen 400mg', 'Qty': '3', 'Price': '350', 'Date': '2024-03-15' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  assertEquals(rec.canonical_product, rec.source_product_name, 'canonical should equal source');
});

test('resolved_manufacturer is separate from manufacturer column value', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol 500mg', 'Manufacturer': 'GSK', 'Qty': '1', 'Price': '200', 'Date': '2024-01-01' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  // resolved_manufacturer should be populated (from NAFDAC)
  assert(rec.resolved_manufacturer != null, 'resolved_manufacturer should be set from NAFDAC');
  // manufacturer from upload is also available but separate
  assert(rec.manufacturer != null, 'manufacturer field should be set');
});

test('display_product defaults to source — no manufacturer for ambiguous matches', () => {
  // Paracetamol has many manufacturers → ambiguous. Display should stay clean.
  const rows = [
    { 'Drug Name': 'Paracetamol 500mg', 'Qty': '1', 'Price': '200', 'Date': '2024-01-01' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  // Source identity never includes manufacturer
  assert(!rec.source_product_name.includes('('), `Source should be clean: ${rec.source_product_name}`);
  // display_product should NOT include manufacturer for ambiguous brands
  assert(!rec.display_product.includes('('), `Display should not include ambiguous mfr: ${rec.display_product}`);
});

test('EXACT_MATCH shows manufacturer in display for unique brands', () => {
  // Test via enrichIdentity with a unique-brand scenario
  const resolved = { product_name: 'Coartem 80/480', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Coartem 80/480' };
  const enriched = enrichIdentity(resolved, fields);
  // If unique in NAFDAC, display should include manufacturer
  if (enriched.resolution_status === 'EXACT_MATCH') {
    assert(enriched.display_product.includes('('), `EXACT_MATCH should show mfr: ${enriched.display_product}`);
  }
  // Source remains unchanged
  assert(!enriched.source_product_name.includes('('), 'Source should never include mfr');
});

test('ambiguous/inferred manufacturer never appears in display', () => {
  // Amlodipine Tablets has multiple manufacturers → ambiguous
  const resolved = { product_name: 'Amlodipine Tablets', rule: 5, ruleLabel: 'Brand Only', confidence: 0.60, parts_used: ['brand'] };
  const fields = { brand: 'Amlodipine Tablets' };
  const enriched = enrichIdentity(resolved, fields);
  // Even though resolved_manufacturer is populated, display_product should NOT show it
  assert(enriched.resolved_manufacturer != null, 'resolved_manufacturer should be populated');
  assert(!enriched.display_product.includes('('), `Ambiguous mfr should NOT appear in display: ${enriched.display_product}`);
  assert(['AMBIGUOUS_MATCH', 'enriched'].includes(enriched.resolution_status), `Expected ambiguous status, got: ${enriched.resolution_status}`);
});

test('resolution_status is present on enriched records', () => {
  const rows = [
    { 'Drug Name': 'Ibuprofen 400mg', 'Qty': '3', 'Price': '350', 'Date': '2024-03-15' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  assert(rec.resolution_status != null, 'resolution_status should be set');
  assert(['resolved', 'enriched', 'unverified', 'unknown', 'EXACT_MATCH', 'AMBIGUOUS_MATCH', 'PARTIAL_MATCH', 'PARSED_ONLY'].includes(rec.resolution_status),
    `Unexpected resolution_status: ${rec.resolution_status}`);
});

test('backward compat: manufacturer and generic_name still populated from resolved', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol 500mg', 'Qty': '1', 'Price': '200', 'Date': '2024-01-01' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  // Legacy fields still work — filled from resolved if not in upload
  assert(rec.manufacturer != null, 'manufacturer should be populated (backward compat)');
  assert(rec.generic_name != null, 'generic_name should be populated (backward compat)');
});

console.log('\n=== Multi-Layer Clinical Identity ===');

test('Layer 3: clinical_product_id set from NAFDAC', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol 500mg', 'Qty': '1', 'Price': '200', 'Date': '2024-01-01' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  assert(rec.clinical_product_id != null, 'clinical_product_id should be set from NAFDAC');
  assert(typeof rec.clinical_product_id === 'string', 'clinical_product_id should be a string');
});

test('Layer 3: therapeutic_class populated from NAFDAC', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol 500mg', 'Qty': '1', 'Price': '200', 'Date': '2024-01-01' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  assert(rec.therapeutic_class != null, 'therapeutic_class should be populated');
});

test('Layer 3: active_ingredients inferred from generic', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol 500mg', 'Qty': '1', 'Price': '200', 'Date': '2024-01-01' },
    { 'Drug Name': 'Ibuprofen 400mg', 'Qty': '3', 'Price': '350', 'Date': '2024-03-15' },
  ];
  const result = normalize(rows);
  // Paracetamol should have [Paracetamol] as active ingredient
  const rec0 = result.normalized[0];
  assert(Array.isArray(rec0.active_ingredients), 'active_ingredients should be an array');
  assert(rec0.active_ingredients.length > 0, 'active_ingredients should not be empty');
  assert(rec0.active_ingredients.includes('Paracetamol'), 'Should include Paracetamol');
  // Ibuprofen should have [Ibuprofen]
  const rec1 = result.normalized[1];
  assert(rec1.active_ingredients.includes('Ibuprofen'), 'Should include Ibuprofen');
});

test('resolution_tier is auto for high confidence matches', () => {
  // Lonart is unique in NAFDAC → EXACT_MATCH → high confidence → auto
  const resolved = { product_name: 'Lonart', rule: 5, ruleLabel: 'Brand Only', confidence: 0.60, parts_used: ['brand'] };
  const fields = { brand: 'Lonart' };
  const enriched = enrichIdentity(resolved, fields);
  if (enriched.resolution_status === 'EXACT_MATCH') {
    assert(enriched.resolution_tier === 'auto', `EXACT_MATCH should be auto tier, got: ${enriched.resolution_tier}`);
  }
});

test('resolution_tier is excluded for unknown products', () => {
  // Unknown product → low confidence → excluded from clinical intelligence
  const resolved = { product_name: 'SuperFakeDrug999', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'SuperFakeDrug999' };
  const enriched = enrichIdentity(resolved, fields);
  assertEquals(enriched.resolution_status, 'unverified', 'Unknown should be unverified');
  assertEquals(enriched.resolution_tier, 'excluded', 'Unknown should be excluded from clinical');
});

test('Layer 3: unknown products have no clinical data', () => {
  const rows = [
    { 'Drug Name': 'TotallyUnknownPharma999', 'Qty': '1', 'Price': '999' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];
  // Clinical fields should be null/empty for unknown products
  assert(rec.clinical_product_id === null, `clinical_product_id should be null, got: ${rec.clinical_product_id}`);
  assert(rec.therapeutic_class === null, `therapeutic_class should be null, got: ${rec.therapeutic_class}`);
  assert(rec.active_ingredients === null || rec.active_ingredients.length === 0, `active_ingredients should be empty, got: ${rec.active_ingredients}`);
  assert(rec.resolution_tier === 'excluded', `Unknown should be excluded tier, got: ${rec.resolution_tier}`);
});

console.log('\n=== PARSED_ONLY Resolution Status ===');

test('PARSED_ONLY: parser extracts attributes but NAFDAC finds no match', () => {
  // Parse succeeds (generic + strength + form extracted) but NAFDAC lookup fails
  const resolved = { product_name: 'Citalopram 20mg Tablet', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Citalopram 20mg Tablet' };
  const enriched = enrichIdentity(resolved, fields);
  assertEquals(enriched.resolution_status, 'PARSED_ONLY',
    `Expected PARSED_ONLY for parsed-but-unmatched product, got: ${enriched.resolution_status}`);
  assertEquals(enriched.resolution_source, 'parser',
    `Expected parser source, got: ${enriched.resolution_source}`);
});

test('PARSED_ONLY: parser success is distinct from unverified (rule-based fallback)', () => {
  // When parser extracts nothing but rule composer resolves → unverified
  // When parser extracts structured attributes → PARSED_ONLY
  const resolved = { product_name: 'Citalopram 20mg Tablet', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Citalopram 20mg Tablet' };
  const enriched = enrichIdentity(resolved, fields);
  assertEquals(enriched.resolution_status, 'PARSED_ONLY');
  assert(enriched.resolution_status !== 'unverified',
    'PARSED_ONLY should replace unverified when parser extracted attributes');
});

test('PARSED_ONLY: unverified when parser finds only brand (no structured attributes)', () => {
  // Parser brand extraction is a fallback, not a meaningful structured parse
  const parsed = parseDrugName('SuperFakeDrug999');
  const parserExtracted = parsed && (parsed.generic || parsed.strength || parsed.form || parsed.pack_size);
  assert(!parserExtracted, 'SuperFakeDrug999 should NOT trigger parser success (brand-only does not count)');
});

test('PARSED_ONLY: existing EXACT_MATCH still works', () => {
  // A known product that NAFDAC matches should still get EXACT_MATCH, not PARSED_ONLY
  const resolved = { product_name: 'Paracetamol 500mg', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Paracetamol 500mg' };
  const enriched = enrichIdentity(resolved, fields);
  // Paracetamol is in the NAFDAC dataset — expect a match, not PARSED_ONLY
  assert(enriched.resolution_status !== 'PARSED_ONLY',
    `Known drug should NOT get PARSED_ONLY, got: ${enriched.resolution_status}`);
});

console.log('\n=== Resolution Metadata ===');

test('resolution_method: weighted_match for NAFDAC matches', () => {
  assertEquals(computeResolutionMethod('EXACT_MATCH'), 'weighted_match');
  assertEquals(computeResolutionMethod('AMBIGUOUS_MATCH'), 'weighted_match');
  assertEquals(computeResolutionMethod('PARTIAL_MATCH'), 'weighted_match');
});

test('resolution_method: parser_only for PARSED_ONLY', () => {
  assertEquals(computeResolutionMethod('PARSED_ONLY'), 'parser_only');
});

test('resolution_method: unresolved for unverified/unknown', () => {
  assertEquals(computeResolutionMethod('unverified'), 'unresolved');
  assertEquals(computeResolutionMethod('unknown'), 'unresolved');
});

test('resolution_method is present on enriched records', () => {
  const resolved = { product_name: 'Paracetamol 500mg', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Paracetamol 500mg' };
  const enriched = enrichIdentity(resolved, fields);
  assert(enriched.resolution_method != null, 'resolution_method should be set');
  assert(typeof enriched.resolution_method === 'string', 'resolution_method should be a string');
});

test('parser_confidence and lookup_confidence are present on enriched records', () => {
  // Citalopram: parser succeeds, NAFDAC fails → PARSED_ONLY
  const resolved = { product_name: 'Citalopram 20mg Tablet', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Citalopram 20mg Tablet' };
  const enriched = enrichIdentity(resolved, fields);

  assert(enriched.parser_confidence != null, 'parser_confidence should be set');
  assert(enriched.lookup_confidence != null, 'lookup_confidence should be set');
  assert(typeof enriched.parser_confidence === 'number', 'parser_confidence should be a number');
  assert(typeof enriched.lookup_confidence === 'number', 'lookup_confidence should be a number');
});

test('parser_confidence reflects structured field extraction count', () => {
  // Paracetamol 500mg: generic + strength extracted → parser confidence higher
  const resolved = { product_name: 'Paracetamol 500mg', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Paracetamol 500mg' };
  const enriched = enrichIdentity(resolved, fields);

  assert(enriched.parser_confidence >= 0.3, `parser_confidence too low: ${enriched.parser_confidence}`);
  assert(enriched.parser_confidence <= 0.95, `parser_confidence too high: ${enriched.parser_confidence}`);
});

test('parser_confidence is null when parser has nothing to parse', () => {
  // Empty product name → parser returns confidence 0, but we map null input → null
  const resolved = { product_name: null, rule: 7, ruleLabel: 'No identity', confidence: 0, parts_used: [] };
  const fields = { product_name: null };
  const enriched = enrichIdentity(resolved, fields);
  assertEquals(enriched.parser_confidence, null,
    `parser_confidence should be null for empty input, got: ${enriched.parser_confidence}`);
});

test('lookup_confidence reflects NAFDAC weighted match confidence', () => {
  // Paracetamol should match in NAFDAC → lookup_confidence > 0
  const resolved = { product_name: 'Paracetamol 500mg', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Paracetamol 500mg' };
  const enriched = enrichIdentity(resolved, fields);

  assert(enriched.lookup_confidence >= 0, `lookup_confidence should be >= 0, got: ${enriched.lookup_confidence}`);
  assert(enriched.lookup_confidence <= 1, `lookup_confidence should be <= 1, got: ${enriched.lookup_confidence}`);
});

test('resolution_confidence is unchanged by metadata additions', () => {
  const resolved = { product_name: 'Paracetamol 500mg', rule: 1, ruleLabel: 'Direct PRODUCT', confidence: 0.95, parts_used: ['product_name'] };
  const fields = { product_name: 'Paracetamol 500mg' };
  const enriched = enrichIdentity(resolved, fields);

  assert(enriched.resolution_confidence != null, 'resolution_confidence should still be present');
  assert(typeof enriched.resolution_confidence === 'number', 'resolution_confidence should be a number');
  assert(enriched.resolution_confidence >= 0, `resolution_confidence >= 0, got: ${enriched.resolution_confidence}`);
});

test('resolution metadata propagates through full pipeline', () => {
  const rows = [
    { 'Drug Name': 'Citalopram 20mg Tablet', 'Qty': '1', 'Price': '500', 'Date': '2024-06-01' },
  ];
  const result = normalize(rows);
  const rec = result.normalized[0];

  assert(rec.resolution_method != null, 'resolution_method should be set in pipeline output');
  assert(rec.parser_confidence != null, 'parser_confidence should be set in pipeline output');
  assert(rec.lookup_confidence != null, 'lookup_confidence should be set in pipeline output');
  assertEquals(rec.resolution_method, 'parser_only',
    `Expected parser_only in pipeline, got: ${rec.resolution_method}`);
});

console.log('\n=== Fuzzy Brand Matching ===');

test('fuzzy: Paracetamo resolves to Paracetamol', () => {
  const result = identifyDrug('Paracetamo');
  assert(result.recognized, 'Paracetamo should be recognized via fuzzy match');
  assertEquals(result.generic, 'Paracetamol',
    `Expected Paracetamol, got: ${result.generic}`);
  assertEquals(result.source, 'fuzzy_brand_match');
});

test('fuzzy: Ibuprofe resolves to Ibuprofen', () => {
  const result = identifyDrug('Ibuprofe');
  assert(result.recognized, 'Ibuprofe should be recognized');
  assertEquals(result.generic, 'Ibuprofen');
});

test('fuzzy: Flagy resolves to Flagyl (Metronidazole)', () => {
  const result = identifyDrug('Flagy');
  assert(result.recognized, 'Flagy should be recognized');
  assertEquals(result.generic, 'Metronidazole',
    `Expected Metronidazole, got: ${result.generic}`);
});

test('fuzzy: Amoxicilli resolves to Amoxicillin', () => {
  const result = identifyDrug('Amoxicilli');
  assert(result.recognized, 'Amoxicilli should be recognized');
  assertEquals(result.generic, 'Amoxicillin');
});

test('fuzzy: Coarte resolves to Coartem (Artemether + Lumefantrine)', () => {
  const result = identifyDrug('Coarte');
  assert(result.recognized, 'Coarte should be recognized');
  assertEquals(result.generic, 'Artemether + Lumefantrine',
    `Expected Artemether + Lumefantrine, got: ${result.generic}`);
});

test('fuzzy: misspelled variants group to same canonical_product in pipeline', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol', 'Qty': '1', 'Price': '500', 'Date': '2024-01-01' },
    { 'Drug Name': 'Paracetamo', 'Qty': '1', 'Price': '500', 'Date': '2024-01-02' },
    { 'Drug Name': 'Ibuprofen', 'Qty': '1', 'Price': '250', 'Date': '2024-01-01' },
    { 'Drug Name': 'Ibuprofe', 'Qty': '1', 'Price': '250', 'Date': '2024-01-02' },
    { 'Drug Name': 'Omeprazole', 'Qty': '1', 'Price': '350', 'Date': '2024-01-01' },
    { 'Drug Name': 'Omeprazol', 'Qty': '1', 'Price': '350', 'Date': '2024-01-02' },
    { 'Drug Name': 'Amlodipine', 'Qty': '1', 'Price': '450', 'Date': '2024-01-01' },
    { 'Drug Name': 'Amlodipin', 'Qty': '1', 'Price': '450', 'Date': '2024-01-02' },
    { 'Drug Name': 'Amoxicillin', 'Qty': '1', 'Price': '400', 'Date': '2024-01-01' },
    { 'Drug Name': 'Amoxicilli', 'Qty': '1', 'Price': '400', 'Date': '2024-01-02' },
    { 'Drug Name': 'Flagyl', 'Qty': '1', 'Price': '600', 'Date': '2024-01-01' },
    { 'Drug Name': 'Flagy', 'Qty': '1', 'Price': '600', 'Date': '2024-01-02' },
    { 'Drug Name': 'Coartem', 'Qty': '1', 'Price': '800', 'Date': '2024-01-01' },
    { 'Drug Name': 'Coarte', 'Qty': '1', 'Price': '800', 'Date': '2024-01-02' },
    { 'Drug Name': 'Metformin', 'Qty': '1', 'Price': '300', 'Date': '2024-01-01' },
  ];
  const result = normalize(rows);
  const canonicals = [...new Set(result.normalized.map(r => r.canonical_product))];
  assertEquals(canonicals.length, 8,
    `Expected 8 distinct canonical products, got ${canonicals.length}: ${canonicals.join(', ')}`);
});

test('fuzzy: revenue is summed correctly across misspelled variants', () => {
  const rows = [
    { 'Drug Name': 'Paracetamol', 'Qty': '1', 'Price': '500', 'Date': '2024-01-01' },
    { 'Drug Name': 'Paracetamo', 'Qty': '2', 'Price': '500', 'Date': '2024-01-02' },
    { 'Drug Name': 'Ibuprofen', 'Qty': '1', 'Price': '250', 'Date': '2024-01-01' },
    { 'Drug Name': 'Ibuprofe', 'Qty': '3', 'Price': '250', 'Date': '2024-01-02' },
  ];
  const result = normalize(rows);
  const a = analyze(result.normalized);

  // Both Paracetamol variants should be combined revenue
  const para = a.topProducts.find(p => p.name.includes('Paracetamol'));
  assert(para != null, 'Paracetamol should be in top products');
  assertEquals(para.revenue, 1500, `Expected combined revenue 1500, got: ${para.revenue}`);
  assertEquals(para.quantity, 3, `Expected combined quantity 3, got: ${para.quantity}`);

  // Both Ibuprofen variants should be combined
  const ibu = a.topProducts.find(p => p.name.includes('Ibuprofen'));
  assert(ibu != null, 'Ibuprofen should be in top products');
  assertEquals(ibu.revenue, 1000, `Expected combined revenue 1000, got: ${ibu.revenue}`);
  assertEquals(ibu.quantity, 4, `Expected combined quantity 4, got: ${ibu.quantity}`);
});

test('fuzzy: completely unknown drugs still flagged as unknown', () => {
  const result = identifyDrug('XyzzyDrug999');
  assert(!result.recognized, 'Completely unknown drug should NOT be recognized');
  assertEquals(result.flag, 'UNKNOWN_MEDICINE');
});

console.log('\n=== Prompt 0: Product Text Normalization ===');

test('text norm: expands TAB/CAP/INJ/SUSP/SYR abbreviations', () => {
  assertEquals(normalizeProductText('Paracetamol 500MG TAB'), 'paracetamol 500mg tablet');
  assertEquals(normalizeProductText('Amoxicillin 250MG CAP'), 'amoxicillin 250mg capsule');
  assertEquals(normalizeProductText('Diclofenac 50MG INJ'), 'diclofenac 50mg injection');
  assertEquals(normalizeProductText('Amoxicillin SUSP'), 'amoxicillin syrup');
  assertEquals(normalizeProductText('Coartem SYR'), 'coartem syrup');
});

test('text norm: normalizes unit spacing (500 MG → 500mg)', () => {
  assertEquals(normalizeProductText('Ibuprofen 400 MG'), 'ibuprofen 400mg');
  assertEquals(normalizeProductText('10 ML SYR'), '10ml syrup');
  assertEquals(normalizeProductText('5 G powder'), '5g powder');
  assertEquals(normalizeProductText('Amoxicillin 250 mg'), 'amoxicillin 250mg');
});

test('text norm: lowercases and cleans punctuation', () => {
  assertEquals(normalizeProductText('PARACETAMOL, 500mg TAB'), 'paracetamol 500mg tablet');
  // Parens preserved — meaningful for combination drugs like "Ampicillin + Cloxacillin (Ampiclox)"
  assertEquals(normalizeProductText('Ibuprofen (400mg) Caps'), 'ibuprofen (400mg) capsule');
  assertEquals(normalizeProductText('  Vitamin   C  500mg  '), 'vitamin c 500mg');
});

test('text norm: handles null and empty', () => {
  assertEquals(normalizeProductText(null), null);
  assertEquals(normalizeProductText(''), '');
  assertEquals(normalizeProductText('  '), '');
});

test('text norm: abbreviation expansion helps downstream recognition', () => {
  // Without normalization, "500MG TAB" might not be parsed as well
  // After normalization, the product parser sees "500mg tablet"
  const result = normalizeProductName('Paracetamol 500MG TAB');
  assert(result.recognized, 'Should recognize "500MG TAB" after normalization');
  assertEquals(result.generic, 'Paracetamol');
  assertEquals(result.strength, '500mg');
  assertEquals(result.form, 'Tablet');
});

test('text norm: synonyms are idempotent', () => {
  const a = normalizeProductText('Paracetamol 500MG TAB');
  const b = normalizeProductText(a);
  assertEquals(a, b, 'Normalization should be idempotent');
});

console.log('\n=== Context-Aware Widget Engine ===');

const { detectAvailableFields } = require('../services/widgetEngine');

test('context: sales-only records do not expose inventory fields', () => {
  const records = [
    { product_name: 'Paracetamol', quantity: 3, selling_price: 500, revenue: 1500, transaction_date: '2024-01-01',
      current_stock: null, reorder_level: null, min_stock: null, max_stock: null, opening_stock: null, expiry_date: null, supplier: null },
    { product_name: 'Ibuprofen', quantity: 2, selling_price: 250, revenue: 500, transaction_date: '2024-01-02',
      current_stock: null, reorder_level: null, min_stock: null, max_stock: null, opening_stock: null, expiry_date: null, supplier: null },
  ];
  const fields = detectAvailableFields(records);
  assert(fields.has('product_name'), 'product_name should be available');
  assert(fields.has('quantity'), 'quantity should be available');
  assert(fields.has('selling_price'), 'selling_price should be available');
  assert(!fields.has('current_stock'), 'current_stock should NOT be available when all null');
  assert(!fields.has('reorder_level'), 'reorder_level should NOT be available when all null');
  assert(!fields.has('expiry_date'), 'expiry_date should NOT be available when all null');
  assert(!fields.has('supplier'), 'supplier should NOT be available when all null');
});

test('context: inventory records expose stock fields', () => {
  const records = [
    { product_name: 'Paracetamol', current_stock: 150, reorder_level: 20, expiry_date: '2025-12-01',
      quantity: null, selling_price: null, transaction_date: null },
    { product_name: 'Ibuprofen', current_stock: 80, reorder_level: 10, expiry_date: '2025-06-15',
      quantity: null, selling_price: null, transaction_date: null },
  ];
  const fields = detectAvailableFields(records);
  assert(fields.has('product_name'), 'product_name should be available');
  assert(fields.has('current_stock'), 'current_stock should be available with real values');
  assert(fields.has('reorder_level'), 'reorder_level should be available with real values');
  assert(fields.has('expiry_date'), 'expiry_date should be available with real values');
  assert(!fields.has('quantity'), 'quantity should NOT be available when all null');
  assert(!fields.has('selling_price'), 'selling_price should NOT be available when all null');
});

test('context: mixed data — field with any non-null value is available', () => {
  const records = [
    { product_name: 'Paracetamol', current_stock: 150 },
    { product_name: 'Ibuprofen', current_stock: null },
  ];
  const fields = detectAvailableFields(records);
  assert(fields.has('current_stock'), 'current_stock should be available when at least one record has a value');
});

test('context: empty records returns empty set', () => {
  assertEquals(detectAvailableFields([]).size, 0);
  assertEquals(detectAvailableFields(null).size, 0);
});

test('context: zero stock is valid data (not treated as missing)', () => {
  const records = [
    { product_name: 'OutOfStock', current_stock: 0 },
  ];
  const fields = detectAvailableFields(records);
  assert(fields.has('current_stock'), 'current_stock=0 should be treated as available data');
});

test('context: widget engine excludes inventory widgets for sales-only dataset', () => {
  const { evaluate } = require('../services/widgetEngine');
  const records = [
    { product_name: 'Paracetamol', quantity: 3, selling_price: 500, revenue: 1500, transaction_date: '2024-01-01',
      current_stock: null, reorder_level: null, cost_price: null, expiry_date: null, supplier: null },
  ];
  const manifest = evaluate(records);

  // Sales widgets should be available
  assert(manifest.dashboards.sales.available.length > 0, 'Sales widgets should be available');

  // Inventory widgets should be unavailable (missing required fields)
  const invUnavailable = manifest.dashboards.inventory.unavailable;
  assert(invUnavailable.length > 0, 'Inventory widgets should be unavailable for sales-only data');

  // Verify a specific inventory widget is unavailable
  const lowStock = invUnavailable.find(w => w.id === 'low-stock-alert');
  assert(lowStock != null, 'low-stock-alert should be unavailable');
  assert(lowStock.missingFields.includes('current_stock'),
    'low-stock-alert should report current_stock as missing');
});

console.log('\n=== Widget Descriptions (Info Tooltips) ===');

const widgetRegistry = require('../services/widgetRegistry');

test('info: every widget has a description', () => {
  const all = widgetRegistry.getAll();
  assert(all.length > 0, 'Widget registry should not be empty');
  for (const w of all) {
    assert(w.description != null && w.description.length > 0,
      `Widget "${w.id}" is missing a description`);
  }
});

test('info: KPI widget descriptions are concise and readable', () => {
  const kpis = widgetRegistry.getAll().filter(w => w.category === 'KPIs');
  for (const w of kpis) {
    assert(w.description.length >= 20, `Description too short for ${w.id}: "${w.description}"`);
    assert(w.description.length <= 200, `Description too long for ${w.id}: ${w.description.length} chars`);
    // Should be a complete sentence (ends with period or similar)
    assert(w.description.endsWith('.') || w.description.endsWith('!'),
      `Description for ${w.id} should end with punctuation: "${w.description}"`);
  }
});

test('info: descriptions match expected examples from specification', () => {
  const get = (id) => widgetRegistry.get(id).description;
  assertEquals(get('revenue-kpi'), 'Total sales generated during the selected period before deducting expenses.');
  assertEquals(get('profit-kpi'), 'Revenue minus the cost of goods sold. Shows how much profit was earned before operating expenses.');
  assertEquals(get('inventory-turnover'), 'Measures how quickly inventory is sold and replaced. Higher values indicate faster stock movement.');
  assertEquals(get('distinct-products-kpi'), 'Number of unique products identified after product normalization.');
  assertEquals(get('low-stock-alert'), 'Number of products currently below the configured stock threshold.');
});

console.log('\n=== Time Granularity Detection ===');

const { detectTimeGranularity } = require('../services/analytics');

test('time: 5 days → daily only', () => {
  const records = [
    { transaction_date: '2024-01-01' }, { transaction_date: '2024-01-02' }, { transaction_date: '2024-01-03' },
    { transaction_date: '2024-01-04' }, { transaction_date: '2024-01-05' },
  ];
  const g = detectTimeGranularity(records);
  assert(g.day, 'day should be available');
  assert(!g.week, 'week should NOT be available for 5 days');
  assert(!g.month, 'month should NOT be available for 5 days');
  assert(!g.year, 'year should NOT be available for 5 days');
});

test('time: 4 weeks (~28 days) → daily + weekly', () => {
  const records = [];
  for (let i = 0; i < 28; i++) {
    records.push({ transaction_date: `2024-01-${String(i + 1).padStart(2, '0')}` });
  }
  const g = detectTimeGranularity(records);
  assert(g.day, 'day should be available');
  assert(g.week, 'week should be available for 4 weeks');
  assert(!g.month, 'month should NOT be available for 4 weeks');
  assert(!g.year, 'year should NOT be available');
});

test('time: 8 months (~240 days) → daily + weekly + monthly', () => {
  const records = [];
  for (let m = 0; m < 8; m++) {
    records.push({ transaction_date: `2024-${String(m + 1).padStart(2, '0')}-01` });
  }
  const g = detectTimeGranularity(records);
  assert(g.day, 'day should be available');
  assert(g.week, 'week should be available');
  assert(g.month, 'month should be available for 8 months');
  assert(!g.year, 'year should NOT be available (< 1 year span)');
});

test('time: 3 years → daily + weekly + monthly + yearly', () => {
  const records = [];
  for (let y = 2021; y <= 2023; y++) {
    records.push({ transaction_date: `${y}-01-01` });
  }
  const g = detectTimeGranularity(records);
  assert(g.day, 'day should be available');
  assert(g.week, 'week should be available');
  assert(g.month, 'month should be available');
  assert(g.year, 'year should be available for multi-year data');
});

test('time: no dates → nothing available', () => {
  const g = detectTimeGranularity([{ name: 'test', value: 5 }]);
  assert(!g.day && !g.week && !g.month && !g.year, 'all should be false with no dates');
  assertEquals(g.spanDays, 0);
});

test('time: single date → daily only', () => {
  const g = detectTimeGranularity([{ transaction_date: '2024-06-15' }]);
  assert(g.day, 'day should be available for a single date');
  assert(!g.week, 'week should NOT be available');
});

test('time: widget drill-levels respect granularity', () => {
  const widget = widgetRegistry.get('monthly-revenue');
  // 5-day dataset → should only produce day drill level (not week/month)
  const records = [
    { transaction_date: '2024-01-01', selling_price: '100', quantity: '1', product_name: 'Test' },
    { transaction_date: '2024-01-02', selling_price: '200', quantity: '2', product_name: 'Test' },
    { transaction_date: '2024-01-03', selling_price: '150', quantity: '1', product_name: 'Test' },
    { transaction_date: '2024-01-04', selling_price: '300', quantity: '3', product_name: 'Test' },
    { transaction_date: '2024-01-05', selling_price: '100', quantity: '1', product_name: 'Test' },
  ];
  const result = widget.compute(records);
  assert(!result.error, 'Should not error on 5-day dataset');
  assert(result.availableGranularity != null, 'Should include availableGranularity');
  assertEquals(result.availableGranularity.day, true);
  assertEquals(result.availableGranularity.week, false);
  assertEquals(result.availableGranularity.month, false);
  // Drill levels should be null since only one level is available
  assert(result.drillLevels == null, '5-day data should not have multiple drill levels');
  // Primary series should be daily
  assert(result.series[0].data.length >= 5, 'Should have at least 5 daily data points');
});

// ---- summary -----------------------------------------------------------

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
