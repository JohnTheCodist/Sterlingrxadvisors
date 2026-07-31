/**
 * Tests for the one clarifying question WhatsApp is allowed to ask.
 *
 * The expensive mistake here is not a wrong answer — it is asking at all. Every
 * question interrupts a pharmacist who may be mid-transaction, so the bar has
 * to stay high enough that the common file sails straight through. These tests
 * pin both halves: that an obvious file is never interrupted, and that the one
 * case where guessing corrupts headline numbers does get asked about.
 */

const {
  findAmbiguity, buildQuestionText, parseAnswer,
} = require('../services/whatsapp/mappingClarifier');
const { aliasKey } = require('../services/columnAlias');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

// A clean sales export: nothing here should ever prompt a question.
const CLEAN = Array.from({ length: 30 }, (_, i) => ({
  'Product Name': `Paracetamol ${i}`,
  'Quantity Sold': (i % 5) + 1,
  'Selling Price': 250 + i,
  'Purchase Cost': 150 + i,
  'Transaction Date': `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
}));

section('Most files are never interrupted');

test('an unambiguous export asks nothing', () => {
  eq(findAmbiguity(CLEAN, {}), null, 'clear headers must sail straight through');
});

test('an empty file asks nothing', () => {
  eq(findAmbiguity([], {}), null);
  eq(findAmbiguity(null, {}), null);
});

// A bare "Cost" column is the case worth interrupting for: nothing in the
// header or the values says whether it is what the pharmacy paid or what it
// charged, and guessing wrong inverts every margin in the summary.
const AMBIGUOUS = Array.from({ length: 30 }, (_, i) => ({
  Product: `Drug ${i}`, Cost: 100 + i, Price: 250 + i, Qty: 2,
}));

test('a column already answered is never asked about again', () => {
  const asked = findAmbiguity(AMBIGUOUS, {});
  assert(asked, 'precondition: this file is ambiguous');
  const known = { [asked.rawHeader]: 'cost_price' };
  eq(findAmbiguity(AMBIGUOUS, known), null, 'memory must suppress the repeat question');
});

section('Only one question, and only a costly one');

test('the cost/price ambiguity IS asked about', () => {
  const q = findAmbiguity(AMBIGUOUS, {});
  assert(q, 'a bare "Cost" beside a "Price" must not be guessed at silently');
  eq(q.rawHeader, 'Cost');
  const cats = q.options.map((o) => o.category).sort();
  eq(cats.join(','), 'cost_price,selling_price', 'offers the two readings that matter');
});

test('exactly one question, with two choices', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    Product: `Drug ${i}`, Cost: 100 + i, Amount: 500 + i, Value: 900 + i, Date1: '2026-03-01',
  }));
  const q = findAmbiguity(rows, {});
  assert(q, 'still asks when several columns are unclear');
  eq(q.options.length, 2, 'two choices — a phone reply should be one digit');
  assert(typeof q.rawHeader === 'string' && q.rawHeader.length > 0, 'names the column');
});

test('low-impact ambiguity is never worth a question', () => {
  // "Value" reads as discount-or-tax: a close call, but neither answer moves
  // a headline number, so the detector's guess is good enough.
  const rows = Array.from({ length: 30 }, (_, i) => ({ Product: `D${i}`, Value: 900 + i, Qty: 3 }));
  eq(findAmbiguity(rows, {}), null, 'interrupting for a minor field is the expensive mistake');
});

test('every option offered carries a plain-language label', () => {
  const q = findAmbiguity(AMBIGUOUS, {});
  assert(q, 'precondition');
  for (const opt of q.options) {
    assert(opt.label && opt.label.length > 10, `option "${opt.category}" needs a readable label`);
    assert(!/_/.test(opt.label), `label must not leak the field name: ${opt.label}`);
  }
});

section('The message a pharmacist receives');

const Q = {
  rawHeader: 'Cost',
  options: [
    { category: 'cost_price', label: 'What you PAY your supplier for one unit' },
    { category: 'selling_price', label: 'What you CHARGE the customer for one unit' },
  ],
};

test('the question names the column and numbers the choices', () => {
  const text = buildQuestionText(Q);
  assert(text.includes('"Cost"'), 'names the actual column');
  assert(text.includes('1.') && text.includes('2.'), 'numbered for a phone keyboard');
  assert(/remember/i.test(text), 'tells them it will not be asked again');
});

test('the question never shows internal field names', () => {
  const text = buildQuestionText(Q);
  assert(!/cost_price|selling_price/.test(text), `leaked a field name: ${text}`);
});

section('Reading the reply');

test('a bare number selects that option', () => {
  eq(parseAnswer(Q, '1').category, 'cost_price');
  eq(parseAnswer(Q, '2').category, 'selling_price');
  eq(parseAnswer(Q, ' 2 ').category, 'selling_price', 'whitespace tolerated');
});

test('a number outside the options is refused rather than guessed', () => {
  eq(parseAnswer(Q, '5'), null, 'better to fall back than to act on a misread');
});

test('people who answer in words are understood', () => {
  eq(parseAnswer(Q, 'what I pay').category, 'cost_price');
  eq(parseAnswer(Q, "it's what we charge customers").category, 'selling_price');
  eq(parseAnswer(Q, 'the supplier one').category, 'cost_price');
});

test('an ambiguous word answer is refused, not guessed', () => {
  // Mentions both sides — acting on this could invert every margin.
  eq(parseAnswer(Q, 'i pay 100 and charge 250'), null);
});

test('an unrelated message is not mistaken for an answer', () => {
  eq(parseAnswer(Q, 'what was my revenue last month?'), null);
  eq(parseAnswer(Q, 'hello'), null);
  eq(parseAnswer(Q, ''), null);
});

test('an explicit skip is recognised as a decision', () => {
  assert(parseAnswer(Q, 'skip').skip, 'skip');
  assert(parseAnswer(Q, 'not sure').skip, 'not sure');
  assert(parseAnswer(Q, "don't know").skip, 'don\'t know');
});

test('a word matching an option NOT offered cannot be selected', () => {
  const dateQ = {
    rawHeader: 'Date',
    options: [
      { category: 'transaction_date', label: 'The date the sale happened' },
      { category: 'expiry_date', label: 'The date the medicine expires' },
    ],
  };
  eq(parseAnswer(dateQ, 'expiry').category, 'expiry_date');
  eq(parseAnswer(dateQ, 'what I pay'), null, 'cost keywords must not select a date field');
});

section('Alias keys — what "the same column" means');

test('case and spacing differences resolve to one memory', () => {
  eq(aliasKey('Item Name'), aliasKey('item_name'));
  eq(aliasKey(' ItemName '), aliasKey('itemname'));
  eq(aliasKey('Unit  Price'), aliasKey('Unit Price'), 'repeated spaces collapse');
  eq(aliasKey('Cost:'), aliasKey('Cost'), 'trailing punctuation ignored');
});

test('genuinely different headers stay separate', () => {
  assert(aliasKey('Cost Price') !== aliasKey('Selling Price'));
  assert(aliasKey('Sale Date') !== aliasKey('Expiry Date'));
});

test('an empty header produces no key to store under', () => {
  eq(aliasKey(''), '');
  eq(aliasKey(null), '');
  eq(aliasKey('   '), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
