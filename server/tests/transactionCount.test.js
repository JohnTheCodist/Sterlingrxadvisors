/**
 * Tests for counting transactions rather than rows.
 *
 * "848 transactions" is read by an owner as 848 customers, and the average
 * basket beside it as what each of them spent. Both are wrong the moment a
 * file writes one line per ITEM instead of one line per sale: a four-drug
 * basket becomes four customers spending a quarter as much each. The figure
 * looks entirely plausible while being off by the average basket size.
 *
 * The first duty of these tests is the boring one — a file with NO receipt
 * numbers must produce exactly the number it produced before, because that is
 * every file already uploaded.
 */

const { calculateMetrics } = require('../services/analytics');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

const row = (over = {}) => ({
  product_name: 'Paracetamol 500mg',
  quantity: 1,
  selling_price: 1000,
  transaction_date: '2026-03-01',
  ...over,
});

section('A file with no receipt numbers behaves exactly as before');

test('every revenue-bearing row still counts as one transaction', () => {
  const recs = Array.from({ length: 848 }, () => row());
  const m = calculateMetrics(recs);
  eq(m.transactionCount, 848, 'unchanged from the old row count');
  eq(m.transactionBasis, 'rows', 'and says so');
});

test('rows with no revenue are still excluded, as before', () => {
  const m = calculateMetrics([row(), row({ selling_price: 0, quantity: 0 }), row()]);
  eq(m.transactionCount, 2, 'a zero-revenue row is not a sale');
});

test('average transaction value is unchanged when there are no receipts', () => {
  const m = calculateMetrics([row({ selling_price: 500 }), row({ selling_price: 1500 })]);
  eq(m.transactionCount, 2);
  eq(m.averageTransactionValue, 1000, '2000 over 2 rows');
});

test('an empty file reports zero on the same shape', () => {
  const m = calculateMetrics([]);
  eq(m.transactionCount, 0);
  eq(m.transactionBasis, 'rows');
});

section('Line items collapse into the receipt that carried them');

test('a four-item basket is one transaction, not four', () => {
  const basket = ['Paracetamol', 'Amoxicillin', 'Vitamin C', 'Flagyl']
    .map((p) => row({ product_name: p, invoice_number: 'INV-001', selling_price: 250 }));
  const m = calculateMetrics(basket);
  eq(m.transactionCount, 1, 'one receipt');
  eq(m.transactionBasis, 'receipts');
  eq(m.totalRevenue, 1000, 'revenue is unaffected — only the divisor changed');
  eq(m.averageTransactionValue, 1000, 'the whole basket, not a quarter of it');
});

test('separate receipts stay separate', () => {
  const m = calculateMetrics([
    row({ invoice_number: 'INV-001' }), row({ invoice_number: 'INV-001' }),
    row({ invoice_number: 'INV-002' }),
  ]);
  eq(m.transactionCount, 2);
  eq(m.rowsGroupedIntoReceipts, 3, 'all three rows were grouped');
  eq(m.receiptCount, 2);
});

test('the field is read under either name the pipeline uses', () => {
  // The normalizer emits invoice_number; the sale table calls it invoice_ref.
  const a = calculateMetrics([row({ invoice_number: 'X1' }), row({ invoice_number: 'X1' })]);
  const b = calculateMetrics([row({ invoice_ref: 'X1' }), row({ invoice_ref: 'X1' })]);
  eq(a.transactionCount, 1, 'invoice_number');
  eq(b.transactionCount, 1, 'invoice_ref');
});

test('blank and whitespace-only receipt numbers count as absent', () => {
  const m = calculateMetrics([
    row({ invoice_number: '' }), row({ invoice_number: '   ' }), row({ invoice_number: null }),
  ]);
  eq(m.transactionCount, 3, 'each is its own sale, not one empty-string receipt');
  eq(m.transactionBasis, 'rows');
});

section('Files that mix the two');

test('rows without a receipt still count singly alongside grouped ones', () => {
  const m = calculateMetrics([
    row({ invoice_number: 'INV-001' }), row({ invoice_number: 'INV-001' }),
    row(), row(),
  ]);
  eq(m.transactionCount, 3, 'one receipt plus two ungrouped rows');
  eq(m.transactionBasis, 'receipts');
  eq(m.rowsGroupedIntoReceipts, 2, 'only two rows were grouped — reported honestly');
});

section('Tills that restart numbering every morning');

test('the same receipt number on two days is two transactions', () => {
  // A till resetting to 0001 each morning would otherwise fold a month of
  // sales into one transaction and report a colossal average basket.
  const m = calculateMetrics([
    row({ invoice_number: '0001', transaction_date: '2026-03-01' }),
    row({ invoice_number: '0001', transaction_date: '2026-03-02' }),
    row({ invoice_number: '0001', transaction_date: '2026-03-03' }),
  ]);
  eq(m.transactionCount, 3, 'one per day');
});

test('the same receipt number within one day is still one transaction', () => {
  const m = calculateMetrics([
    row({ invoice_number: '0001', transaction_date: '2026-03-01T09:15:00Z' }),
    row({ invoice_number: '0001', transaction_date: '2026-03-01T09:15:00Z' }),
  ]);
  eq(m.transactionCount, 1, 'same receipt, same day');
});

test('a timestamp and a bare date on one receipt do not split it', () => {
  const m = calculateMetrics([
    row({ invoice_number: 'INV-9', transaction_date: '2026-03-01' }),
    row({ invoice_number: 'INV-9', transaction_date: '2026-03-01T14:32:00Z' }),
  ]);
  eq(m.transactionCount, 1, 'keyed on the day, not the exact instant');
});

section('Everything else is untouched');

test('revenue, quantity and margin do not move when receipts are grouped', () => {
  const rows = [
    row({ invoice_number: 'A', selling_price: 1000, cost_price: 600, quantity: 2 }),
    row({ invoice_number: 'A', selling_price: 500, cost_price: 300, quantity: 1 }),
  ];
  const grouped = calculateMetrics(rows);
  const ungrouped = calculateMetrics(rows.map(({ invoice_number, ...r }) => r));
  eq(grouped.totalRevenue, ungrouped.totalRevenue, 'revenue identical');
  eq(grouped.totalQuantitySold, ungrouped.totalQuantitySold, 'units identical');
  eq(grouped.grossProfit, ungrouped.grossProfit, 'profit identical');
  eq(grouped.grossMargin, ungrouped.grossMargin, 'margin identical');
  eq(grouped.recordCount, ungrouped.recordCount, 'row count still reports rows');
  assert(grouped.transactionCount < ungrouped.transactionCount, 'only the transaction count changes');
});

section('The chart agrees with the headline');

const { monthlyTransactionCount, dailyTransactionCount, weeklyTransactionCount } = require('../services/analytics');

test('a receipt-free file gives the same per-period counts as before', () => {
  const recs = [
    row({ transaction_date: '2026-03-01' }), row({ transaction_date: '2026-03-01' }),
    row({ transaction_date: '2026-04-02' }),
  ];
  eq(JSON.stringify(monthlyTransactionCount(recs)),
    JSON.stringify([{ month: '2026-03', count: 2 }, { month: '2026-04', count: 1 }]));
});

test('per-period counts group receipts too', () => {
  const recs = [
    row({ invoice_number: 'A', transaction_date: '2026-03-01' }),
    row({ invoice_number: 'A', transaction_date: '2026-03-01' }),
    row({ invoice_number: 'B', transaction_date: '2026-03-02' }),
  ];
  eq(monthlyTransactionCount(recs)[0].count, 2, 'two receipts in March, not three rows');
  eq(dailyTransactionCount(recs).length, 2, 'split across two days');
  eq(dailyTransactionCount(recs)[0].count, 1, 'the two-line basket is one sale');
});

test('the periods sum to the headline figure', () => {
  // A dashboard whose chart does not add up to its own headline reads as
  // broken regardless of which number is right.
  const recs = [
    row({ invoice_number: 'A', transaction_date: '2026-03-01' }),
    row({ invoice_number: 'A', transaction_date: '2026-03-01' }),
    row({ invoice_number: 'B', transaction_date: '2026-03-02' }),
    row({ transaction_date: '2026-04-05' }),
  ];
  const headline = calculateMetrics(recs).transactionCount;
  const charted = monthlyTransactionCount(recs).reduce((a, r) => a + r.count, 0);
  const weekly = weeklyTransactionCount(recs).reduce((a, r) => a + r.count, 0);
  eq(charted, headline, 'monthly chart sums to the headline');
  eq(weekly, headline, 'weekly chart sums to the headline');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
