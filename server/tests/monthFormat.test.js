/**
 * Tests for how a month is PRINTED, and for the thing that must not change
 * while fixing it.
 *
 * Reported: months were reaching pharmacy owners as "2026-07". Four files had
 * each grown their own monthLabel(), producing three different formats
 * ("Jul 2026", "Jul '26", "Jul 26"), and several places printed the raw key
 * with no formatting at all.
 *
 * The important constraint is that "2026-07" is a KEY as well as a label:
 * metrics.js sorts months with localeCompare, analytics.js pivots on it, and
 * SQL groups by it. Formatting the key in place would silently reorder every
 * trend (April before January, alphabetically), so these tests pin both
 * halves — the label is readable, AND the key is untouched.
 */

const { monthLong, monthShort } = require('../services/monthFormat');
const { generateInsights } = require('../services/recommendations');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

section('The reported format');

test('"2026-07" prints as "July 2026"', () => {
  eq(monthLong('2026-07'), 'July 2026');
});

test('every month maps to its full name', () => {
  const expected = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  expected.forEach((name, i) => {
    const key = `2026-${String(i + 1).padStart(2, '0')}`;
    eq(monthLong(key), `${name} 2026`, key);
  });
});

test('a single-digit month key still parses', () => {
  eq(monthLong('2026-7'), 'July 2026');
});

test('a full date narrows to its month', () => {
  eq(monthLong('2026-07-15'), 'July 2026');
});

section('Bad input never becomes visible nonsense');

test('an out-of-range month is echoed, not turned into "undefined 2026"', () => {
  eq(monthLong('2026-13'), '2026-13');
  eq(monthLong('2026-00'), '2026-00');
});

test('non-month text is returned unchanged', () => {
  eq(monthLong('not-a-month'), 'not-a-month');
  eq(monthLong('Unknown'), 'Unknown');
});

test('null and undefined produce an empty string, never the word "null"', () => {
  eq(monthLong(null), '');
  eq(monthLong(undefined), '');
});

section('The short form, for width-constrained chart axes only');

test('monthShort stays compact', () => {
  eq(monthShort('2026-07'), "Jul '26");
  eq(monthShort('2026-01'), "Jan '26");
});

test('monthShort is meaningfully shorter than monthLong', () => {
  // The PDF bar chart allots roughly CONTENT_WIDTH / months per label; this is
  // the whole reason the short form still exists.
  assert(monthShort('2026-09').length < monthLong('2026-09').length,
    'the short form must actually be shorter, or it has no reason to exist');
});

section('The sort key must survive formatting');

test('chronological order is preserved by the KEY, which formatting never touches', () => {
  const keys = ['2026-10', '2026-02', '2026-07', '2025-12'];
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  eq(sorted.join(','), '2025-12,2026-02,2026-07,2026-10', 'raw keys must sort chronologically');
});

test('sorting on the LABEL instead would scramble the order — why keys stay raw', () => {
  // Months inside one year, where alphabetical and chronological genuinely
  // diverge (an earlier draft of this test picked months where the two
  // happened to agree, which proved nothing).
  const keys = ['2026-01', '2026-04', '2026-08'];
  const chronological = keys.map(monthLong);
  eq(chronological.join(', '), 'January 2026, April 2026, August 2026');

  const alphabetical = [...chronological].sort((a, b) => a.localeCompare(b));
  eq(alphabetical.join(', '), 'April 2026, August 2026, January 2026');
  assert(alphabetical.join() !== chronological.join(),
    'formatting a key in place would reorder every trend — this is the regression to guard');
});

test('monthLong is pure — it does not mutate what it is given', () => {
  const months = [{ month: '2026-07', revenue: 100 }];
  monthLong(months[0].month);
  eq(months[0].month, '2026-07', 'the underlying key must be unchanged after formatting');
});

section('No raw YYYY-MM reaches the generated insight text');

test('trend insights print month names, never "2026-07"', () => {
  const health = { overallScore: 60, rating: 'Fair', pillars: {}, concerns: [] };
  const metrics = {
    overview: {
      totalRevenue: 3000000, grossProfit: 900000, grossMargin: 30,
      hasCostData: true, transactionCount: 900, averageTransactionValue: 3333,
    },
    products: { allProducts: [{ name: 'A', revenue: 1000000, margin: 30 }], totalDistinctProducts: 10 },
    trends: {
      months: [
        { month: '2026-05', revenue: 1500000, quantity: 100, transactions: 300, profit: 450000, margin: 30 },
        { month: '2026-06', revenue: 1200000, quantity: 90, transactions: 300, profit: 360000, margin: 30 },
        { month: '2026-07', revenue: 300000, quantity: 40, transactions: 300, profit: 90000, margin: 30 },
      ],
    },
    dataQuality: { qualityDistribution: { excellent: 900, good: 0, fair: 0, poor: 0 } },
  };

  const text = generateInsights(health, metrics).map((i) => [
    i.observation, i.businessImpact, i.recommendedAction, i.expectedOutcome, ...(i.evidence || []),
  ].join(' ')).join('\n');

  const leaked = text.match(/\b20\d{2}-\d{2}\b/g);
  assert(!leaked, `raw month keys leaked into insight text: ${leaked && [...new Set(leaked)].join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
