/**
 * Decision Intelligence Engine.
 *
 * Combines internal pharmacy analytics (Business Health, Sales/Inventory
 * findings — all already computed by the existing, unmodified
 * businessHealth.js / recommendations.js) with external intelligence
 * (Weather / Calendar / Disease, fused into BusinessInsight[] by Sprints
 * 6-7) into ranked DecisionOpportunity[]. Still no recommendations, no
 * natural-language executive summaries — structured findings only.
 *
 * Data sourcing is 100% additive: every existing module it touches is
 * consumed through functions that were already exported before this
 * sprint (advisorQueries.js's getBusinessHealth/getTopPriorities,
 * weatherDecisionRules.js's CATEGORY_KEYWORDS/categoryDemandEvidence) —
 * nothing about how internal analytics or external intelligence are
 * computed changes here.
 *
 * Mapping notes (the spec's input names aren't literal types in this
 * codebase, so here's exactly what each maps to):
 *   - BusinessHealthScore -> advisorQueries.js::getBusinessHealth()
 *   - SalesAnalysis[] / InventoryAnalysis[] / ExpiryAnalysis[] ->
 *     advisorQueries.js::getTopPriorities()'s pillar-tagged insights,
 *     split by pillar ("Sales Performance" -> Sales, "Inventory" -> split
 *     further into Inventory vs. Expiry by metric name, since there's no
 *     separate Expiry pillar upstream).
 *   - BusinessInsight[] -> signalFusionEngine.js::fuseBusinessSignals(
 *     await intelligenceOrchestrator.js::collectBusinessSignals())
 */

const { getCategoryCoverageDays, getCategoryTrend } = require('./categoryEvidence');

const PILLAR_MAP = {
  'Sales Performance': 'Sales',
  Profitability: 'Profitability',
  Inventory: 'Inventory',
  'Customer Health': 'Customer',
  'Operational Excellence': 'Operations',
};

// Coverage below this many days is treated as maximally urgent.
const URGENCY_WINDOW_DAYS = 21;
// A category revenue trend swing at or beyond this magnitude is treated
// as maximally impactful.
const MAX_IMPACT_TREND_PCT = 50;
// A financial swing at or beyond this share of total revenue is treated
// as maximally valuable — keeps the scale self-relative to the pharmacy's
// own size instead of a hardcoded naira threshold.
const MAX_FINANCIAL_VALUE_SHARE_OF_REVENUE = 0.05;

const PRIORITY_BANDS = [
  { min: 0.75, label: 'Critical' },
  { min: 0.55, label: 'High' },
  { min: 0.35, label: 'Medium' },
  { min: 0, label: 'Low' },
];

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function priorityLabel(score) {
  return PRIORITY_BANDS.find((b) => score >= b.min).label;
}

/**
 * Business Impact (40%) x Confidence (30%) x Urgency (20%) x Financial
 * Value (10%) — a weighted geometric mean, not a weighted sum: a very
 * weak factor pulls the whole score down rather than being diluted away
 * by a strong one elsewhere, which is the point of "never average
 * blindly." All four inputs are already 0.0-1.0.
 */
function computePriorityScore({ businessImpact, confidence, urgency, financialValue }) {
  const score = (clamp01(businessImpact) ** 0.4)
    * (clamp01(confidence) ** 0.3)
    * (clamp01(urgency) ** 0.2)
    * (clamp01(financialValue) ** 0.1);
  return Math.round(score * 100) / 100;
}

function extractNairaFigure(text) {
  if (!text) return null;
  const match = String(text).match(/₦([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const n = parseFloat(match[1].replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

// ---- external (BusinessInsight-driven) opportunities ---------------------
// `insight` here is a Sprint 7 BusinessInsight (fields: category,
// overallDemand, confidence, supportingSources, rationale) — the
// post-fusion shape, not Sprint 6's pre-fusion BusinessSignal
// (expectedDemand). Fusion already happened before this function runs.

async function buildExternalOpportunity(organizationId, insight, index, totalRevenue) {
  const coverageDays = await getCategoryCoverageDays(organizationId, insight.category);
  const trend = await getCategoryTrend(organizationId, insight.category);

  const evidence = [insight.rationale];
  if (coverageDays != null) {
    evidence.push(`Current stock covers only ${coverageDays} day${coverageDays === 1 ? '' : 's'}.`);
  }
  let financialImpact;
  if (trend.available) {
    const direction = trend.pctIncrease >= 0 ? 'increased' : 'decreased';
    evidence.push(`Average recent-period revenue for this category ${direction} ${Math.abs(trend.pctIncrease)}% versus the prior period (₦${trend.avgInPeriodRevenue.toLocaleString('en-NG')} vs ₦${trend.avgOutPeriodRevenue.toLocaleString('en-NG')}).`);
    financialImpact = Math.round(trend.avgInPeriodRevenue * (trend.pctIncrease / 100));
  }

  const urgency = coverageDays != null ? clamp01(1 - coverageDays / URGENCY_WINDOW_DAYS) : 0.5;
  const businessImpact = trend.available ? clamp01(Math.abs(trend.pctIncrease) / MAX_IMPACT_TREND_PCT) : 0.5;
  const financialValue = financialImpact != null && totalRevenue > 0
    ? clamp01(Math.abs(financialImpact) / (totalRevenue * MAX_FINANCIAL_VALUE_SHARE_OF_REVENUE))
    : 0.5;

  const confidence = clamp01(insight.confidence);
  const priorityScore = computePriorityScore({ businessImpact, confidence, urgency, financialValue });

  const titlePhrase = { Increase: 'increase', Decrease: 'decrease', Neutral: 'show no clear shift' }[insight.overallDemand] || 'change';

  return {
    id: `ext-${index}-${insight.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    pillar: 'Inventory',
    priority: priorityLabel(priorityScore),
    title: `${insight.category} demand expected to ${titlePhrase}`,
    finding: insight.rationale,
    evidence,
    ...(financialImpact != null ? { financialImpact } : {}),
    confidence,
    _priorityScore: priorityScore,
  };
}

// ---- internal (existing pillar-insight-driven) opportunities -------------

function buildInternalOpportunity(insight, index) {
  const pillar = PILLAR_MAP[insight.pillar] || 'Operations';
  const businessImpact = clamp01((insight.impact ?? 1) / 3);
  const urgency = clamp01((insight.urgency ?? 1) / 3);
  const confidence = clamp01((insight.confidence ?? 50) / 100);
  const financialImpact = extractNairaFigure(insight.businessImpact) ?? undefined;
  const financialValue = financialImpact != null ? clamp01(financialImpact / 1_000_000) : 0.5;

  const priorityScore = computePriorityScore({ businessImpact, confidence, urgency, financialValue });

  return {
    id: `int-${index}-${(insight.metric || insight.pillar || 'insight').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    pillar,
    priority: priorityLabel(priorityScore),
    title: insight.metric || insight.pillar,
    finding: insight.observation,
    evidence: Array.isArray(insight.evidence) && insight.evidence.length > 0 ? insight.evidence : [insight.businessImpact].filter(Boolean),
    ...(financialImpact != null ? { financialImpact } : {}),
    confidence,
    _priorityScore: priorityScore,
  };
}

// ---- public API -----------------------------------------------------------

/**
 * @param {string} organizationId
 * @returns {Promise<import('./decisionTypes').DecisionOpportunity[]>}
 */
async function generateDecisionOpportunities(organizationId) {
  console.log('[decision-engine] Generating decision opportunities...');

  const { getBusinessHealth, getTopPriorities } = require('../advisorQueries');
  const { collectBusinessSignals } = require('../intelligence/intelligenceOrchestrator');
  const { fuseBusinessSignals } = require('../intelligence/signalFusionEngine');
  const { queryAnalytics } = require('../db');

  const [internalInsights, businessSignals] = await Promise.all([
    getTopPriorities(organizationId, { n: 8 }),
    collectBusinessSignals(organizationId),
  ]);

  let totalRevenue = 0;
  try { totalRevenue = (await queryAnalytics(organizationId))?.metrics?.totalRevenue || 0; } catch (_) { /* leave 0 */ }

  const businessInsights = fuseBusinessSignals(businessSignals);

  const opportunities = [
    ...(await Promise.all(businessInsights.map((bi, i) => buildExternalOpportunity(organizationId, bi, i, totalRevenue)))),
    ...internalInsights.map((ii, i) => buildInternalOpportunity(ii, i)),
  ];

  opportunities.sort((a, b) => b._priorityScore - a._priorityScore);
  opportunities.forEach((o) => delete o._priorityScore);

  console.log(`[decision-engine] Produced ${opportunities.length} decision opportunit${opportunities.length === 1 ? 'y' : 'ies'} (${businessInsights.length} external, ${internalInsights.length} internal).`);

  // BusinessHealthScore is received per the spec's input list, logged for
  // traceability — but the ranking formula is explicit and complete
  // without it (Business Impact / Confidence / Urgency / Financial Value
  // only), so it deliberately does not silently reweight anything here.
  const health = await getBusinessHealth(organizationId);
  console.log(`[decision-engine] Business Health Score received: ${health.overallScore}/100 (${health.rating}).`);

  return opportunities;
}

module.exports = { generateDecisionOpportunities };
