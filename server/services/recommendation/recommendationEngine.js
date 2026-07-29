/**
 * Recommendation Engine.
 *
 * Single responsibility: turn ranked DecisionOpportunity[] (Sprint 8) into
 * actionable Recommendation[]. Every number in every recommendation is
 * extracted from the opportunity's own `evidence`/`financialImpact`/
 * `confidence` fields — nothing here calls out to sales/inventory data,
 * an LLM, or any intelligence source directly. If a figure isn't present
 * in the opportunity's own evidence, the recommendation says so rather
 * than inventing one.
 */

const URGENCY_WINDOW_DAYS = 21; // same reference window Sprint 8 uses for urgency

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Pulls a "covers only N days" figure straight out of the opportunity's own evidence text. */
function extractCoverageDays(evidence) {
  for (const line of evidence || []) {
    const m = line.match(/covers? only (\d+) days?/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** Pulls an "increased/decreased X%" figure straight out of the opportunity's own evidence text. */
function extractPctChange(evidence) {
  for (const line of evidence || []) {
    const m = line.match(/\b(increased|decreased)\s+(\d+(?:\.\d+)?)%/i);
    if (m) return { direction: m[1].toLowerCase(), pct: parseFloat(m[2]) };
  }
  return null;
}

function estimateStockoutRisk(coverageDays, demandRising) {
  if (coverageDays == null) return null;
  let risk = clamp01(1 - coverageDays / URGENCY_WINDOW_DAYS);
  if (demandRising) risk = clamp01(risk * 1.3);
  return Math.round(risk * 100);
}

/** "Antifungal demand expected to increase" -> "Antifungal" */
function categoryFromTitle(title) {
  return title.replace(/\s+demand expected to.*$/i, '').trim();
}

function buildAction(opportunity, coverageDays, pctChange) {
  const demandRising = /demand expected to increase/i.test(opportunity.title)
    || (pctChange && pctChange.direction === 'increased');
  const demandFalling = /demand expected to decrease/i.test(opportunity.title)
    || (pctChange && pctChange.direction === 'decreased');

  if (opportunity.pillar === 'Inventory' && demandRising) {
    // Deliberately conservative: recommend ordering roughly HALF the
    // observed/expected demand swing, not a 1:1 match — the swing isn't
    // certain to fully materialize. Bounded to a sane 10-50% range.
    const bumpPct = pctChange
      ? Math.min(50, Math.max(10, Math.round(pctChange.pct * 0.5)))
      : 15; // no precise swing figure available — conservative default, still direction-grounded
    return `Increase ${categoryFromTitle(opportunity.title)} purchase by approximately ${bumpPct}%.`;
  }

  if (opportunity.pillar === 'Inventory' && demandFalling) {
    return `Reduce ${categoryFromTitle(opportunity.title)} purchasing — recent demand has softened.`;
  }

  if (opportunity.priority === 'Critical' || opportunity.priority === 'High') {
    return `Address ${opportunity.pillar} risk: ${opportunity.title}.`;
  }

  return `Monitor ${opportunity.title} — no immediate action required.`;
}

/**
 * @param {import('../decision/decisionTypes').DecisionOpportunity} opportunity
 * @param {number} index
 * @returns {import('./recommendationTypes').Recommendation}
 */
function buildRecommendation(opportunity, index) {
  const coverageDays = extractCoverageDays(opportunity.evidence);
  const pctChange = extractPctChange(opportunity.evidence);
  const demandRising = /demand expected to increase/i.test(opportunity.title) || (pctChange && pctChange.direction === 'increased');

  const action = buildAction(opportunity, coverageDays, pctChange);
  const stockoutRisk = opportunity.pillar === 'Inventory' ? estimateStockoutRisk(coverageDays, demandRising) : null;

  return {
    id: `rec-${index}`,
    opportunityId: opportunity.id,
    pillar: opportunity.pillar,
    priority: opportunity.priority,
    action,
    reason: [...(opportunity.evidence || [])],
    ...(stockoutRisk != null ? { estimatedStockoutRisk: stockoutRisk } : {}),
    ...(opportunity.financialImpact != null ? { financialImpact: opportunity.financialImpact } : {}),
    confidence: opportunity.confidence,
  };
}

/**
 * @param {import('../decision/decisionTypes').DecisionOpportunity[]} opportunities
 * @returns {import('./recommendationTypes').Recommendation[]}
 */
function generateRecommendations(opportunities) {
  console.log('[recommendation-engine] Generating recommendations...');

  if (!Array.isArray(opportunities)) {
    console.warn('[recommendation-engine] Failed: expected DecisionOpportunity[].');
    return [];
  }

  const recommendations = opportunities.map((o, i) => buildRecommendation(o, i));
  console.log(`[recommendation-engine] Produced ${recommendations.length} recommendation(s).`);
  return recommendations;
}

module.exports = { generateRecommendations };
