#!/usr/bin/env node
/**
 * What one Advisor question actually costs.
 *
 * This is the number the whole desktop plan hangs on. Subscription pricing was
 * chosen, which means every question a pharmacy asks is billed to us, so
 * "₦12,000/month" is either profitable or loss-making depending on a figure
 * nobody has measured yet.
 *
 * Guessing is unusually dangerous here because this Advisor is not a cheap one:
 * 28 tool schemas (~5,900 tokens) ride on EVERY call, reasoning is enabled, and
 * a single question triggers several round trips as the model calls tools and
 * comes back. A naive "a question is maybe 1,000 tokens" estimate can be out by
 * a factor of ten.
 *
 * Usage:
 *   LLM_API_KEY=sk-... node measure-cost.js
 *   LLM_API_KEY=sk-... node measure-cost.js --runs 20 --plan-price 12000
 *
 * Prints per-question token counts, the cost in USD and NGN, and how many
 * questions a given monthly price can absorb before it stops paying for itself.
 */

const PROVIDER_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const PROVIDER_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// Update these to your provider's published rates, per 1M tokens, in USD.
// Cached input is usually far cheaper, which matters a lot here because the
// tool schemas and system prompt are deliberately byte-stable to maximise
// cache hits -- see the comment block in advisorAgent.js.
const RATES = {
  inputPerM: Number(process.env.RATE_INPUT_PER_M || 0.15),
  cachedInputPerM: Number(process.env.RATE_CACHED_INPUT_PER_M || 0.075),
  outputPerM: Number(process.env.RATE_OUTPUT_PER_M || 0.60),
};
const NGN_PER_USD = Number(process.env.NGN_PER_USD || 1600);

/**
 * Real questions pharmacy owners have asked, not synthetic ones. Short and
 * long, tool-heavy and conversational, because the cost spread between them is
 * the thing worth knowing.
 */
const QUESTIONS = [
  'Which single product should I stock up on this week?',
  'How do I prepare for this week adequately?',
  'Is there a way to sell my almost expired drugs? Any tips?',
  'What is dragging my profit down?',
  'Which products should I stop buying?',
  'How much money am I losing to expired drugs?',
  'Give me a plan to improve my margins over the next quarter.',
  'What should I do differently next month?',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const fmtUSD = (n) => '$' + n.toFixed(4);
const fmtNGN = (n) => '₦' + Math.round(n).toLocaleString('en-NG');

/** Ask one question, return the token counts the provider reports. */
async function askOne(question) {
  const started = Date.now();
  const res = await fetch(PROVIDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PROVIDER_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a pharmacy business advisor. Answer concisely and concretely.' },
        { role: 'user', content: question },
      ],
      max_tokens: 1024,
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`provider ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const u = json.usage || {};
  return {
    question,
    ms: Date.now() - started,
    input: u.prompt_tokens ?? u.input_tokens ?? 0,
    output: u.completion_tokens ?? u.output_tokens ?? 0,
    // Providers report cache hits differently; try the common shapes.
    cached: u.prompt_tokens_details?.cached_tokens
      ?? u.cache_read_input_tokens
      ?? 0,
  };
}

function costOf({ input, output, cached }) {
  const fresh = Math.max(0, input - cached);
  return (fresh / 1e6) * RATES.inputPerM
    + (cached / 1e6) * RATES.cachedInputPerM
    + (output / 1e6) * RATES.outputPerM;
}

async function main() {
  if (!PROVIDER_KEY) {
    console.error('LLM_API_KEY is not set. This tool has to make real calls to produce a real number.\n');
    console.error('  LLM_API_KEY=sk-... node measure-cost.js\n');
    process.exit(1);
  }

  const runs = Math.max(1, Number(arg('runs', QUESTIONS.length)));
  const planPrice = Number(arg('plan-price', 12000));

  console.log(`Model:     ${MODEL}`);
  console.log(`Endpoint:  ${PROVIDER_URL}`);
  console.log(`Rates/1M:  in $${RATES.inputPerM}  cached $${RATES.cachedInputPerM}  out $${RATES.outputPerM}`);
  console.log(`FX:        ₦${NGN_PER_USD}/USD`);
  console.log(`\nAsking ${runs} question(s)...\n`);

  const results = [];
  for (let i = 0; i < runs; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    try {
      const r = await askOne(q);
      r.cost = costOf(r);
      results.push(r);
      console.log(
        `  ${String(i + 1).padStart(2)}. ${String(r.input).padStart(6)} in `
        + `(${String(r.cached).padStart(5)} cached) ${String(r.output).padStart(5)} out  `
        + `${fmtUSD(r.cost).padStart(9)}  ${String(r.ms).padStart(6)}ms  ${q.slice(0, 40)}`,
      );
    } catch (e) {
      console.log(`  ${String(i + 1).padStart(2)}. FAILED — ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.error('\nNo successful calls; nothing to report.');
    process.exit(1);
  }

  const sum = (f) => results.reduce((s, r) => s + f(r), 0);
  const avgCost = sum((r) => r.cost) / results.length;
  const avgIn = Math.round(sum((r) => r.input) / results.length);
  const avgOut = Math.round(sum((r) => r.output) / results.length);
  const avgCached = Math.round(sum((r) => r.cached) / results.length);
  const costs = results.map((r) => r.cost).sort((a, b) => a - b);
  const p90 = costs[Math.min(costs.length - 1, Math.floor(costs.length * 0.9))];

  console.log(`\n${'='.repeat(72)}`);
  console.log('PER QUESTION');
  console.log(`  tokens        ${avgIn} in (${avgCached} cached), ${avgOut} out`);
  console.log(`  average cost  ${fmtUSD(avgCost)}   ${fmtNGN(avgCost * NGN_PER_USD)}`);
  console.log(`  p90 cost      ${fmtUSD(p90)}   ${fmtNGN(p90 * NGN_PER_USD)}`);

  console.log('\nMONTHLY COST PER PHARMACY (average case)');
  for (const q of [50, 100, 300, 1000]) {
    const ngn = avgCost * q * NGN_PER_USD;
    console.log(`  ${String(q).padStart(4)} questions   ${fmtNGN(ngn).padStart(12)}`);
  }

  console.log(`\nAGAINST A ₦${planPrice.toLocaleString('en-NG')}/MONTH PLAN`);
  const perQNgn = avgCost * NGN_PER_USD;
  const breakeven = Math.floor(planPrice / perQNgn);
  console.log(`  break-even at ${breakeven.toLocaleString('en-NG')} questions/month`);
  console.log('  (LLM cost only — excludes Twilio, hosting, payment fees, support and tax)');

  if (breakeven < 100) {
    console.log('\n  WARNING: break-even is under 100 questions. A single engaged owner');
    console.log('  asking a few questions a day would cost more than they pay. Either');
    console.log('  raise the price, cap the plan well below break-even, or use a');
    console.log('  cheaper model for routine questions.');
  }

  console.log('\nNOTE: measured with a bare 2-message prompt. Your live Advisor also sends');
  console.log('28 tool schemas (~5,900 tokens) and makes several round trips per question,');
  console.log('so real cost will be HIGHER than this. Treat this as the floor, then');
  console.log('re-measure through the real /api/advisor path before setting a price.');
  console.log('='.repeat(72));
}

main().catch((e) => { console.error(e); process.exit(1); });
