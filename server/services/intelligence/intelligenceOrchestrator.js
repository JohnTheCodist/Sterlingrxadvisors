/**
 * Intelligence Orchestrator.
 *
 * Single responsibility: request signals from Weather, Calendar, and
 * Disease Intelligence, convert each into the common BusinessSignal shape
 * (see businessSignal.js), and return them combined. Does NOT deduplicate,
 * score, merge, resolve conflicts, generate recommendations, or touch
 * inventory/sales — collection and format-normalization only. Ranking,
 * conflict resolution, and recommendations remain the Decision Engine's
 * job, not this module's.
 *
 * Each source is queried through its own existing public functions —
 * nothing about Weather, Calendar, or Disease Intelligence is modified to
 * build this, beyond the one additive "give me the latest signals" export
 * already added to diseaseIntelligence.js.
 */

const { evaluateWeatherDemandRules } = require('../weatherDecisionRules');
const { getCalendarSignals } = require('../calendar/calendarService');
const { getLatestDiseaseSignals } = require('../ncdc/diseaseIntelligence');

// Weather rules can express "Slight Increase" — BusinessSignal's
// expectedDemand only has three values, so direction collapses to
// Increase/Decrease/Neutral here; the strength nuance already lives in
// `confidence`, not in a fourth demand label.
function toBusinessDemand(value) {
  if (value === 'Slight Increase') return 'Increase';
  if (value === 'Increase' || value === 'Decrease' || value === 'Neutral') return value;
  return 'Neutral';
}

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---- per-source collection + conversion ----------------------------------

async function collectWeatherSignals(organizationId) {
  try {
    const { state } = await require('../pharmacyProfile').get(organizationId);
    if (!state) {
      console.log('[intelligence-orchestrator] Weather: no pharmacy state configured, skipping.');
      return [];
    }
    const weatherSignal = await require('../weather/weatherCache').getOrFetch(organizationId, state);
    if (!weatherSignal) {
      console.log('[intelligence-orchestrator] Weather: no weather data available, skipping.');
      return [];
    }
    const demandRules = await evaluateWeatherDemandRules(organizationId, weatherSignal);
    console.log(`[intelligence-orchestrator] Weather: collected ${demandRules.length} signal(s).`);
    return demandRules.map(({ rule, numericConfidence, evidence }) => ({
      source: 'Weather',
      category: rule.category,
      signal: rule.weatherSignal,
      expectedDemand: toBusinessDemand(rule.expectedDemand),
      confidence: clamp01(numericConfidence / 100),
      rationale: rule.rationale,
      metadata: { state, confirmedByOwnData: evidence.available ? evidence.pctIncrease > 0 : null },
    }));
  } catch (err) {
    console.warn('[intelligence-orchestrator] Weather signal collection failed:', err.message);
    return [];
  }
}

function collectCalendarSignals() {
  try {
    const signals = getCalendarSignals(new Date());
    console.log(`[intelligence-orchestrator] Calendar: collected ${signals.length} signal(s).`);
    const EVIDENCE_SCORE = { Strong: 0.9, Moderate: 0.7, Limited: 0.5 };
    return signals.map((s) => ({
      source: 'Calendar',
      category: s.category,
      signal: s.event,
      expectedDemand: toBusinessDemand(s.expectedDemand),
      confidence: clamp01(EVIDENCE_SCORE[s.evidenceStrength] ?? 0.5),
      rationale: s.rationale,
      metadata: { evidenceStrength: s.evidenceStrength },
    }));
  } catch (err) {
    console.warn('[intelligence-orchestrator] Calendar signal collection failed:', err.message);
    return [];
  }
}

function collectDiseaseSignals() {
  try {
    const result = getLatestDiseaseSignals();
    if (result.error) {
      console.warn('[intelligence-orchestrator] Disease signal collection failed:', result.reason);
      return [];
    }
    console.log(`[intelligence-orchestrator] Disease: collected ${result.signals.length} signal(s).`);
    return result.signals.map((s) => ({
      source: 'Disease',
      category: s.category,
      signal: s.disease,
      expectedDemand: toBusinessDemand(s.expectedDemand),
      confidence: clamp01(s.evidenceScore),
      rationale: s.rationale,
      metadata: { trend: s.trend },
    }));
  } catch (err) {
    console.warn('[intelligence-orchestrator] Disease signal collection failed:', err.message);
    return [];
  }
}

// ---- public API -----------------------------------------------------------

/**
 * @param {string} organizationId
 * @returns {Promise<import('./businessSignal').BusinessSignal[]>}
 */
async function collectBusinessSignals(organizationId) {
  console.log('[intelligence-orchestrator] Collecting signals...');

  const [weather, calendar, disease] = await Promise.all([
    collectWeatherSignals(organizationId),
    Promise.resolve(collectCalendarSignals()),
    Promise.resolve(collectDiseaseSignals()),
  ]);

  const combined = [...weather, ...calendar, ...disease];
  console.log(`[intelligence-orchestrator] Done — ${combined.length} total signal(s) (Weather: ${weather.length}, Calendar: ${calendar.length}, Disease: ${disease.length}).`);
  return combined;
}

module.exports = { collectBusinessSignals };
