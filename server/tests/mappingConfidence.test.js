/**
 * Tests for corroboration-based confidence and set-level coherence checking.
 *
 * The behaviour being protected is a claim about EVIDENCE, not about parsing:
 * a mapping earns the auto tier when two methods that work in different ways
 * independently agree, and loses it when they don't — regardless of how
 * confident either one sounds on its own. Every threshold below is read
 * against the tiers in columnMapper.js (>= 0.95 auto, >= 0.70 review), so a
 * test asserting "clears 0.95" is really asserting "no human has to look".
 */

const { mergeLlmResults, checkMappingCoherence } = require('../services/schemaDetector');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

const AUTO = 0.95;
const REVIEW = 0.70;

// --- builders -------------------------------------------------------------
const ruleCol = (rawHeader, detections) => ({ rawHeader, normalizedHeader: rawHeader.toLowerCase(), detections });
const det = (category, confidence, source = 'header match') => ({ category, confidence, source });

// An LLM column as buildColumnsFromMapping emits it: the primary detection is
// flagged `unverified`, which is what marks it as independent evidence.
const llmCol = (rawHeader, mappedTo, { why = null, second = null } = {}) => ({
  rawHeader,
  mappedTo,
  confidence: 0.75,
  detections: [
    { category: mappedTo, confidence: 0.75, source: 'LLM semantic match', unverified: true, ...(why ? { why } : {}) },
    ...(second ? [{ category: second, confidence: 0.45, source: 'LLM semantic match (second choice)', unverified: true }] : []),
  ],
});

// The local heuristic fallback: same path, but scored rather than unverified.
const localCol = (rawHeader, mappedTo, confidence) => ({
  rawHeader,
  mappedTo,
  confidence,
  detections: [{ category: mappedTo, confidence, source: 'Local heuristic match' }],
});

const topOf = (cols, header) => {
  const c = cols.find((x) => x.rawHeader === header);
  return c.detections[0];
};
const findDet = (cols, header, category) =>
  cols.find((x) => x.rawHeader === header).detections.find((d) => d.category === category);

section('Agreement earns the auto tier');

test('two methods agreeing clears the auto bar even when neither was certain', () => {
  // Rule detector was only 0.80 — on its own that is review-tier, a click.
  const out = mergeLlmResults(
    [ruleCol('ItemName', [det('product_name', 0.80)])],
    [llmCol('ItemName', 'product_name')],
  );
  const top = topOf(out, 'ItemName');
  eq(top.category, 'product_name');
  assert(top.confidence >= AUTO, `agreement should auto-apply, got ${top.confidence}`);
  eq(top.agreement, 'corroborated');
});

test('agreement is capped below certainty', () => {
  const out = mergeLlmResults(
    [ruleCol('ItemName', [det('product_name', 0.99)])],
    [llmCol('ItemName', 'product_name')],
  );
  assert(topOf(out, 'ItemName').confidence <= 0.99, 'never claims certainty');
});

test('a weak rule score still reaches auto when corroborated', () => {
  const out = mergeLlmResults(
    [ruleCol('Col7', [det('quantity', 0.35)])],
    [llmCol('Col7', 'quantity')],
  );
  assert(topOf(out, 'Col7').confidence >= AUTO, 'agreement carries a weak header match');
});

section('Disagreement reaches a human');

test('different fields demote BOTH, so neither auto-applies by outshouting', () => {
  const out = mergeLlmResults(
    [ruleCol('Amount', [det('selling_price', 0.97)])],
    [llmCol('Amount', 'revenue')],
  );
  const llmDet = findDet(out, 'Amount', 'revenue');
  const ruleDet = findDet(out, 'Amount', 'selling_price');
  eq(llmDet.agreement, 'conflict');
  assert(llmDet.confidence < AUTO, 'the LLM pick cannot auto-apply on a conflict');
  assert(ruleDet.confidence < AUTO, `the rule pick must be demoted too, got ${ruleDet.confidence}`);
  assert(ruleDet.confidence >= REVIEW, 'but still a live candidate for review');
});

test('same field, different ranking lands in review rather than auto', () => {
  const out = mergeLlmResults(
    [ruleCol('Rate', [det('revenue', 0.88), det('selling_price', 0.60)])],
    [llmCol('Rate', 'selling_price')],
  );
  const d = findDet(out, 'Rate', 'selling_price');
  eq(d.agreement, 'ranking-dispute');
  assert(d.confidence >= REVIEW && d.confidence < AUTO, `should be review-tier, got ${d.confidence}`);
});

test('an LLM answer the rules never found does not auto-apply', () => {
  const out = mergeLlmResults(
    [ruleCol('Unnamed: 3', [])],
    [llmCol('Unnamed: 3', 'batch_number')],
  );
  const top = topOf(out, 'Unnamed: 3');
  eq(top.agreement, 'llm-only');
  assert(top.confidence >= REVIEW && top.confidence < AUTO, 'reaches a human, but is offered');
});

section('Only independent evidence counts as corroboration');

test('the local heuristic fallback gets no agreement bonus', () => {
  // Same header/value heuristics as the rule detector — agreement between them
  // is self-congratulation, not evidence.
  const out = mergeLlmResults(
    [ruleCol('ItemName', [det('product_name', 0.80)])],
    [localCol('ItemName', 'product_name', 0.75)],
  );
  const top = topOf(out, 'ItemName');
  eq(top.confidence, 0.80, 'take-the-higher, exactly as before');
  assert(!top.agreement, 'no agreement verdict claimed');
});

section('The model\'s reasoning survives the merge');

test('the stated reason is carried onto the detection', () => {
  const out = mergeLlmResults(
    [ruleCol('PurchaseCost', [det('cost_price', 0.9)])],
    [llmCol('PurchaseCost', 'cost_price', { why: 'purchase side of the transaction' })],
  );
  eq(topOf(out, 'PurchaseCost').why, 'purchase side of the transaction');
});

test('a runner-up is offered but can never win on its own', () => {
  const out = mergeLlmResults(
    [ruleCol('Price', [det('selling_price', 0.9)])],
    [llmCol('Price', 'selling_price', { second: 'cost_price' })],
  );
  const second = findDet(out, 'Price', 'cost_price');
  assert(second, 'runner-up kept as an option');
  assert(second.confidence < REVIEW, `must not compete, got ${second.confidence}`);
  eq(topOf(out, 'Price').category, 'selling_price', 'first choice still wins');
});

test('columns the model said nothing about are returned untouched', () => {
  const input = [ruleCol('Notes', [det('product_name', 0.4)])];
  const out = mergeLlmResults(input, [llmCol('Other', 'quantity')]);
  eq(out[0].detections[0].confidence, 0.4);
});

test('no LLM columns at all is a no-op', () => {
  const input = [ruleCol('A', [det('quantity', 0.5)])];
  eq(mergeLlmResults(input, []), input);
  eq(mergeLlmResults(input, null), input);
});

// --------------------------------------------------------------------------
section('Coherence: cost against selling price');

const mapOf = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { rawHeader: v }]));

test('cost above selling on most rows demotes both columns', () => {
  const rows = Array.from({ length: 20 }, () => ({ Buy: 900, Sell: 500 }));
  const cols = [
    ruleCol('Buy', [det('cost_price', 0.97)]),
    ruleCol('Sell', [det('selling_price', 0.97)]),
  ];
  const { columns, checks } = checkMappingCoherence(cols, mapOf({ cost_price: 'Buy', selling_price: 'Sell' }), rows);
  assert(findDet(columns, 'Buy', 'cost_price').confidence < AUTO, 'cost demoted');
  assert(findDet(columns, 'Sell', 'selling_price').confidence < AUTO, 'selling demoted');
  const c = checks.find((x) => x.check === 'cost_vs_selling');
  eq(c.passed, false);
  assert(/swapped/i.test(c.message), `message should name the likely cause: ${c.message}`);
});

test('a normal margin passes and changes nothing', () => {
  const rows = Array.from({ length: 20 }, () => ({ Buy: 500, Sell: 900 }));
  const cols = [ruleCol('Buy', [det('cost_price', 0.97)]), ruleCol('Sell', [det('selling_price', 0.97)])];
  const { columns, checks } = checkMappingCoherence(cols, mapOf({ cost_price: 'Buy', selling_price: 'Sell' }), rows);
  eq(findDet(columns, 'Buy', 'cost_price').confidence, 0.97, 'untouched');
  eq(checks.find((x) => x.check === 'cost_vs_selling').passed, true);
});

test('too few comparable rows yields no verdict either way', () => {
  const rows = [{ Buy: 900, Sell: 500 }, { Buy: 900, Sell: 500 }];
  const cols = [ruleCol('Buy', [det('cost_price', 0.97)]), ruleCol('Sell', [det('selling_price', 0.97)])];
  const { columns, checks } = checkMappingCoherence(cols, mapOf({ cost_price: 'Buy', selling_price: 'Sell' }), rows);
  eq(findDet(columns, 'Buy', 'cost_price').confidence, 0.97, 'no demotion on thin evidence');
  assert(!checks.some((x) => x.check === 'cost_vs_selling'), 'and no claim made');
});

section('Coherence: the revenue identity');

test('revenue = quantity x price lifts all three to auto', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ Q: i + 1, P: 100, Total: (i + 1) * 100 }));
  const cols = [
    ruleCol('Q', [det('quantity', 0.55)]),
    ruleCol('P', [det('selling_price', 0.60)]),
    ruleCol('Total', [det('revenue', 0.58)]),
  ];
  const { columns, checks } = checkMappingCoherence(
    cols, mapOf({ quantity: 'Q', selling_price: 'P', revenue: 'Total' }), rows,
  );
  for (const [h, cat] of [['Q', 'quantity'], ['P', 'selling_price'], ['Total', 'revenue']]) {
    assert(findDet(columns, h, cat).confidence >= AUTO, `${cat} should be confirmed by the identity`);
  }
  eq(checks.find((x) => x.check === 'revenue_identity').passed, true);
});

test('an identity that never holds is reported but does not silently remap', () => {
  const rows = Array.from({ length: 20 }, () => ({ Q: 3, P: 100, Total: 7 }));
  const cols = [
    ruleCol('Q', [det('quantity', 0.9)]),
    ruleCol('P', [det('selling_price', 0.9)]),
    ruleCol('Total', [det('revenue', 0.9)]),
  ];
  const { columns, checks } = checkMappingCoherence(
    cols, mapOf({ quantity: 'Q', selling_price: 'P', revenue: 'Total' }), rows,
  );
  const c = checks.find((x) => x.check === 'revenue_identity');
  eq(c.passed, false);
  eq(findDet(columns, 'Q', 'quantity').category, 'quantity', 'mapping is never rewritten here');
});

test('small rounding differences still count as holding', () => {
  const rows = Array.from({ length: 20 }, () => ({ Q: 3, P: 33.33, Total: 100 }));
  const cols = [ruleCol('Q', [det('quantity', 0.5)]), ruleCol('P', [det('selling_price', 0.5)]), ruleCol('Total', [det('revenue', 0.5)])];
  const { checks } = checkMappingCoherence(cols, mapOf({ quantity: 'Q', selling_price: 'P', revenue: 'Total' }), rows);
  eq(checks.find((x) => x.check === 'revenue_identity').passed, true, '2% tolerance absorbs rounding');
});

section('Coherence: a column must read as what it was mapped to');

test('a date column full of non-dates is demoted', () => {
  const rows = Array.from({ length: 20 }, () => ({ When: 'N/A' }));
  const cols = [ruleCol('When', [det('transaction_date', 0.96)])];
  const { columns, checks } = checkMappingCoherence(cols, mapOf({ transaction_date: 'When' }), rows);
  assert(findDet(columns, 'When', 'transaction_date').confidence < REVIEW, 'demoted hard');
  eq(checks.find((x) => x.check === 'transaction_date_parses').passed, false);
});

test('real dates pass untouched', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ When: `2026-03-${String((i % 28) + 1).padStart(2, '0')}` }));
  const cols = [ruleCol('When', [det('transaction_date', 0.96)])];
  const { columns, checks } = checkMappingCoherence(cols, mapOf({ transaction_date: 'When' }), rows);
  eq(findDet(columns, 'When', 'transaction_date').confidence, 0.96);
  eq(checks.find((x) => x.check === 'transaction_date_parses').passed, true);
});

test('a quantity column of negatives is demoted', () => {
  const rows = Array.from({ length: 20 }, () => ({ Qty: -5 }));
  const cols = [ruleCol('Qty', [det('quantity', 0.96)])];
  const { columns } = checkMappingCoherence(cols, mapOf({ quantity: 'Qty' }), rows);
  assert(findDet(columns, 'Qty', 'quantity').confidence < AUTO, 'counts are positive');
});

section('Adjustments stay where they belong');

test('an adjustment touches only the column the field resolved to', () => {
  const rows = Array.from({ length: 20 }, () => ({ When: 'N/A', Other: 'x' }));
  const cols = [
    ruleCol('When', [det('transaction_date', 0.96)]),
    ruleCol('Other', [det('transaction_date', 0.91)]),
  ];
  const { columns } = checkMappingCoherence(cols, mapOf({ transaction_date: 'When' }), rows);
  eq(findDet(columns, 'Other', 'transaction_date').confidence, 0.91, 'the unmapped column is not judged');
});

test('an empty file is checked but never penalised', () => {
  const cols = [ruleCol('A', [det('quantity', 0.9)])];
  const r = checkMappingCoherence(cols, mapOf({ quantity: 'A' }), []);
  eq(r.columns, cols);
  eq(r.checks.length, 0);
});

test('a demotion and a confirmation on one column take the harsher verdict', () => {
  // Quantity is confirmed by the revenue identity AND contradicted by its own
  // values. The contradiction is about the column itself, so it must win.
  const rows = Array.from({ length: 20 }, () => ({ Q: -3, P: 100, Total: -300 }));
  const cols = [ruleCol('Q', [det('quantity', 0.9)]), ruleCol('P', [det('selling_price', 0.9)]), ruleCol('Total', [det('revenue', 0.9)])];
  const { columns } = checkMappingCoherence(cols, mapOf({ quantity: 'Q', selling_price: 'P', revenue: 'Total' }), rows);
  assert(findDet(columns, 'Q', 'quantity').confidence < AUTO, 'negative counts still demote');
});

// --------------------------------------------------------------------------
section('Reading the model\'s answer');

const { validateLlmMapping } = require('../services/llmMapper');

test('the reasoned shape is read in full', () => {
  const r = validateLlmMapping({
    PurchaseCost: { field: 'cost_price', why: 'purchase side', second_choice: 'selling_price' },
  }, ['PurchaseCost']);
  eq(r.mapping.PurchaseCost, 'cost_price');
  eq(r.reasons.PurchaseCost, 'purchase side');
  eq(r.secondChoices.PurchaseCost, 'selling_price');
});

test('a bare string answer is still accepted', () => {
  // Models drift back to the older, simpler shape; it means the same thing.
  const r = validateLlmMapping({ Drug: 'product_name' }, ['Drug']);
  eq(r.mapping.Drug, 'product_name');
});

test('a volunteered confidence is ignored rather than trusted', () => {
  const r = validateLlmMapping({ Drug: 'product_name', _confidence: { Drug: 0.99 } }, ['Drug']);
  eq(r.mapping.Drug, 'product_name');
  assert(!('confidence' in r), 'no confidence is read from the model at all');
});

test('an invalid field name is matched to the closest real one', () => {
  const r = validateLlmMapping({ Qty: { field: 'quantity_sold', why: 'units' } }, ['Qty']);
  eq(r.mapping.Qty, 'quantity');
  eq(r.invalidCount, 1, 'and the drift is counted');
});

test('an unmappable column comes back as null, not a guess', () => {
  const r = validateLlmMapping({ Notes: { field: null, why: 'free text' } }, ['Notes']);
  eq(r.mapping.Notes, null);
});

test('a second choice identical to the first is dropped', () => {
  const r = validateLlmMapping({
    Price: { field: 'selling_price', second_choice: 'selling_price' },
  }, ['Price']);
  assert(!r.secondChoices.Price, 'a runner-up that is the winner is not a runner-up');
});

test('a header the model omitted is reported as unmapped', () => {
  const r = validateLlmMapping({ A: { field: 'quantity' } }, ['A', 'B']);
  eq(r.mapping.B, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
