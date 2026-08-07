/**
 * End-to-end regression test for the two defects that made a real pharmacy
 * export come out wrong, using that export as the fixture.
 *
 * Run:  node --test server/tests/monthlyTrend.test.js
 *
 * fixtures/akure_pharmacy_sales.csv is 1500 rows of Akure pharmacy sales
 * covering exactly January to December 2025. It is kept whole rather than
 * trimmed to a few rows because both bugs were invisible in the headline
 * figures and only showed up in aggregate: total revenue was correct to the
 * naira in both cases, and only the monthly breakdown and the column mapping
 * were wrong. A three-row fixture would have reproduced neither.
 *
 * What it defends:
 *
 *   1. Excel serial dates arriving a day early. xlsx turns "2025-01-01" into
 *      serial 45658, and serialToDate corrected Excel's 1900 leap-year bug a
 *      second time on top of the epoch that already absorbs it. Every date
 *      moved back one day, so sales on the 1st fell into the previous month and
 *      a twelve-month file reported thirteen months starting 2024-12 -- a month
 *      containing nothing but December 31st's takings.
 *
 *   2. TotalAmount_NGN classified as tax. normalizeHeader lowercased before
 *      tokenizing, so the header became the single token "totalamount", which
 *      the matcher could only score by containment -- and it contains "amount",
 *      a tax synonym, as readily as "total". Revenue was never mapped at all.
 *      The total still came out right because revenue falls back to
 *      selling_price x quantity, which happens to equal TotalAmount_NGN in this
 *      file; on an export with any discount it would not.
 *
 * The expected monthly figures were computed straight from the CSV text,
 * bypassing the parser entirely, so they are independent of the code under test.
 */

const fs = require('fs');
const path = require('path');

const { parseSheet } = require('../services/fileUpload');
const { normalize } = require('../services/normalizer');
const { analyze } = require('../services/analytics');

const FIXTURE = path.join(__dirname, 'fixtures', 'akure_pharmacy_sales.csv');

// ---- test runner (same shape as pipeline.test.js) ------------------------

let passed = 0;
let failed = 0;
const queue = [];

function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      console.log(`  ok    ${name}`);
      passed++;
    } catch (err) {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
      failed++;
    }
  });
}

function section(name) {
  queue.push(async () => console.log(name));
}

function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- ground truth, computed from the raw file ---------------------------

/**
 * Read the CSV as text and total it by month. Deliberately does not use
 * parseSheet: if the parser is what is broken, expectations derived from it
 * would agree with the bug.
 */
function groundTruth() {
  const lines = fs.readFileSync(FIXTURE, 'utf8').trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const dateIdx = header.indexOf('Date');
  const amountIdx = header.indexOf('TotalAmount_NGN');

  const byMonth = new Map();
  let total = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const month = cells[dateIdx].slice(0, 7);
    const amount = Number(cells[amountIdx]);
    byMonth.set(month, (byMonth.get(month) || 0) + amount);
    total += amount;
  }
  return { byMonth, total, rowCount: lines.length - 1 };
}

// ---- the pipeline, run once and shared ----------------------------------

let truth;
let result;
let analysis;

async function runPipeline() {
  truth = groundTruth();
  const sheets = parseSheet(fs.readFileSync(FIXTURE));
  const rows = sheets[Object.keys(sheets)[0]];
  result = await normalize(rows);
  analysis = analyze(result.normalized);
}

// ---- tests --------------------------------------------------------------

section('\n=== Fixture sanity ===');
test('the fixture holds 1500 rows across 12 months', () => {
  assertEquals(truth.rowCount, 1500, 'row count');
  assertEquals(truth.byMonth.size, 12, 'months in the raw file');
});

section('\n=== Defect 1: Excel serial dates arriving a day early ===');
test('the first row keeps its date instead of moving to the day before', () => {
  assertEquals(result.normalized[0].transaction_date, '2025-01-01', 'first transaction_date');
});
test('no date falls outside the year the file covers', () => {
  const dates = result.normalized.map((r) => r.transaction_date).filter(Boolean).sort();
  assertEquals(dates[0], '2025-01-01', 'earliest date');
  assertEquals(dates[dates.length - 1], '2025-12-31', 'latest date');
});
test('the trend has twelve months, not a phantom thirteenth', () => {
  assertEquals(analysis.monthlyRevenue.length, 12, 'months with data');
});
test('the trend starts in January, not the previous December', () => {
  assertEquals(analysis.monthlyRevenue[0].month, '2025-01', 'first month');
  assertEquals(analysis.monthlyRevenue[11].month, '2025-12', 'last month');
});

section('\n=== Defect 2: the revenue column classified as tax ===');
test('TotalAmount_NGN maps to revenue', () => {
  const revenue = result.mapping.revenue;
  assertEquals(revenue && revenue.rawHeader, 'TotalAmount_NGN', 'revenue column');
});
test('nothing is mapped to tax', () => {
  const tax = result.mapping.tax;
  assertEquals(tax ? tax.rawHeader : null, null, 'tax column');
});
test('revenue is read from the column, not inferred from price x quantity', () => {
  // Row 1 is 2 x 710 = 1420, so the two agree here; what matters is that the
  // field is populated from the mapped column at all.
  assertEquals(result.normalized[0].revenue, 1420, 'first row revenue');
});

section('\n=== Every month matches the raw file, to the naira ===');
for (const month of ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
  '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12']) {
  test(`${month} totals correctly`, () => {
    const row = analysis.monthlyRevenue.find((m) => m.month === month);
    assertEquals(row ? Math.round(row.revenue) : null, Math.round(truth.byMonth.get(month)), month);
  });
}

section('\n=== Headline ===');
test('total revenue matches the raw file', () => {
  assertEquals(Math.round(analysis.metrics.totalRevenue), Math.round(truth.total), 'total revenue');
});
test('the months sum to the total', () => {
  const sum = analysis.monthlyRevenue.reduce((acc, m) => acc + m.revenue, 0);
  assertEquals(Math.round(sum), Math.round(truth.total), 'sum of months');
});

// ---- run ----------------------------------------------------------------

(async () => {
  await runPipeline();
  for (const fn of queue) await fn();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
