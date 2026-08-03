/**
 * Tests for Business Health scoring pillars it has no data for.
 *
 * Reported: on a sales-only upload, Inventory Health was visibly dragging the
 * overall score down. Cause: `assessed` was hardcoded `true` for Sales,
 * Profitability, Inventory and Operations — only Customer Health ever
 * reported that it could not be measured. So every inventory metric returned
 * 0/'critical' for want of stock data ("No inventory data available",
 * "Stock-level data not available") and the pillar's full 25% weight landed on
 * the overall score as though the pharmacy were failing at inventory
 * management, when it had simply never uploaded a stock file.
 *
 * The rule these pin: a pillar is scored only when its data exists, and the
 * weight of any pillar that cannot be measured is redistributed across the
 * ones that can — so the score reflects what is actually known, and adding an
 * inventory file later changes the score because of what it SAYS, not merely
 * because it exists.
 */

const { scoreBusinessHealth, PILLARS } = require('../services/businessHealth');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const near = (a, e, tol, m) => { if (Math.abs(a - e) > tol) throw new Error(`${m || 'mismatch'}: expected ~${e} (±${tol}), got ${a}`); };

const HEALTH = {
  dataCompleteness: { productName: 100, quantity: 100, revenue: 100, date: 100 },
  qualityDistribution: { excellent: 3077, good: 0, fair: 0, poor: 0 },
  pipelineStages: { uploadedRows: 3077, structurallyValidRows: 3077 },
  productRecognition: { recognizedCount: 20, unknownCount: 0, recognitionRate: 100 },
};

/** A healthy, growing sales-only dataset — nothing wrong with this pharmacy. */
function salesMetrics() {
  return {
    overview: {
      totalRevenue: 53019500, grossProfit: 15905850, grossMargin: 30, hasCostData: true,
      transactionCount: 3077, averageTransactionValue: 17232,
      totalQuantitySold: 12000, averageSellingPrice: 4418,
    },
    products: {
      allProducts: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, revenue: 2650975, margin: 30, quantity: 600 })),
      totalDistinctProducts: 20,
    },
    trends: {
      months: [
        { month: '2026-05', revenue: 17000000, quantity: 4000, transactions: 1000, profit: 5100000, margin: 30 },
        { month: '2026-06', revenue: 18000000, quantity: 4000, transactions: 1030, profit: 5400000, margin: 30 },
        { month: '2026-07', revenue: 18019500, quantity: 4000, transactions: 1047, profit: 5405850, margin: 30 },
      ],
    },
    health: HEALTH,
  };
}

const REAL_INVENTORY = {
  hasInventoryData: true, turnoverRatio: 2.5,
  deadStockCount: 2, deadStockPct: 10, nearExpiryCount: 1, nearExpiryPct: 5,
  lowStockCount: 1, overstockCount: 2, overstockPct: 10,
  totalProducts: 20, activeProducts: 18,
};
const NO_INVENTORY = { hasInventoryData: false };
const NO_CUSTOMER = { hasCustomerData: false };

const pillarNamed = (r, needle) => r.pillars.find((p) => p.name.includes(needle));

section('Sales-only upload: inventory is not scored');

test('the Inventory pillar reports it could not be assessed', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  const inv = pillarNamed(r, 'Inventory');
  eq(inv.assessed, false, 'inventory must not claim to be assessed without stock data');
  assert(inv.notAssessedReason, 'the owner should be told why it was skipped');
});

test('the Inventory pillar contributes ZERO weight — the reported drag', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  eq(pillarNamed(r, 'Inventory').adjustedWeight, 0,
    'a pillar with no data must carry no weight, or its 0 score drags the total');
});

test('the overall score equals the weighted average of ONLY the assessed pillars', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  const assessed = r.pillars.filter((p) => p.assessed);
  const total = assessed.reduce((s, p) => s + p.adjustedWeight, 0);
  const expected = assessed.reduce((s, p) => s + p.score * p.adjustedWeight, 0) / total;
  near(r.overallScore, expected, 0.15, 'overall score must be the assessed pillars only');
});

test('a pharmacy with no inventory file is not rated below its own sales performance', () => {
  // The symptom as the owner experienced it: good sales, score dragged down
  // by a pillar measuring nothing.
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  const sales = pillarNamed(r, 'Sales');
  assert(r.overallScore >= sales.score,
    `overall (${r.overallScore}) fell below sales performance (${sales.score}) with nothing else scoring badly`);
});

section('Redistributed weight still totals 100');

test('assessed weights sum to 100 when inventory and customer are both missing', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  const total = r.pillars.reduce((s, p) => s + p.adjustedWeight, 0);
  near(total, 100, 0.5, 'weights must still total 100 after redistribution');
});

test('freed weight is shared in proportion to each pillar’s original weight', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  const sales = pillarNamed(r, 'Sales');
  const profit = pillarNamed(r, 'Profitability');
  const ops = pillarNamed(r, 'Operational');
  // Sales and Profitability start equal (25 each), so they must stay equal.
  near(sales.adjustedWeight, profit.adjustedWeight, 0.2, 'equal-weight pillars must gain equally');
  // Operations starts at 10 vs Sales 25, so it must gain less.
  assert(ops.adjustedWeight < sales.adjustedWeight, 'a lighter pillar must not overtake a heavier one');
});

test('rounding drift in redistribution does not scale the score', () => {
  // Shares rounded to 1dp can sum to 100.1; dividing by a hardcoded 100 would
  // inflate every score slightly.
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  assert(r.overallScore <= 100 && r.overallScore >= 0, `score out of range: ${r.overallScore}`);
});

section('Both uploaded: inventory counts again');

test('with real stock data the Inventory pillar is assessed and weighted', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: REAL_INVENTORY, customerStats: NO_CUSTOMER });
  const inv = pillarNamed(r, 'Inventory');
  eq(inv.assessed, true, 'inventory must be scored once its data exists');
  assert(inv.adjustedWeight > 0, 'an assessed pillar must carry weight');
});

test('adding an inventory file changes the score by what it SAYS, not merely by existing', () => {
  const withoutInv = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  const withInv = scoreBusinessHealth(salesMetrics(), { inventoryStats: REAL_INVENTORY, customerStats: NO_CUSTOMER });
  const invScore = pillarNamed(withInv, 'Inventory').score;
  // This dataset's inventory scores below the sales-only average, so the
  // overall should move DOWN — driven by the real figure, not by a zero.
  assert(invScore > 0, 'real inventory data should produce a real score');
  assert(withInv.overallScore !== withoutInv.overallScore, 'adding data should move the score');
  const direction = invScore < withoutInv.overallScore ? 'down' : 'up';
  assert(direction === 'down' ? withInv.overallScore < withoutInv.overallScore
    : withInv.overallScore > withoutInv.overallScore,
  `score moved the wrong way: inventory scored ${invScore} against a base of ${withoutInv.overallScore}`);
});

section('Conservative when the signal is absent entirely');

test('no inventoryStats at all still scores as before — absence is only concluded from an explicit flag', () => {
  // Some callers never compute inventoryStats. Silently dropping a quarter of
  // the score there would be a second, quieter bug.
  const r = scoreBusinessHealth(salesMetrics(), { customerStats: NO_CUSTOMER });
  eq(pillarNamed(r, 'Inventory').assessed, true,
    'without an explicit hasInventoryData:false, the pillar must still be scored');
});

section('Customer redistribution still works');

test('customerRedistributed is still reported for the dashboard card', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: REAL_INVENTORY, customerStats: NO_CUSTOMER });
  eq(r.customerRedistributed, true, 'the existing dashboard flag must keep working');
  eq(pillarNamed(r, 'Customer').adjustedWeight, 0);
});

test('every pillar is scored when all data is present', () => {
  const r = scoreBusinessHealth(salesMetrics(), {
    inventoryStats: REAL_INVENTORY,
    customerStats: { hasCustomerData: true, repeatCustomerRate: 40, customerGrowthRate: 5, avgCustomerSpend: 17000, avgPurchaseFrequency: 2.5, totalCustomers: 500, newCustomers: 100, returningCustomers: 400 },
  });
  eq(r.pillars.filter((p) => p.assessed).length, PILLARS.length, 'all five pillars should be assessed');
  eq(r.unassessedPillars.length, 0);
  near(r.pillars.reduce((s, p) => s + p.adjustedWeight, 0), 100, 0.5);
});

test('unassessedPillars names what was skipped and why', () => {
  const r = scoreBusinessHealth(salesMetrics(), { inventoryStats: NO_INVENTORY, customerStats: NO_CUSTOMER });
  eq(r.unassessedPillars.length, 2);
  for (const u of r.unassessedPillars) assert(u.reason, `${u.name} was skipped with no reason given`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
