/**
 * Business Modeling Engine tests.
 *
 * The engine's only data dependencies are two validated queries, so they are
 * stubbed here and the arithmetic is verified directly. That is deliberate:
 * these tests must prove the MODELLING is correct, not that Postgres works.
 *
 * Also asserts the additive-upgrade contract — that registering the modeling
 * tools did not remove or rename any tool that existed before.
 */

const queries = require('../services/advisorQueries');

// ---- tiny harness ----------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function section(name) { console.log(`\n=== ${name} ===`); }

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Value mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Projections are floating point — compare within a tolerance. */
function assertClose(actual, expected, tol = 0.01, msg) {
  if (actual == null || Math.abs(Number(actual) - Number(expected)) > tol) {
    throw new Error(`${msg || 'Value mismatch'}: expected ~${expected}, got ${actual}`);
  }
}

// ---- stubbing --------------------------------------------------------------

const SALES_BASELINE = {
  scope: 'current',
  scopeNote: 'Covers the current upload (test.xlsx) only.',
  totalRevenue: 1000000,
  grossProfit: 250000,
  grossMargin: 25,
  totalCost: 750000,
  totalQuantitySold: 5000,
  transactionCount: 1000,
  averageTransactionValue: 1000,
  periodStart: '2026-01-01',
  periodEnd: '2026-03-31',
  monthsWithData: 3,
  datasetCount: 1,
  sources: [],
  costCoverage: { hasReliableCostCoverage: true, rowsPct: 100, revenuePct: 100 },
};

function stubSales(overrides = {}) {
  queries.getRevenueProfitSummary = async () => ({ ...SALES_BASELINE, ...overrides });
  queries.getDatasetMetric = async () => ({ available: false });
}

function stubInventoryOnly() {
  // Sales side reports an empty current upload; stock side has figures.
  queries.getRevenueProfitSummary = async () => ({ ...SALES_BASELINE, transactionCount: 0, totalRevenue: 0 });
  queries.getDatasetMetric = async (_org, { measure }) => {
    const values = { potential_revenue: 4000000, potential_gross_profit: 1200000, potential_margin_pct: 30 };
    return { available: true, value: values[measure] ?? null, measure };
  };
}

function stubScopeGate() {
  queries.getRevenueProfitSummary = async () => ({
    availableInCurrentUpload: false,
    availableHistorically: true,
    currentUpload: 'stock-only.xlsx',
    reason: 'The current upload has no sales transaction data.',
  });
  queries.getDatasetMetric = async () => ({ available: false });
}

// Engine is required AFTER the stub helpers exist; it resolves
// queries.<fn> at call time, so per-test restubbing takes effect.
const modeling = require('../services/advisor/businessModelingEngine');

// ---- tests -----------------------------------------------------------------

(async () => {
  section('modelGoal — revenue');

  await test('gap and multiple are computed from the validated baseline', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    assertEquals(r.available, true, 'should be available');
    assertEquals(r.gap.absolute, 1000000, 'gap');
    assertEquals(r.gap.pct, 100, 'gap pct');
    assertEquals(r.gap.multiple, 2, 'multiple');
    assertEquals(r.currentState.revenue, 1000000, 'baseline revenue');
    assertEquals(r.currentState.confidence, 'fact', 'baseline is fact');
  });

  await test('transaction lever holds basket and sizes the volume needed', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    const opt = r.options.find((o) => o.id === 'more_transactions');
    assertEquals(opt.requiredValue, 2000, 'required transactions');
    assertEquals(opt.changeAbsolute, 1000, 'extra transactions');
    assertEquals(opt.changePct, 100, 'change pct');
    assertEquals(opt.confidence, 'scenario', 'projection is a scenario');
    assert(opt.assumptions.length > 0, 'must carry assumptions');
  });

  await test('per-day figure uses the real period length, not a guess', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    const opt = r.options.find((o) => o.id === 'more_transactions');
    // 2026-01-01..2026-03-31 inclusive = 90 days; 1000 extra / 90.
    assertEquals(r.currentState.periodDays, 90, 'period days');
    assertClose(opt.perDay, 11.1, 0.05, 'extra per day');
  });

  await test('basket lever holds transaction count', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    const opt = r.options.find((o) => o.id === 'bigger_basket');
    assertEquals(opt.requiredValue, 2000, 'required ATV');
    assertEquals(opt.changePct, 100, 'ATV uplift pct');
  });

  await test('blended lever splits the multiplier so neither driver doubles', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    const opt = r.options.find((o) => o.id === 'blended');
    // sqrt(2) - 1 = 41.42%
    assertClose(opt.transactions.changePct, 41.4, 0.1, 'blended transaction growth');
    assertClose(opt.basket.changePct, 41.4, 0.1, 'blended basket growth');
    // The whole point: gentler than either lever alone.
    assert(opt.transactions.changePct < 100, 'blended must be gentler than a single lever');
  });

  await test('a target already met is reported as met, not as a negative plan', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 500000 });
    assertEquals(r.objective.reached, true, 'reached');
    assertEquals(r.gap.direction, 'already_met', 'direction');
    assertEquals(r.confidence, 'fact', 'no projection involved');
  });

  section('modelGoal — profit');

  await test('revenue lever solves target at the current margin', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'profit', target: 500000 });
    const opt = r.options.find((o) => o.id === 'grow_revenue');
    // 500,000 / 0.25 = 2,000,000
    assertEquals(opt.requiredValue, 2000000, 'required revenue');
    assertEquals(opt.changeAbsolute, 1000000, 'extra revenue');
  });

  await test('margin lever solves target at the current revenue', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'profit', target: 500000 });
    const opt = r.options.find((o) => o.id === 'improve_margin');
    assertEquals(opt.requiredValue, 50, 'required margin pct');
    assertEquals(opt.changePercentagePoints, 25, 'pp uplift');
  });

  await test('profit goal is refused — naming cost coverage — when margin was withheld', async () => {
    stubSales({ grossProfit: null, grossMargin: null, totalCost: null,
      costCoverage: { hasReliableCostCoverage: false, rowsPct: 4, revenuePct: 3 } });
    const r = await modeling.modelGoal('org', { metric: 'profit', target: 500000 });
    assertEquals(r.available, false, 'must not model on a withheld margin');
    assert(/cost price/i.test(JSON.stringify(r.missing)), 'must name cost prices as missing');
    assertEquals(r.costCoverage.rowsPct, 4, 'must pass the coverage detail through');
  });

  section('modelScenario');

  await test('price rise lifts revenue and profit but leaves cost alone', async () => {
    stubSales();
    const r = await modeling.modelScenario('org', { lever: 'price', changePct: 10 });
    assertEquals(r.projected.revenue, 1100000, 'revenue');
    // Cost held at 750k, so the whole 100k uplift is profit.
    assertEquals(r.projected.grossProfit, 350000, 'profit');
    assertClose(r.projected.grossMarginPct, 31.8, 0.1, 'margin');
    assert(r.projected.grossMarginDeltaPoints > 0, 'margin must improve');
  });

  await test('price scenario states the zero-elasticity assumption', async () => {
    stubSales();
    const r = await modeling.modelScenario('org', { lever: 'price', changePct: 10 });
    assert(/volume is completely unchanged/i.test(r.assumptions.join(' ')),
      'must disclose that volume is assumed unchanged');
  });

  await test('volume growth scales cost too, leaving margin flat', async () => {
    stubSales();
    const r = await modeling.modelScenario('org', { lever: 'volume', changePct: 20 });
    assertEquals(r.projected.revenue, 1200000, 'revenue');
    assertEquals(r.projected.grossProfit, 300000, 'profit');
    assertClose(r.projected.grossMarginPct, 25, 0.01, 'margin unchanged');
    assertEquals(r.projected.grossMarginDeltaPoints, 0, 'no margin movement');
  });

  await test('cost rise erodes profit while revenue holds', async () => {
    stubSales();
    const r = await modeling.modelScenario('org', { lever: 'cost', changePct: 15 });
    assertEquals(r.projected.revenue, 1000000, 'revenue held');
    // 750,000 * 1.15 = 862,500 → profit 137,500
    assertEquals(r.projected.grossProfit, 137500, 'profit');
    assert(r.projected.grossMarginDeltaPoints < 0, 'margin must fall');
  });

  await test('unknown cost yields the revenue effect only — never profit-as-revenue', async () => {
    stubSales({ grossProfit: null, grossMargin: null, totalCost: null });
    const r = await modeling.modelScenario('org', { lever: 'price', changePct: 10 });
    assertEquals(r.profitEffectAvailable, false, 'profit effect unavailable');
    assertEquals(r.projected.revenue, 1100000, 'revenue effect still given');
    assertEquals(r.projected.grossProfit, null, 'profit must be null, not the revenue delta');
    assert(/cost price/i.test(r.profitEffectNote), 'must explain why');
  });

  section('Inventory-only uploads');

  await test('goal models against potential revenue from stock on hand', async () => {
    stubInventoryOnly();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 5000000 });
    assertEquals(r.available, true, 'available');
    assertEquals(r.basis, 'inventory_snapshot', 'basis');
    assertEquals(r.currentState.potentialRevenue, 4000000, 'potential revenue');
    assertEquals(r.gap.absolute, 1000000, 'gap');
    assert(/every unit of current stock sells/i.test(r.assumptions.join(' ')),
      'must state the sell-through assumption');
  });

  await test('scenario declines on an inventory snapshot but points at the stock figures', async () => {
    stubInventoryOnly();
    const r = await modeling.modelScenario('org', { lever: 'price', changePct: 10 });
    assertEquals(r.available, false, 'no sales history to simulate against');
    assertEquals(r.potentialRevenue, 4000000, 'offers the stock-side figure instead');
  });

  section('Scope discipline');

  await test('the existing current-upload gate passes straight through', async () => {
    stubScopeGate();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    assertEquals(r.availableInCurrentUpload, false, 'gate preserved');
    assertEquals(r.availableHistorically, true, 'history flag preserved');
    assert(!r.options, 'must not model past the gate');
  });

  await test('scope defaults to current, never all', async () => {
    let seen = null;
    queries.getRevenueProfitSummary = async (_o, args) => { seen = args.scope; return SALES_BASELINE; };
    queries.getDatasetMetric = async () => ({ available: false });
    await modeling.modelGoal('org', { metric: 'revenue', target: 2000000 });
    assertEquals(seen, 'current', 'must default to the current upload');
  });

  section('Input validation');

  await test('unknown metric is rejected with the supported list', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'footfall', target: 100 });
    assert(/Unknown metric/.test(r.error), 'should name the problem');
    assert(/revenue/.test(r.error), 'should list valid metrics');
  });

  await test('unknown lever is rejected with the supported list', async () => {
    stubSales();
    const r = await modeling.modelScenario('org', { lever: 'weather', changePct: 10 });
    assert(/Unknown lever/.test(r.error), 'should name the problem');
    assert(/price/.test(r.error), 'should list valid levers');
  });

  await test('a non-positive target is rejected', async () => {
    stubSales();
    const r = await modeling.modelGoal('org', { metric: 'revenue', target: 0 });
    assert(/positive number/.test(r.error), 'should reject');
  });

  await test('a change of -100% or worse is rejected', async () => {
    stubSales();
    const r = await modeling.modelScenario('org', { lever: 'volume', changePct: -100 });
    assert(/greater than -100/.test(r.error), 'should reject');
  });

  section('Additive-upgrade contract');

  await test('every pre-existing tool is still registered and dispatchable', async () => {
    const { TOOLS, runTool } = require('../services/advisorTools');
    const names = TOOLS.map((t) => t.function.name);
    const PRE_EXISTING = [
      'getRevenueProfitSummary', 'getWeeklyRevenue', 'getGrowthTrend', 'getTopProducts',
      'getCategoryPerformance', 'getSlowMovers', 'getProfitLeakage', 'getProductProfile',
      'simulatePriceChange', 'getTopCustomers', 'getFrequentlyBoughtTogether', 'getDataFields',
      'getDatasetMetric', 'getLowStock', 'getOverstock', 'getExpirySummary',
      'getSupplierBreakdown', 'getBusinessHealth', 'getTopPriorities', 'getRevenueTrendDrivers',
      'getWeatherOutlook', 'getDecisionOpportunities', 'getRecommendations', 'getBusinessMetric',
      'getExecutiveBrief',
    ];
    for (const n of PRE_EXISTING) {
      assert(names.includes(n), `pre-existing tool '${n}' must still be registered`);
    }
    assertEquals(typeof runTool, 'function', 'runTool still exported');
  });

  await test('the modeling tools are additions, not replacements', async () => {
    const { TOOLS } = require('../services/advisorTools');
    const names = TOOLS.map((t) => t.function.name);
    assert(names.includes('modelGoal'), 'modelGoal registered');
    assert(names.includes('modelScenario'), 'modelScenario registered');
    assertEquals(new Set(names).size, names.length, 'no duplicate tool names');
  });

  await test('every tool schema is well-formed for function calling', async () => {
    const { TOOLS } = require('../services/advisorTools');
    for (const t of TOOLS) {
      assertEquals(t.type, 'function', 'type');
      assert(t.function.name, 'name present');
      assert(t.function.description && t.function.description.length > 20, `${t.function.name} needs a real description`);
      assertEquals(typeof t.function.parameters, 'object', `${t.function.name} parameters`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
})();
