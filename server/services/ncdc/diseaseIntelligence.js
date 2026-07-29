/**
 * Disease Intelligence Engine.
 *
 * Single responsibility: convert normalized DiseaseObservation[] into
 * structured DiseaseSignal[] — disease-to-category mapping plus an
 * observed trend. Does NOT generate recommendations, reorder alerts,
 * calculate reorder quantities, access inventory or sales, estimate
 * financial impact, or connect to Weather / Calendar / the Decision
 * Engine. Consumes ONLY normalized DiseaseObservation records — it does
 * not parse report prose or infer locations from narrative text itself
 * (see BACKLOG.md's "Narrative State Extraction" entry for why that's a
 * deliberately deferred, separate concern).
 */

const fs = require('fs');
const path = require('path');
const { DISEASE_RULES } = require('./diseaseRules');

const HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'disease-observation-history.json');

// A change smaller than this is treated as noise, not a real trend.
const TREND_THRESHOLD_PCT = 10;

// ---- observation history (needed for trend comparison across weeks) -----

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (_) { /* corrupt file — start fresh rather than crash */ }
  return [];
}

function appendToHistory(observations) {
  try {
    const history = loadHistory();
    const key = (o) => `${o.disease}|${o.state}|${o.year}|${o.epiWeek}`;
    const existingKeys = new Set(history.map(key));
    const additions = observations.filter((o) => !existingKeys.has(key(o)));
    if (additions.length === 0) return;
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify([...history, ...additions], null, 2), 'utf8');
  } catch (err) {
    console.warn('[disease-intelligence] Could not persist observation history:', err.message);
  }
}

/** Most recent observation for the same disease+state strictly before the current (year, epiWeek). */
function findPriorObservation(history, obs) {
  const candidates = history.filter((h) =>
    h.disease === obs.disease && h.state === obs.state &&
    (h.year < obs.year || (h.year === obs.year && h.epiWeek < obs.epiWeek))
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.year - a.year) || (b.epiWeek - a.epiWeek));
  return candidates[0];
}

/**
 * Increasing / Stable / Decreasing — observed only, never predictive.
 * No prior data to compare against is itself an honest "Stable" (i.e.
 * "no direction can be claimed"), not a guess in either direction.
 */
function classifyTrend(current, prior) {
  if (!prior) return 'Stable';
  if (prior.cases === 0) return current.cases > 0 ? 'Increasing' : 'Stable';
  const pctChange = ((current.cases - prior.cases) / prior.cases) * 100;
  if (pctChange > TREND_THRESHOLD_PCT) return 'Increasing';
  if (pctChange < -TREND_THRESHOLD_PCT) return 'Decreasing';
  return 'Stable';
}

function expectedDemandFromTrend(trend) {
  if (trend === 'Increasing') return 'Increase';
  if (trend === 'Decreasing') return 'Decrease';
  return 'Neutral';
}

function isCompleteObservation(obs) {
  return !!(obs && obs.disease && obs.state && obs.epiWeek != null && obs.year != null && obs.cases != null);
}

/**
 * @param {import('./ncdcTypes').DiseaseObservation[]} observations
 * @returns {{error:false, signals:import('./ncdcTypes').DiseaseSignal[]} | {error:true, reason:string}}
 */
function evaluateDiseaseIntelligence(observations) {
  console.log('[disease-intelligence] Disease intelligence started');

  if (!Array.isArray(observations)) {
    console.warn('[disease-intelligence] Disease intelligence failed: expected an array of DiseaseObservation.');
    return { error: true, reason: 'DiseaseObservation[] required.' };
  }

  try {
    const history = loadHistory();
    const signals = [];

    for (const obs of observations) {
      if (!isCompleteObservation(obs)) {
        console.warn('[disease-intelligence] Skipped incomplete observation:', JSON.stringify(obs));
        continue;
      }

      const rules = DISEASE_RULES.filter((r) => r.disease === obs.disease);
      if (rules.length === 0) {
        console.log(`[disease-intelligence] Ignored — no configured mapping for "${obs.disease}".`);
        continue;
      }
      console.log(`[disease-intelligence] Disease mapped: ${obs.disease} -> ${rules.map((r) => r.category).join(', ')}`);

      const prior = findPriorObservation(history, obs);
      const trend = classifyTrend(obs, prior);
      console.log(`[disease-intelligence] Trend calculated: ${obs.disease} in ${obs.state} (week ${obs.epiWeek}) -> ${trend}${prior ? ` (vs. week ${prior.epiWeek}: ${prior.cases} cases)` : ' (no prior data)'}`);

      const expectedDemand = expectedDemandFromTrend(trend);
      // A trend computed against real prior data is more trustworthy than
      // one defaulted to "Stable" purely for lack of comparison data.
      const confidenceFactor = prior ? 1 : 0.85;

      for (const rule of rules) {
        const evidenceScore = Math.round(rule.evidenceScore * confidenceFactor * 100) / 100;
        signals.push({
          disease: obs.disease,
          category: rule.category,
          trend,
          expectedDemand,
          evidenceScore,
          rationale: rule.rationale,
          source: 'NCDC',
        });
        console.log(`[disease-intelligence] Signal generated: ${obs.disease} -> ${rule.category} (${expectedDemand}, evidenceScore ${evidenceScore})`);
      }
    }

    // Only ever persist complete, valid observations — an incomplete one
    // that was skipped above (e.g. missing state) shouldn't linger in
    // history just because it happened to arrive in this batch.
    appendToHistory(observations.filter(isCompleteObservation));
    console.log('[disease-intelligence] Disease intelligence completed');
    return { error: false, signals };
  } catch (err) {
    console.warn('[disease-intelligence] Disease intelligence failed:', err.message);
    return { error: true, reason: err.message };
  }
}

/**
 * The observations from the most recent epidemiological week on record —
 * i.e. "what's currently known" without re-running report discovery /
 * download / parsing. Additive export only; exposes existing history data,
 * introduces no new evaluation logic.
 */
function getLatestObservations() {
  const history = loadHistory();
  if (history.length === 0) return [];
  const latest = history.reduce((max, o) =>
    (!max || o.year > max.year || (o.year === max.year && o.epiWeek > max.epiWeek)) ? o : max
  , null);
  return history.filter((o) => o.year === latest.year && o.epiWeek === latest.epiWeek);
}

/** Convenience wrapper: evaluate signals for the latest known observations. */
function getLatestDiseaseSignals() {
  return evaluateDiseaseIntelligence(getLatestObservations());
}

module.exports = { evaluateDiseaseIntelligence, getLatestObservations, getLatestDiseaseSignals };
