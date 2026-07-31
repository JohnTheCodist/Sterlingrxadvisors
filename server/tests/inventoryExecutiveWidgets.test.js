/**
 * Tests for the risk / operational / strategic inventory metrics and the
 * executive interpretation layer.
 *
 * The interpretation layer is the part worth guarding hardest: every sentence
 * it produces is stated to a pharmacy owner as a fact about their business,
 * so each number inside one must come from the same computation that produced
 * the chart. A note that disagrees with its own widget is worse than no note.
 */

const registry = require('../services/widgetRegistry');
const WIDGETS = registry.getAll();

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const close = (a, e, t = 0.05, m) => { if (a == null || Math.abs(Number(a) - Number(e)) > t) throw new Error(`${m || 'mismatch'}: expected ~${e}, got ${a}`); };
const byId = (id) => { const w = WIDGETS.find((x) => x.id === id); if (!w) throw new Error(`widget '${id}' not registered`); return w; };

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

section('Stock position vs reorder (diverging)');

test('splits products either side of their own reorder level', () => {
  const r = byId('products-below-reorder').compute([
    { product_name: 'Short', current_stock: 5, reorder_level: 20 },
    { product_name: 'Over', current_stock: 50, reorder_level: 20 },
    { product_name: 'Exact', current_stock: 20, reorder_level: 20 },
  ]);
  eq(r.belowCount, 1, 'below'); eq(r.aboveCount, 1, 'above'); eq(r.atLevelCount, 1, 'at level');
  eq(r.data.find((d) => d.label === 'Short').value, -15, 'deficit is negative');
  eq(r.data.find((d) => d.label === 'Over').value, 30, 'surplus is positive');
});

test('data is sorted deficit-first so the axis reads continuously', () => {
  const r = byId('products-below-reorder').compute([
    { product_name: 'A', current_stock: 30, reorder_level: 10 },
    { product_name: 'B', current_stock: 0, reorder_level: 40 },
  ]);
  assert(r.data[0].value < r.data[r.data.length - 1].value, 'ascending by gap');
});

test('note counts match the widget it describes', () => {
  const r = byId('products-below-reorder').compute([
    { product_name: 'A', current_stock: 5, reorder_level: 20 },
    { product_name: 'B', current_stock: 8, reorder_level: 20 },
    { product_name: 'C', current_stock: 99, reorder_level: 20 },
  ]);
  assert(r.executive.insight.includes('2 of 3'), `insight disagrees: ${r.executive.insight}`);
  assert(r.executive.insight.includes('27 units'), `shortfall wrong: ${r.executive.insight}`);
  eq(r.executive.severity, 'high', 'deficits are urgent');
});

section('Expiry value');

test('at-risk counts only stock inside the horizon', () => {
  const r = byId('expiry-risk-value').compute([
    { product_name: 'Soon', current_stock: 10, cost_price: 100, expiry_date: day(30) },
    { product_name: 'Later', current_stock: 10, cost_price: 100, expiry_date: day(300) },
    { product_name: 'Gone', current_stock: 10, cost_price: 100, expiry_date: day(-5) },
  ]);
  eq(r.value, 1000, 'only the 30-day line counts');
});

test('expired value excludes anything still in date', () => {
  const r = byId('expired-inventory-value').compute([
    { product_name: 'Gone', current_stock: 4, cost_price: 250, expiry_date: day(-1) },
    { product_name: 'Fine', current_stock: 100, cost_price: 250, expiry_date: day(1) },
  ]);
  eq(r.value, 1000, 'only past-dated stock');
  eq(r.executive.severity, 'high', 'already-lost money is urgent');
});

test('a clean expiry position says so instead of erroring', () => {
  const r = byId('expired-inventory-value').compute([
    { product_name: 'Fine', current_stock: 10, cost_price: 100, expiry_date: day(200) },
  ]);
  eq(r.value, 0, 'zero');
  eq(r.executive.severity, 'low', 'no alarm when nothing is wrong');
});

test('average days to expiry is weighted by units, not by line', () => {
  // 100 units at 10 days vs 1 unit at 900 days. A plain mean says 455.
  const r = byId('average-days-to-expiry').compute([
    { product_name: 'Bulk', current_stock: 100, expiry_date: day(10) },
    { product_name: 'Single', current_stock: 1, expiry_date: day(900) },
  ]);
  assert(r.value < 30, `weighting failed, got ${r.value}`);
});

section('Overstock');

test('values only the excess above reorder level', () => {
  const r = byId('overstock-value').compute([
    { product_name: 'Over', current_stock: 30, reorder_level: 10, cost_price: 100 },
    { product_name: 'Under', current_stock: 5, reorder_level: 10, cost_price: 100 },
  ]);
  eq(r.data.length, 1, 'only overstocked lines');
  eq(r.data[0].value, 2000, '(30-10) x 100');
});

section('Strategic allocation');

test('inventory by category sums stock at cost', () => {
  const r = byId('inventory-by-category').compute([
    { category: 'A', current_stock: 10, cost_price: 100 },
    { category: 'A', current_stock: 5, cost_price: 100 },
    { category: 'B', current_stock: 1, cost_price: 100 },
  ]);
  eq(r.data[0].label, 'A'); eq(r.data[0].value, 1500); eq(r.totalValue, 1600);
});

test('supplier concentration reports the top share honestly', () => {
  const r = byId('supplier-concentration').compute([
    { supplier: 'Big', current_stock: 90, cost_price: 100 },
    { supplier: 'Small', current_stock: 10, cost_price: 100 },
  ]);
  close(r.topSupplierSharePct, 90, 0.1, 'share');
  eq(r.topSupplier, 'Big');
  assert(/single point of failure/.test(r.executive.action), 'concentration should warn');
});

test('spread supply does not raise a concentration warning', () => {
  const r = byId('supplier-concentration').compute([
    { supplier: 'A', current_stock: 10, cost_price: 100 },
    { supplier: 'B', current_stock: 10, cost_price: 100 },
    { supplier: 'C', current_stock: 10, cost_price: 100 },
  ]);
  eq(r.executive.severity, 'info', 'no alarm when spread');
});

test('margin by product flags below-cost lines', () => {
  const r = byId('margin-by-product').compute([
    { product_name: 'Good', cost_price: 50, selling_price: 100 },
    { product_name: 'Loss', cost_price: 100, selling_price: 90 },
  ]);
  eq(r.negativeMarginCount, 1, 'one below cost');
  eq(r.executive.severity, 'high', 'below-cost pricing is urgent');
  eq(r.data.find((d) => d.label === 'Good').value, 50, 'margin %');
});

test('margin by category weights by stock, not by line count', () => {
  // One tiny high-margin line should not outweigh a large low-margin one.
  const r = byId('margin-by-category').compute([
    { category: 'X', cost_price: 10, selling_price: 100, current_stock: 1 },
    { category: 'X', cost_price: 95, selling_price: 100, current_stock: 1000 },
  ]);
  assert(r.data[0].value < 20, `weighting failed, got ${r.data[0].value}`);
});

section('Operational performance');

test('dead stock is stock that sold nothing at all', () => {
  const r = byId('dead-stock-value').compute([
    { product_name: 'Dead', current_stock: 10, cost_price: 500, quantity: 0 },
    { product_name: 'Alive', current_stock: 10, cost_price: 500, quantity: 3 },
  ]);
  eq(r.productCount, 1, 'one dead line');
  eq(r.deadStockValue, 5000, 'valued at cost');
  assert(!r.data.some((d) => d.label === 'Alive'), 'a product that sold is not dead');
});

test('stock coverage divides stock by the observed daily rate', () => {
  // 60 sold over 30 days = 2/day; 100 in stock = 50 days cover.
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push({ product_name: 'P', quantity: 2, current_stock: 100, transaction_date: day(-i) });
  const r = byId('stock-coverage-days').compute(recs);
  eq(r.periodDays, 30, 'period');
  close(r.data[0].value, 50, 1, 'days of cover');
});

test('slow movers rank by fewest units sold', () => {
  const r = byId('slow-moving-products').compute([
    { product_name: 'Fast', quantity: 500 },
    { product_name: 'Slow', quantity: 1 },
  ]);
  eq(r.data[0].label, 'Slow', 'slowest first');
  eq(r.slowestProduct, 'Slow');
});

section('Executive interpretation contract');

test('every note carries an insight, an action and a severity', () => {
  const cases = [
    ['products-below-reorder', [{ product_name: 'A', current_stock: 1, reorder_level: 9 }]],
    ['expiry-risk-value', [{ product_name: 'A', current_stock: 5, cost_price: 10, expiry_date: day(10) }]],
    ['expired-inventory-value', [{ product_name: 'A', current_stock: 5, cost_price: 10, expiry_date: day(-10) }]],
    ['average-days-to-expiry', [{ product_name: 'A', current_stock: 5, expiry_date: day(100) }]],
    ['overstock-value', [{ product_name: 'A', current_stock: 50, reorder_level: 5, cost_price: 10 }]],
    ['inventory-by-category', [{ category: 'C', current_stock: 5, cost_price: 10 }]],
    ['supplier-concentration', [{ supplier: 'S', current_stock: 5, cost_price: 10 }]],
    ['margin-by-product', [{ product_name: 'A', cost_price: 5, selling_price: 10 }]],
    ['margin-by-category', [{ category: 'C', cost_price: 5, selling_price: 10, current_stock: 3 }]],
    ['slow-moving-products', [{ product_name: 'A', quantity: 2 }]],
    ['dead-stock-value', [{ product_name: 'A', current_stock: 5, cost_price: 10, quantity: 0 }]],
  ];
  for (const [id, recs] of cases) {
    const r = byId(id).compute(recs);
    assert(r.executive, `${id} produced no executive note`);
    assert(r.executive.insight && r.executive.insight.length > 15, `${id} insight too thin`);
    assert(r.executive.action && r.executive.action.length > 15, `${id} action too thin`);
    assert(['high', 'medium', 'low', 'info'].includes(r.executive.severity), `${id} bad severity`);
  }
});

test('notes never contain unrendered placeholders or NaN', () => {
  const r = byId('overstock-value').compute([{ product_name: 'A', current_stock: 50, reorder_level: 5, cost_price: 10 }]);
  const text = `${r.executive.insight} ${r.executive.action}`;
  assert(!/NaN|undefined|null|\$\{/.test(text), `leaked value: ${text}`);
});

section('Sections and gating');

test('every stock-side widget belongs to one of the four sections', () => {
  const SECTIONS = ['Financial Health', 'Inventory Risk', 'Operational Performance', 'Strategic Allocation'];
  const stock = WIDGETS.filter((w) => ['inventory', 'expiry', 'supplier'].includes(w.dashboard));
  for (const w of stock) {
    assert(SECTIONS.includes(w.section), `${w.id} has section '${w.section}'`);
  }
  assert(stock.length >= 25, `expected the full stock-side set, got ${stock.length}`);
});

test('sales-requiring metrics declare the sales columns they need', () => {
  for (const id of ['slow-moving-products', 'dead-stock-value', 'stock-coverage-days']) {
    assert(byId(id).requiredFields.includes('quantity'), `${id} must require quantity`);
  }
  assert(byId('stock-coverage-days').requiredFields.includes('transaction_date'), 'coverage needs dates');
});

test('stock-only metrics never require sales columns', () => {
  for (const id of ['products-below-reorder', 'expiry-risk-value', 'expired-inventory-value',
    'average-days-to-expiry', 'overstock-value', 'inventory-by-category',
    'supplier-concentration', 'margin-by-product', 'margin-by-category']) {
    const rf = byId(id).requiredFields;
    assert(!rf.includes('quantity'), `${id} must not require sold quantity`);
    assert(!rf.includes('transaction_date'), `${id} must not require a transaction date`);
  }
});

test('no widget requires a field the upload pipeline cannot produce', () => {
  const { FIELD_ALIASES } = require('../services/widgetEngine');
  const known = new Set(Object.keys(FIELD_ALIASES));
  for (const w of WIDGETS) {
    for (const f of w.requiredFields || []) {
      assert(known.has(f), `${w.id} requires '${f}', which the widget engine cannot detect`);
    }
  }
});

test('every one returns a clean error on empty input', () => {
  for (const id of ['products-below-reorder', 'expiry-risk-value', 'expired-inventory-value',
    'average-days-to-expiry', 'overstock-value', 'inventory-by-category', 'supplier-concentration',
    'margin-by-product', 'margin-by-category', 'slow-moving-products', 'dead-stock-value', 'stock-coverage-days']) {
    const r = byId(id).compute([]);
    assert(r && (typeof r.error === 'string' || r.executive), `${id} should explain itself on empty input`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
