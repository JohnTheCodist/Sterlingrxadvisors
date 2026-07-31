/**
 * Inventory potential-value widget tests.
 *
 * These widgets are the only ones that can say anything about an inventory
 * snapshot with no sales history, so their arithmetic and — more importantly
 * — their behaviour when prices are partially missing is load-bearing. A
 * missing cost price read as zero would report the entire selling value as
 * profit, which is the most flattering possible lie about a pharmacy.
 */

const registry = require('../services/widgetRegistry');
const WIDGETS = registry.getAll();

let passed = 0;
let failed = 0;
const failures = [];

function section(name) { console.log(`\n=== ${name} ===`); }

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEquals(a, e, msg) {
  if (a !== e) throw new Error(`${msg || 'Value mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertClose(a, e, tol = 0.05, msg) {
  if (a == null || Math.abs(Number(a) - Number(e)) > tol) {
    throw new Error(`${msg || 'Value mismatch'}: expected ~${e}, got ${a}`);
  }
}

const byId = (id) => {
  const w = WIDGETS.find((x) => x.id === id);
  if (!w) throw new Error(`widget '${id}' is not registered`);
  return w;
};

// 3 products, all fully priced.
//   A: cost 100, sell 150, stock 10  → value 1000, revenue 1500, profit  500
//   B: cost 200, sell 260, stock  5  → value 1000, revenue 1300, profit  300
//   C: cost  50, sell  90, stock 20  → value 1000, revenue 1800, profit  800
// totals: value 3000, revenue 4600, profit 1600, margin 1600/4600 = 34.78%
const CLEAN = [
  { product_name: 'A', cost_price: 100, selling_price: 150, current_stock: 10, reorder_level: 15 },
  { product_name: 'B', cost_price: 200, selling_price: 260, current_stock: 5, reorder_level: 4 },
  { product_name: 'C', cost_price: 50, selling_price: 90, current_stock: 20, reorder_level: 25 },
];

section('Potential Revenue');

test('sums selling price x current stock', () => {
  const r = byId('potential-revenue').compute(CLEAN);
  assertEquals(r.value, 4600, 'potential revenue');
});

test('products with no selling price are excluded and disclosed', () => {
  const recs = [...CLEAN, { product_name: 'D', cost_price: 10, current_stock: 100 }];
  const r = byId('potential-revenue').compute(recs);
  assertEquals(r.value, 4600, 'unpriced stock must not be counted');
  assertEquals(r.partialData, true, 'must flag partial data');
  assertEquals(r.totalProducts, 4, 'must count the excluded product');
  assertClose(r.coveragePct, 75, 0.1, 'coverage');
});

test('zero and negative stock contribute nothing', () => {
  const recs = [...CLEAN, { product_name: 'Z', selling_price: 500, current_stock: 0 }];
  const r = byId('potential-revenue').compute(recs);
  assertEquals(r.value, 4600, 'zero stock adds nothing');
});

section('Potential Gross Profit');

test('sums (selling - cost) x stock', () => {
  const r = byId('potential-gross-profit').compute(CLEAN);
  assertEquals(r.value, 1600, 'potential gross profit');
});

test('a missing cost price is NEVER treated as zero cost', () => {
  // If cost were read as 0, this product would add 300 x 50 = 15,000 profit.
  const recs = [...CLEAN, { product_name: 'NoCost', selling_price: 300, current_stock: 50 }];
  const r = byId('potential-gross-profit').compute(recs);
  assertEquals(r.value, 1600, 'unpriced-cost stock must be excluded, not free');
  assertEquals(r.partialCostData, true, 'must disclose');
  assertEquals(r.productsFullyPriced, 3, 'fully priced count');
});

test('products selling below cost are counted and flagged', () => {
  const recs = [...CLEAN, { product_name: 'Loss', cost_price: 100, selling_price: 80, current_stock: 10 }];
  const r = byId('potential-gross-profit').compute(recs);
  assertEquals(r.value, 1400, 'a loss-making line reduces the total');
  assertEquals(r.productsBelowCost, 1, 'must count below-cost lines');
  assertEquals(r.alert, true, 'must raise an alert');
});

section('Potential Margin');

test('margin divides profit by revenue over the SAME products', () => {
  const r = byId('potential-margin').compute(CLEAN);
  assertClose(r.value, 34.8, 0.1, 'margin');
});

test('margin is not diluted by stock whose cost is unknown', () => {
  // The unpriced line adds 15,000 of selling value. If it entered the
  // denominator only, margin would collapse from 34.8% to about 8.2%.
  const recs = [...CLEAN, { product_name: 'NoCost', selling_price: 300, current_stock: 50 }];
  const r = byId('potential-margin').compute(recs);
  assertClose(r.value, 34.8, 0.1, 'margin must stay on the fully-priced basis');
});

test('margin is withheld when too few products are priced', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ product_name: `P${i}`, selling_price: 100, current_stock: 10 });
  many.push({ product_name: 'Priced', cost_price: 50, selling_price: 100, current_stock: 10 });
  const r = byId('potential-margin').compute(many);
  assert(r.error, 'must refuse below the coverage floor');
  assert(/too few/i.test(r.error), 'must explain why');
  assertClose(r.coveragePct, 4.8, 0.1, 'must state the actual coverage');
});

test('carries qualitative bands and an interpretation', () => {
  const r = byId('potential-margin').compute(CLEAN);
  assertEquals(r.ranges.length, 3, 'three bands');
  assertEquals(r.ranges[1].to, 40, 'typical band upper bound');
  assert(/typical/i.test(r.interpretation), 'interpretation should place it against the band');
  assert(r.max >= 60, 'scale must leave headroom');
});

section('Inventory Value Pareto');

test('ranks products by cash tied up, descending', () => {
  const recs = [
    { product_name: 'Big', cost_price: 100, current_stock: 100 },
    { product_name: 'Mid', cost_price: 50, current_stock: 40 },
    { product_name: 'Small', cost_price: 10, current_stock: 10 },
  ];
  const r = byId('inventory-value-pareto').compute(recs);
  assertEquals(r.data[0].label, 'Big', 'largest first');
  assertEquals(r.data[0].value, 10000, 'value');
  assertEquals(r.totalValue, 12100, 'total');
});

test('cumulative share reaches 100 on the last shown product', () => {
  const recs = [
    { product_name: 'A', cost_price: 100, current_stock: 10 },
    { product_name: 'B', cost_price: 100, current_stock: 10 },
  ];
  const r = byId('inventory-value-pareto').compute(recs);
  assertClose(r.data[1].cumulative, 100, 0.1, 'cumulative');
});

test('multiple batch rows of one product are aggregated, not ranked twice', () => {
  const recs = [
    { product_name: 'Split', cost_price: 100, current_stock: 5 },
    { product_name: 'Split', cost_price: 100, current_stock: 5 },
    { product_name: 'Other', cost_price: 100, current_stock: 9 },
  ];
  const r = byId('inventory-value-pareto').compute(recs);
  assertEquals(r.data.length, 2, 'one row per product');
  assertEquals(r.data[0].label, 'Split', 'aggregated product outranks the other');
  assertEquals(r.data[0].value, 1000, 'batches summed');
});

test('states how few products hold 80% of the cash', () => {
  const recs = [
    { product_name: 'Whale', cost_price: 1000, current_stock: 100 },
    { product_name: 'Minnow', cost_price: 1, current_stock: 1 },
  ];
  const r = byId('inventory-value-pareto').compute(recs);
  assert(/1 of 2 products hold 80%/.test(r.insight.title), `unexpected: ${r.insight.title}`);
});

section('Low Stock Items');

test('lists only products at or below reorder level', () => {
  const r = byId('low-stock-items').compute(CLEAN);
  // A: 10 <= 15 (shortfall 5), C: 20 <= 25 (shortfall 5), B: 5 > 4 excluded.
  assertEquals(r.lowStockCount, 2, 'count');
  assert(!r.data.some((d) => d.label === 'B'), 'B is above its reorder level');
});

test('bar value is the shortfall, sorted largest first', () => {
  const recs = [
    { product_name: 'Urgent', current_stock: 0, reorder_level: 50 },
    { product_name: 'Mild', current_stock: 8, reorder_level: 10 },
  ];
  const r = byId('low-stock-items').compute(recs);
  assertEquals(r.data[0].label, 'Urgent', 'largest shortfall first');
  assertEquals(r.data[0].value, 50, 'shortfall');
  assertEquals(r.data[1].value, 2, 'shortfall');
});

test('stockouts are counted separately from low stock', () => {
  const recs = [
    { product_name: 'Out', current_stock: 0, reorder_level: 10 },
    { product_name: 'Low', current_stock: 3, reorder_level: 10 },
  ];
  const r = byId('low-stock-items').compute(recs);
  assertEquals(r.stockouts, 1, 'one product at zero');
  assert(/already out of stock/.test(r.insight.title), 'headline must call out the stockout');
});

test('a healthy inventory says so rather than erroring blankly', () => {
  const recs = [{ product_name: 'Fine', current_stock: 100, reorder_level: 10 }];
  const r = byId('low-stock-items').compute(recs);
  assert(/nothing needs reordering/i.test(r.error), `unexpected: ${r.error}`);
});

test('highlight count focuses the eye on the first few orders', () => {
  const recs = [];
  for (let i = 0; i < 12; i++) recs.push({ product_name: `P${i}`, current_stock: 0, reorder_level: i + 1 });
  const r = byId('low-stock-items').compute(recs);
  assertEquals(r.highlightCount, 5, 'highlight top 5');
});

section('Registration and gating');

test('all five metrics are registered on stock-side dashboards only', () => {
  const ids = ['inventory-value-pareto', 'potential-revenue', 'potential-gross-profit', 'potential-margin', 'low-stock-items'];
  for (const id of ids) {
    const w = byId(id);
    assert(['inventory', 'expiry', 'supplier'].includes(w.dashboard),
      `${id} must live on a stock-side dashboard, not '${w.dashboard}'`);
  }
});

test('each declares exactly the columns its formula needs', () => {
  const expected = {
    'potential-revenue': ['current_stock', 'selling_price'],
    'potential-gross-profit': ['current_stock', 'selling_price', 'cost_price'],
    'potential-margin': ['current_stock', 'selling_price', 'cost_price'],
    'inventory-value-pareto': ['product_name', 'current_stock', 'cost_price'],
    'low-stock-items': ['product_name', 'current_stock', 'reorder_level'],
  };
  for (const [id, fields] of Object.entries(expected)) {
    const got = byId(id).requiredFields.slice().sort();
    assertEquals(got.join(','), fields.slice().sort().join(','), `${id} requiredFields`);
  }
});

test('none of them need sales history', () => {
  const ids = ['inventory-value-pareto', 'potential-revenue', 'potential-gross-profit', 'potential-margin', 'low-stock-items'];
  for (const id of ids) {
    const rf = byId(id).requiredFields;
    assert(!rf.includes('transaction_date'), `${id} must not require a transaction date`);
    assert(!rf.includes('quantity'), `${id} must not require sold quantity`);
  }
});

test('every one returns a clean error on an empty record set', () => {
  const ids = ['inventory-value-pareto', 'potential-revenue', 'potential-gross-profit', 'potential-margin', 'low-stock-items'];
  for (const id of ids) {
    const r = byId(id).compute([]);
    assert(r && typeof r.error === 'string' && r.error.length > 10, `${id} should explain itself on empty input`);
  }
});

test('pre-existing inventory widgets are untouched', () => {
  for (const id of ['stock-value', 'current-stock', 'low-stock-alert', 'inventory-turnover', 'expiry-risk', 'expiry-timeline', 'supplier-breakdown']) {
    byId(id); // throws if missing
  }
  // stock-value must still compute the same way the new widgets do.
  assertEquals(byId('stock-value').compute(CLEAN).value, 3000, 'stock value unchanged');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
