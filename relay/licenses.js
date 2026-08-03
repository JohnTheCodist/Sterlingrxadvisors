/**
 * Licence records and monthly usage, for the spike.
 *
 * Deliberately an in-memory Map: the point of this spike is to measure what an
 * Advisor question actually costs, and a database would add setup without
 * changing that number. Everything here is behind a small interface so the
 * store can become Postgres later without the routes changing.
 *
 * WHAT MUST NOT CHANGE when this becomes real:
 *
 *   - A licence that cannot be verified must fail CLOSED at the relay (no free
 *     LLM calls) but the desktop app must fail OPEN for offline features. Those
 *     are different decisions in different places; see the grace-period logic
 *     in the desktop client. The pharmacy's own dashboard is never held hostage
 *     to our uptime.
 *   - Usage must be recorded even when a request errors midway, or a stream
 *     that dies after 4,000 output tokens is billed as zero.
 */

const MONTH = () => new Date().toISOString().slice(0, 7); // '2026-08'

/** plan → questions per calendar month. Over the cap returns a clear error. */
const PLANS = {
  starter: { name: 'Starter', monthlyQuestions: 100 },
  standard: { name: 'Standard', monthlyQuestions: 300 },
  pro: { name: 'Pro', monthlyQuestions: 1000 },
  unlimited: { name: 'Unlimited', monthlyQuestions: Infinity },
};

const licenses = new Map();
const usage = new Map(); // `${key}:${month}` → { requests, inputTokens, outputTokens }

function seed(key, { plan = 'standard', pharmacy = 'Test Pharmacy', active = true, expiresAt = null } = {}) {
  licenses.set(key, { key, plan, pharmacy, active, expiresAt });
  return licenses.get(key);
}

function get(key) {
  return licenses.get(key) || null;
}

/**
 * Is this licence allowed to make an LLM call right now?
 * Returns a reason on refusal so the desktop app can say something useful
 * instead of a bare 403.
 */
function authorize(key) {
  if (!key) return { ok: false, code: 'missing_license', message: 'No licence key supplied.' };

  const lic = get(key);
  if (!lic) return { ok: false, code: 'unknown_license', message: 'Licence key not recognised.' };
  if (!lic.active) {
    return { ok: false, code: 'inactive', message: 'This subscription is not active. Renew to use the Advisor.' };
  }
  if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) {
    return { ok: false, code: 'expired', message: 'This subscription has expired. Renew to use the Advisor.' };
  }

  const plan = PLANS[lic.plan] || PLANS.starter;
  const used = getUsage(key);
  if (used.requests >= plan.monthlyQuestions) {
    return {
      ok: false,
      code: 'quota_exceeded',
      message: `You have used all ${plan.monthlyQuestions} Advisor questions on the ${plan.name} plan this month. `
        + 'The dashboard, reports and recommendations keep working — only the Advisor is paused until next month.',
    };
  }

  return { ok: true, license: lic, plan, used };
}

function getUsage(key, month = MONTH()) {
  return usage.get(`${key}:${month}`) || { requests: 0, inputTokens: 0, outputTokens: 0 };
}

/**
 * Record one call. Called even on failure, with whatever token counts were
 * observed before the error — an abandoned stream still cost money.
 */
function recordUsage(key, { inputTokens = 0, outputTokens = 0 } = {}, month = MONTH()) {
  const id = `${key}:${month}`;
  const cur = usage.get(id) || { requests: 0, inputTokens: 0, outputTokens: 0 };
  cur.requests += 1;
  cur.inputTokens += inputTokens || 0;
  cur.outputTokens += outputTokens || 0;
  usage.set(id, cur);
  return cur;
}

function reset() {
  licenses.clear();
  usage.clear();
}

module.exports = { PLANS, seed, get, authorize, getUsage, recordUsage, reset, MONTH };
