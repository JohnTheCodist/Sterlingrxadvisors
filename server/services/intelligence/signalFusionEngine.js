/**
 * Signal Fusion Engine.
 *
 * Single responsibility: consolidate BusinessSignal[] (Sprint 6's
 * Intelligence Orchestrator output) into one BusinessInsight per
 * therapeutic category. Does NOT recommend stock quantities or purchases,
 * estimate financial impact, read sales/inventory data, or connect to the
 * Decision Engine — fusion only.
 *
 * Algorithm (deterministic, not a blind average):
 *   1. Group signals by category.
 *   2. For each demand direction (Increase/Decrease/Neutral), sum
 *      SOURCE_WEIGHTS[source] * confidence across signals voting that way
 *      — a weighted "vote score" per direction.
 *   3. overallDemand = the direction with the highest vote score. If
 *      Increase and Decrease tie with real (nonzero) support on both
 *      sides, that's a genuine standoff, not a coin flip — overallDemand
 *      is forced to Neutral and no source is credited as "supporting" a
 *      conclusion nobody actually voted for.
 *   4. Base confidence = the weighted-average confidence *among only the
 *      signals supporting the winning direction* (not all signals — an
 *      opposing or neutral vote elsewhere doesn't get averaged into how
 *      confident the winning side is in itself).
 *   5. Agreement bonus: each additional distinct source beyond the first
 *      that supports the winning direction adds a small, capped bonus —
 *      this is what makes multiple independent sources agreeing raise
 *      confidence *above* what a weighted average alone would give.
 *   6. Conflict penalty: if there's real opposing-direction support
 *      (both Increase and Decrease present with nonzero weight), a flat
 *      penalty is applied — Neutral signals alongside a winner are not a
 *      conflict, just an absence of an opinion.
 */

const { SOURCE_WEIGHTS } = require('./sourceWeights');

const DEFAULT_WEIGHT = 0.5; // for a source not listed in SOURCE_WEIGHTS
const AGREEMENT_BONUS_PER_EXTRA_SOURCE = 0.03;
const MAX_AGREEMENT_BONUS = 0.15;
const CONFLICT_PENALTY = 0.2;

function weightOf(source) {
  return SOURCE_WEIGHTS[source] ?? DEFAULT_WEIGHT;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function groupByCategory(signals) {
  const groups = new Map();
  for (const s of signals) {
    if (!s || !s.category) continue;
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  return groups;
}

function directionScores(signals) {
  const byDirection = { Increase: [], Decrease: [], Neutral: [] };
  for (const s of signals) {
    if (byDirection[s.expectedDemand]) byDirection[s.expectedDemand].push(s);
  }
  const scoreOf = (dir) => byDirection[dir].reduce((sum, s) => sum + weightOf(s.source) * clamp01(s.confidence), 0);
  return {
    byDirection,
    scores: { Increase: scoreOf('Increase'), Decrease: scoreOf('Decrease'), Neutral: scoreOf('Neutral') },
  };
}

function sourceListPhrase(sources) {
  if (sources.length === 0) return '';
  if (sources.length === 1) return sources[0];
  return `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`;
}

// Groups signals by source and names the specific event/disease driving
// each one (e.g. "Calendar (School Vacation)") instead of just the source
// name — otherwise the rationale is anonymized down to "Calendar indicates
// increased demand," losing the one detail (Christmas, Ramadan, Yellow
// Fever, ...) that makes the finding traceable and useful to read.
function describeSignals(signalList) {
  const bySource = new Map();
  for (const s of signalList) {
    if (!bySource.has(s.source)) bySource.set(s.source, new Set());
    if (s.signal) bySource.get(s.source).add(s.signal);
  }
  const phrases = [...bySource.entries()].map(([source, events]) => (
    events.size > 0 ? `${source} (${[...events].join(', ')})` : source
  ));
  return sourceListPhrase(phrases);
}

const DEMAND_PHRASE = {
  Increase: 'increased demand',
  Decrease: 'decreased demand',
  Neutral: 'no clear demand shift',
};

function buildRationale({ overallDemand, supportingSignals, byDirection, hasConflict }) {
  const parts = [];
  const supportingSources = [...new Set(supportingSignals.map((s) => s.source))];

  if (hasConflict) {
    const up = byDirection.Increase;
    const down = byDirection.Decrease;
    parts.push(`${describeSignals(up)} indicate${new Set(up.map((s) => s.source)).size === 1 ? 's' : ''} increased demand while ${describeSignals(down)} indicate${new Set(down.map((s) => s.source)).size === 1 ? 's' : ''} decreased demand — sources conflict, confidence reduced accordingly.`);
  } else if (supportingSignals.length > 0) {
    const both = supportingSources.length > 1 ? ' both' : '';
    const verb = supportingSources.length > 1 ? 'indicate' : 'indicates';
    parts.push(`${describeSignals(supportingSignals)}${both} ${verb} ${DEMAND_PHRASE[overallDemand]}.`);
  } else {
    parts.push('No sources provided a usable signal for this category.');
  }

  for (const dir of ['Increase', 'Decrease', 'Neutral']) {
    if (dir === overallDemand || hasConflict) continue;
    const signals = byDirection[dir];
    if (signals.length === 0) continue;
    const plural = new Set(signals.map((s) => s.source)).size > 1;
    const noun = plural ? 'signals' : 'signal';
    parts.push(dir === 'Neutral'
      ? `${describeSignals(signals)} ${noun} ${plural ? 'are' : 'is'} neutral.`
      : `${describeSignals(signals)} ${noun} ${plural ? 'indicate' : 'indicates'} ${DEMAND_PHRASE[dir]}.`);
  }

  return parts.join(' ');
}

/**
 * @param {string} category
 * @param {import('./businessSignal').BusinessSignal[]} signals - all signals for this one category
 * @returns {import('./businessInsight').BusinessInsight}
 */
function fuseCategory(category, signals) {
  const { byDirection, scores } = directionScores(signals);

  const hasConflict = scores.Increase > 0 && scores.Decrease > 0;

  let overallDemand;
  if (scores.Increase === scores.Decrease && scores.Increase > 0) {
    overallDemand = 'Neutral'; // genuine standoff — not a real "neutral" vote, just no winner
  } else {
    overallDemand = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }

  // In a forced standoff, no source actually voted for "Neutral" as the
  // conclusion — traceability should reflect that nobody supports this
  // specific non-conclusion, not falsely credit one side.
  const isForcedStandoff = hasConflict && overallDemand === 'Neutral' && byDirection.Neutral.length === 0;
  const supportingSignals = isForcedStandoff ? [] : byDirection[overallDemand];
  const supportingSources = [...new Set(supportingSignals.map((s) => s.source))];

  const supportingWeight = supportingSignals.reduce((sum, s) => sum + weightOf(s.source), 0);
  const baseConfidence = supportingWeight > 0
    ? supportingSignals.reduce((sum, s) => sum + weightOf(s.source) * clamp01(s.confidence), 0) / supportingWeight
    : 0;

  const bonus = Math.min(MAX_AGREEMENT_BONUS, Math.max(0, supportingSources.length - 1) * AGREEMENT_BONUS_PER_EXTRA_SOURCE);
  const penalty = hasConflict ? CONFLICT_PENALTY : 0;
  const confidence = Math.round(clamp01(baseConfidence + bonus - penalty) * 100) / 100;

  const rationale = buildRationale({ overallDemand, supportingSignals, byDirection, hasConflict: isForcedStandoff || hasConflict });

  return { category, overallDemand, confidence, supportingSources, rationale };
}

/**
 * @param {import('./businessSignal').BusinessSignal[]} signals
 * @returns {import('./businessInsight').BusinessInsight[]}
 */
function fuseBusinessSignals(signals) {
  console.log('[signal-fusion] Fusion started');

  if (!Array.isArray(signals)) {
    console.warn('[signal-fusion] Fusion failed: expected BusinessSignal[].');
    return [];
  }

  const groups = groupByCategory(signals);
  const insights = [];

  for (const [category, categorySignals] of groups) {
    const insight = fuseCategory(category, categorySignals);
    console.log(`[signal-fusion] ${category}: ${insight.overallDemand} (confidence ${insight.confidence}, sources: ${insight.supportingSources.join(', ') || 'none'})`);
    insights.push(insight);
  }

  console.log(`[signal-fusion] Fusion completed — ${insights.length} insight(s) across ${groups.size} categor${groups.size === 1 ? 'y' : 'ies'}.`);
  return insights;
}

module.exports = { fuseBusinessSignals };
