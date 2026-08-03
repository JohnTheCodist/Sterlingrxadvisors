/**
 * Tests for the Executive Brief naming a number it does not have.
 *
 * Reported from production: the brief read "Areas to address: margin at N/A
 * needs improvement." Two faults in one sentence — a placeholder leaked into
 * prose, and the sentence asserted a performance problem using a value nobody
 * had computed.
 *
 * Root cause: `overview.grossMargin >= 30` is FALSE when grossMargin is null,
 * so the else-branch fired and classified an unmeasurable margin as a failing
 * one. Gross margin is legitimately null whenever the upload has no cost
 * prices (metrics.js returns null and flags hasCostData), which is the common
 * case for a pharmacy exporting sales only — so this fired constantly, and it
 * told owners their margin was bad on no evidence at all.
 *
 * The same shape appears wherever a threshold is applied to a nullable number:
 * `lm.margin < 25` is TRUE for null, which accused a product of low
 * profitability with "at just N/A margin".
 */

const { generateInsights } = require('../services/recommendations');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };

const health = { overallScore: 60, rating: 'Fair', pillars: {}, concerns: [] };

/**
 * A sales-only upload: revenue and transactions are real, cost prices were
 * never in the file, so grossProfit/grossMargin are null exactly as
 * computeAllMetrics would return them.
 */
function metricsWithoutCost(over = {}) {
  return {
    overview: {
      totalRevenue: 53019500,
      grossProfit: null,
      grossMargin: null,
      hasCostData: false,
      transactionCount: 3077,
      averageTransactionValue: 17232,
      ...over,
    },
    products: {
      allProducts: Array.from({ length: 20 }, (_, i) => ({ name: `Product ${i + 1}`, revenue: 100000, margin: null })),
      totalDistinctProducts: 20,
    },
    trends: { months: [{ month: '2026-05' }, { month: '2026-06' }, { month: '2026-07' }] },
    dataQuality: { qualityDistribution: { excellent: 3077, good: 0, fair: 0, poor: 0 } },
  };
}

function metricsWithCost() {
  const m = metricsWithoutCost({ grossProfit: 21207800, grossMargin: 40, hasCostData: true });
  return m;
}

const allText = (insights) => insights.map((i) => [
  i.observation, i.businessImpact, i.recommendedAction, i.expectedOutcome,
  ...(i.evidence || []),
].join(' ')).join(' \n ');

async function main() {
  section('The reported sentence');

  test('no insight ever renders the literal "N/A"', () => {
    const text = allText(generateInsights(health, metricsWithoutCost()));
    assert(!/N\/A/.test(text), `"N/A" leaked into brief text:\n${text.split('\n').filter((l) => /N\/A/.test(l)).join('\n')}`);
  });

  test('an unmeasurable margin is never called a margin that "needs improvement"', () => {
    const text = allText(generateInsights(health, metricsWithoutCost()));
    assert(!/margin at .* needs improvement/i.test(text),
      'a margin nobody computed must not be reported as underperforming');
  });

  test('the missing margin is disclosed as a data gap instead of hidden', () => {
    const text = allText(generateInsights(health, metricsWithoutCost()));
    assert(/cost price/i.test(text),
      'the owner should learn WHY margin is absent and what to upload — found no mention of cost prices');
  });

  test('a data gap is not filed under "Areas to address"', () => {
    // "Areas to address" is for things the owner is doing badly. A column
    // their POS never exported is not one of them.
    const insights = generateInsights(health, metricsWithoutCost());
    for (const i of insights) {
      const m = /Areas to address: ([^.]*)\./.exec(i.observation || '');
      if (m) assert(!/cannot be calculated|not available/i.test(m[1]),
        `a data gap was phrased as a performance weakness: "${m[1]}"`);
    }
  });

  section('A real margin is still judged normally');

  test('a genuine low margin is still reported as needing improvement', () => {
    const m = metricsWithoutCost({ grossProfit: 5301950, grossMargin: 10, hasCostData: true });
    const text = allText(generateInsights(health, m));
    assert(/10%/.test(text), 'the real margin figure should appear');
    assert(!/N\/A/.test(text), 'no placeholder even on the low-margin path');
  });

  test('a healthy margin is reported as a strength, with its number', () => {
    const text = allText(generateInsights(health, metricsWithCost()));
    assert(/40%/.test(text), 'the healthy margin figure should appear');
    assert(!/margin at .* needs improvement/i.test(text), 'a 40% margin is not a weakness');
    assert(!/N\/A/.test(text), 'no placeholder on the healthy path');
  });

  section('The same fault in other findings');

  test('a product with an uncomputed margin is not accused of low profitability', () => {
    // `lm.margin < 25` is true for null — this asserted "at just N/A margin"
    // about a product whose margin was never derived.
    const m = metricsWithoutCost();
    m.concentration = {
      top1: { name: 'Product 1', revenue: 30000000 },
      top1Share: 56,
      lowestMargin: { name: 'Product 1', revenue: 30000000, margin: null },
    };
    const text = allText(generateInsights(health, m));
    assert(!/at just N\/A margin/i.test(text), 'accused a product of low margin using a null value');
    assert(!/N\/A/.test(text), `"N/A" still present:\n${text}`);
  });

  test('an unknown revenue-concentration share is not reported as heavy reliance', () => {
    const m = metricsWithoutCost();
    m.concentration = { top1: { name: 'Product 1', revenue: 1 }, top1Share: null, lowestMargin: null };
    const text = allText(generateInsights(health, m));
    assert(!/heavy reliance on .*N\/A/i.test(text), 'reported a concentration percentage it did not have');
  });

  section('Nothing else regressed');

  test('real figures the brief does have are still reported', () => {
    const insights = generateInsights(health, metricsWithoutCost());
    const text = allText(insights);
    assert(insights.length > 0, 'the brief should still produce insights');
    assert(/3,077|3077/.test(text), 'transaction count should still appear');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

main();
