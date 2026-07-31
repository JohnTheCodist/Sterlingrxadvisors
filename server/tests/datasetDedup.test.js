/**
 * Tests for recognising that two uploads carry the same dataset.
 *
 * The rule being protected cuts both ways, and the two directions have very
 * different costs. Failing to recognise a repeat upload duplicates every row,
 * so the owner reads doubled revenue and makes decisions on it. Wrongly
 * declaring two datasets identical DELETES rows the owner meant to keep. The
 * second is worse, so the fingerprint is deliberately blind only to things
 * that change without the data changing — filename, byte layout, row order,
 * column order, cell notation — and sensitive to everything else.
 */

const { computeContentFingerprint, computeFingerprint } = require('../services/datasetRegistry');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const neq = (a, e, m) => { if (a === e) throw new Error(`${m || 'should differ'}: both are ${JSON.stringify(a)}`); };

const sheet = (rows) => ({ Sheet1: rows });
const BASE = [
  { Product: 'Paracetamol 500mg', Qty: 3, Price: 250, Date: '2026-03-01' },
  { Product: 'Amoxicillin 250mg', Qty: 1, Price: 900, Date: '2026-03-02' },
  { Product: 'Vitamin C', Qty: 10, Price: 120, Date: '2026-03-03' },
];
const fp = (rows) => computeContentFingerprint(sheet(rows));

section('The same data is recognised however it arrives');

test('row order does not make it a different dataset', () => {
  eq(fp([...BASE].reverse()), fp(BASE), 'a re-sorted export is the same data');
});

test('column order does not make it a different dataset', () => {
  const reordered = BASE.map((r) => ({ Date: r.Date, Price: r.Price, Qty: r.Qty, Product: r.Product }));
  eq(fp(reordered), fp(BASE));
});

test('a number written as text still matches', () => {
  // Excel re-exports flip cell types constantly; that is not a data change.
  const asText = BASE.map((r) => ({ ...r, Qty: String(r.Qty), Price: ` ${r.Price} ` }));
  eq(fp(asText), fp(BASE));
});

test('a renamed sheet tab is the same dataset', () => {
  eq(computeContentFingerprint({ 'Sales Data': BASE }), computeContentFingerprint({ Sheet1: BASE }));
});

test('a Date object and its ISO string agree', () => {
  const withDates = BASE.map((r) => ({ ...r, Date: new Date(`${r.Date}T00:00:00Z`) }));
  eq(fp(withDates), fp(BASE));
});

test('surrounding whitespace in headers is ignored', () => {
  const padded = BASE.map((r) => ({ ' Product ': r.Product, Qty: r.Qty, Price: r.Price, Date: r.Date }));
  eq(fp(padded), fp(BASE));
});

section('Genuinely different data is never merged');

test('one changed value makes it a different dataset', () => {
  const changed = BASE.map((r, i) => (i === 0 ? { ...r, Qty: 4 } : r));
  neq(fp(changed), fp(BASE), 'a quantity edit must not be silently replaced');
});

test('an extra row makes it a different dataset', () => {
  neq(fp([...BASE, { Product: 'Ibuprofen', Qty: 2, Price: 300, Date: '2026-03-04' }]), fp(BASE));
});

test('a removed row makes it a different dataset', () => {
  neq(fp(BASE.slice(0, 2)), fp(BASE));
});

test('a duplicated row makes it a different dataset', () => {
  // Same distinct values, different totals — must not be treated as identical.
  neq(fp([...BASE, BASE[0]]), fp(BASE));
});

test('case differences are treated as different data, not merged', () => {
  const lowered = BASE.map((r) => ({ ...r, Product: r.Product.toLowerCase() }));
  neq(fp(lowered), fp(BASE), 'deleting rows on a guess is worse than keeping two copies');
});

test('an added column makes it a different dataset', () => {
  neq(fp(BASE.map((r) => ({ ...r, Branch: 'Ikeja' }))), fp(BASE));
});

test('an empty workbook has no content fingerprint to match on', () => {
  eq(computeContentFingerprint({}), null);
  eq(computeContentFingerprint({ Sheet1: [] }), null, 'no rows means nothing to compare');
  eq(computeContentFingerprint(null), null);
});

section('Why the byte fingerprint could not do this job');

test('the same rows under a different filename hash differently by bytes', () => {
  const buf = Buffer.from(JSON.stringify(BASE));
  neq(
    computeFingerprint(buf, 'report.xlsx'),
    computeFingerprint(buf, 'report (1).xlsx'),
    'a repeat download reads as a new dataset — this is the duplication cause',
  );
});

test('...but the content fingerprint sees them as one dataset', () => {
  eq(fp(BASE), fp(BASE), 'filename plays no part');
});

test('a re-export with identical rows but different bytes still matches', () => {
  // Same rows, different serialization — what Excel does on every save.
  const reExported = BASE.map((r) => ({ Qty: Number(r.Qty), Product: r.Product, Date: r.Date, Price: Number(r.Price) }));
  eq(fp(reExported), fp(BASE));
});

section('Multi-sheet workbooks');

test('sheets are compared as a set, not in order', () => {
  const a = { Sales: BASE, Lookup: [{ Code: 'A', Name: 'Alpha' }] };
  const b = { Lookup: [{ Code: 'A', Name: 'Alpha' }], Sales: BASE };
  eq(computeContentFingerprint(a), computeContentFingerprint(b));
});

test('a changed lookup sheet still changes the dataset', () => {
  const a = { Sales: BASE, Lookup: [{ Code: 'A', Name: 'Alpha' }] };
  const b = { Sales: BASE, Lookup: [{ Code: 'A', Name: 'Beta' }] };
  neq(computeContentFingerprint(a), computeContentFingerprint(b));
});

test('a dropped sheet changes the dataset', () => {
  neq(computeContentFingerprint({ Sales: BASE, Lookup: [{ Code: 'A' }] }), computeContentFingerprint({ Sales: BASE }));
});

section('Stability');

test('the same input always produces the same fingerprint', () => {
  eq(fp(BASE), fp(BASE));
  eq(fp(BASE).length, 32, 'fixed width, safe to index');
});

test('blank and missing cells are treated alike', () => {
  const withBlank = BASE.map((r) => ({ ...r, Note: '' }));
  const withNull = BASE.map((r) => ({ ...r, Note: null }));
  eq(fp(withBlank), fp(withNull), 'an empty cell is an empty cell');
});

test('a large file fingerprints in reasonable time', () => {
  const big = Array.from({ length: 6000 }, (_, i) => ({
    Product: `Product ${i}`, Qty: i % 20, Price: 100 + i, Date: '2026-03-01',
  }));
  const t0 = Date.now();
  const got = fp(big);
  const ms = Date.now() - t0;
  eq(got.length, 32);
  assert(ms < 3000, `6,000 rows took ${ms}ms — too slow to sit in the upload path`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
