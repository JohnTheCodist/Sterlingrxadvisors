/**
 * Decides whether a WhatsApp upload is worth one clarifying question.
 *
 * The web upload can afford to ask about anything it is unsure of — the user
 * is already looking at a screen. WhatsApp cannot: every question costs a
 * round trip through a chat the owner may be reading while serving a customer.
 * So the bar here is much higher than "not confident". A question is only
 * worth asking when BOTH are true:
 *
 *   1. Being wrong changes a headline number. Mislabelling `subcategory`
 *      costs almost nothing; swapping cost and selling price silently
 *      inverts every margin in the summary.
 *   2. There is a real choice to offer. A column the detector simply cannot
 *      place gives the owner nothing to answer — "what is column G?" is a
 *      worse experience than a best guess, and the coherence checks are a
 *      better safety net for that case.
 *
 * At most one question is ever asked per upload. Two questions is an
 * interrogation, and the second-most-ambiguous column is by definition less
 * costly to guess at than the first.
 */

const { detectSchema } = require('../schemaDetector');

// Confusable sets. A pair of candidates is only ambiguous if both sit in the
// same set — otherwise the detector is choosing between unrelated fields and
// the low score means "unsure", not "torn".
const CONFUSABLE_GROUPS = [
  { name: 'money', priority: 1, fields: ['cost_price', 'selling_price', 'revenue'] },
  { name: 'date', priority: 2, fields: ['transaction_date', 'date', 'expiry_date'] },
  { name: 'count', priority: 3, fields: ['quantity', 'current_stock'] },
];

// Plain-language descriptions. These are read by a pharmacist on a phone, so
// they name the business meaning, never the field name.
const FIELD_LABELS = {
  cost_price: 'What you PAY your supplier for one unit',
  selling_price: 'What you CHARGE the customer for one unit',
  revenue: 'The total for the whole line (price x quantity)',
  transaction_date: 'The date the sale happened',
  date: 'The date the sale happened',
  expiry_date: 'The date the medicine expires',
  quantity: 'How many units were sold',
  current_stock: 'How many units you have left in stock',
};

// Above this the mapping auto-applies and is not worth a question — it matches
// the 'auto' tier in columnMapper.js.
const AUTO_TIER = 0.95;
// Two candidates within this of each other are genuinely competing rather than
// one clearly leading.
const CLOSE_MARGIN = 0.2;

const groupOf = (category) => CONFUSABLE_GROUPS.find((g) => g.fields.includes(category)) || null;

/**
 * Find the one column worth asking about, if any.
 *
 * @param {object[]} rows — parsed rows of the sheet carrying the facts
 * @param {Record<string, string>} knownColumns — rawHeader -> category already
 *        remembered for this pharmacy. Never ask about these again; that is
 *        the whole point of having asked once.
 * @returns {{rawHeader, options: {label, category}[], candidates} | null}
 */
function findAmbiguity(rows, knownColumns = {}) {
  if (!rows || rows.length === 0) return null;

  const schema = detectSchema(rows);
  const candidates = [];

  for (const col of schema) {
    if (knownColumns[col.rawHeader]) continue; // already answered, once, forever
    if (col.ignored) continue;

    const dets = (col.detections || []).filter((d) => d && d.category);
    if (dets.length < 2) continue;

    const [top, second] = dets;
    if (top.confidence >= AUTO_TIER) continue;              // settled
    if (top.confidence - second.confidence > CLOSE_MARGIN) continue; // not close

    const g1 = groupOf(top.category);
    const g2 = groupOf(second.category);
    if (!g1 || !g2 || g1.name !== g2.name) continue;        // unsure, not torn

    candidates.push({
      rawHeader: col.rawHeader,
      group: g1,
      gap: top.confidence - second.confidence,
      options: [top, second].map((d) => ({ category: d.category, label: FIELD_LABELS[d.category] })),
    });
  }

  if (candidates.length === 0) return null;

  // Most costly group first; within a group, the closest call.
  candidates.sort((a, b) => (a.group.priority - b.group.priority) || (a.gap - b.gap));
  const chosen = candidates[0];
  return {
    rawHeader: chosen.rawHeader,
    options: chosen.options,
    candidates: candidates.length,
  };
}

/**
 * The message the owner actually receives. Numbered, because typing a digit is
 * the least a phone keyboard can be asked for.
 */
function buildQuestionText(question) {
  const lines = [
    `Almost done — one quick thing so your numbers come out right.`,
    ``,
    `Your file has a column called "${question.rawHeader}". Which is it?`,
    ``,
  ];
  question.options.forEach((opt, i) => {
    lines.push(`${i + 1}. ${opt.label}`);
  });
  lines.push('');
  lines.push(`Reply with ${question.options.map((_, i) => i + 1).join(' or ')}. I'll remember it for next time.`);
  return lines.join('\n');
}

/**
 * Read the owner's reply.
 *
 * Accepts the number, or the words they are likely to type instead of it —
 * people answer "the one I pay" as readily as "1". Anything unrecognised
 * returns null so the caller can fall back to its own best guess rather than
 * acting on a misread answer.
 *
 * @returns {{category: string} | {skip: true} | null}
 */
function parseAnswer(question, replyText) {
  const text = String(replyText || '').trim().toLowerCase();
  if (!text) return null;

  if (/^(skip|not sure|dunno|don'?t know|no idea|whatever|you decide)\b/.test(text)) {
    return { skip: true };
  }

  const numeric = text.match(/^\s*([1-9])\b/);
  if (numeric) {
    const idx = Number(numeric[1]) - 1;
    if (question.options[idx]) return { category: question.options[idx].category };
    return null;
  }

  // Word answers, scoped to the options actually offered so the same word
  // cannot select a field that was never on the menu.
  const KEYWORDS = {
    cost_price: ['pay', 'paid', 'purchase', 'buy', 'buying', 'supplier', 'cost price', 'my cost'],
    selling_price: ['charge', 'sell', 'selling', 'sale price', 'retail', 'customer pays', 'unit price'],
    revenue: ['total', 'amount', 'line total', 'whole line', 'revenue', 'turnover'],
    transaction_date: ['sale', 'sold', 'transaction', 'when sold', 'sale date'],
    date: ['sale', 'sold', 'transaction', 'when sold', 'sale date'],
    expiry_date: ['expiry', 'expire', 'expires', 'expiration', 'best before'],
    quantity: ['sold', 'units sold', 'how many sold', 'quantity sold'],
    current_stock: ['stock', 'in stock', 'remaining', 'left', 'on hand', 'balance'],
  };

  const hits = question.options.filter((opt) =>
    (KEYWORDS[opt.category] || []).some((kw) => text.includes(kw)));

  // Exactly one option matched — anything else is too uncertain to act on.
  return hits.length === 1 ? { category: hits[0].category } : null;
}

module.exports = {
  findAmbiguity,
  buildQuestionText,
  parseAnswer,
  FIELD_LABELS,
  CONFUSABLE_GROUPS,
  AUTO_TIER,
  CLOSE_MARGIN,
};
