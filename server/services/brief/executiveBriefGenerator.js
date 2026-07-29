/**
 * Executive Brief Generator.
 *
 * Single responsibility: combine Business Health Score, ranked
 * DecisionOpportunity[] (Sprint 8), and Recommendation[] (Sprint 9) into
 * one McKinsey-style brief.
 *
 * Deliberate design choice: "Overall Assessment" is built by a
 * deterministic template that stitches together real `finding` sentences
 * already produced by the Decision Engine — it is NOT an LLM call. Every
 * other sprint in this pipeline has been built on "derived from evidence,
 * not invented"; this is the first layer that produces connected prose,
 * and the least risky way to keep that same discipline is to compose real
 * sentences rather than generate new ones. AI Copilot (Sprint 11) is where
 * free-form language generation belongs, grounded in reading this
 * structured brief — not before it.
 */

const POSITIVE_WORDS = /\b(grew|increased|grow|strong|improv\w*)\b/i;
const NEGATIVE_WORDS = /\b(fell|declin\w*|drop\w*|risk\w*|volatil\w*|weak|critical)\b/i;

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Some upstream finding text carries incidental trailing whitespace —
// normalize before stitching sentences together so joins never produce a
// double space, without needing to touch (or care about) where it came from.
function clean(s) {
  return (s || '').trim().replace(/\s+/g, ' ');
}

/**
 * Stitches the top two opportunities' own `finding` sentences into one
 * assessment. Uses a contrast connector ("...However, ...") only when the
 * top finding reads positive and the next reads negative — otherwise
 * joins them plainly rather than forcing a contrast the data doesn't
 * support.
 */
function buildOverallAssessment(opportunities) {
  if (opportunities.length === 0) return 'No decision opportunities were identified from the available data.';
  const top = opportunities[0];
  const second = opportunities.find((o) => o.pillar !== top.pillar && o.id !== top.id);

  const topFinding = clean(top.finding);
  if (!second) return topFinding;
  const secondFinding = clean(second.finding);

  const topReadsPositive = POSITIVE_WORDS.test(topFinding) && !NEGATIVE_WORDS.test(topFinding);
  const secondReadsNegative = NEGATIVE_WORDS.test(secondFinding);

  if (topReadsPositive && secondReadsNegative) {
    return `${topFinding} However, ${lowerFirst(secondFinding)}`;
  }
  return `${topFinding} ${secondFinding}`;
}

/**
 * Top evidence bullets across the highest-ranked opportunities (already
 * priority-sorted by the Decision Engine) — real sentences, not
 * summarized or reworded.
 */
function buildEvidence(opportunities, maxBullets = 5) {
  const bullets = [];
  for (const o of opportunities) {
    for (const line of o.evidence || []) {
      if (bullets.length >= maxBullets) break;
      if (!bullets.includes(line)) bullets.push(line);
    }
    if (bullets.length >= maxBullets) break;
  }
  return bullets;
}

/**
 * Sums whatever financialImpact figures the opportunities actually have.
 * Deliberately does NOT label this "annual" — the underlying figures come
 * from mixed time periods (some monthly trend deltas, some extracted from
 * existing insight text with no tracked period), so claiming an annual
 * figure would overstate precision this data doesn't support.
 */
function buildFinancialOpportunity(opportunities) {
  const withImpact = opportunities.filter((o) => o.financialImpact != null);
  if (withImpact.length === 0) return null;
  const total = withImpact.reduce((sum, o) => sum + o.financialImpact, 0);
  return {
    amount: Math.round(total),
    description: `Estimated financial opportunity across ${withImpact.length} identified finding${withImpact.length === 1 ? '' : 's'} (₦${Math.round(total).toLocaleString('en-NG')}).`,
  };
}

/**
 * @param {import('../decision/decisionTypes').DecisionOpportunity[]} opportunities - already priority-ranked
 * @param {import('../recommendation/recommendationTypes').Recommendation[]} recommendations - 1:1 with opportunities
 * @param {{overallScore:number, rating:string}} businessHealth
 * @returns {import('./executiveBriefTypes').ExecutiveBrief}
 */
function generateExecutiveBrief(opportunities, recommendations, businessHealth) {
  console.log('[executive-brief] Generating brief...');

  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    console.warn('[executive-brief] No opportunities available — returning an empty brief.');
    return {
      businessHealth: { score: businessHealth?.overallScore ?? 0, rating: businessHealth?.rating ?? 'Unknown' },
      overallAssessment: 'No decision opportunities were identified from the available data.',
      evidence: [],
      financialOpportunity: null,
      highestPriority: 'No action required at this time.',
      confidence: 0,
    };
  }

  const topRecommendation = recommendations.find((r) => r.opportunityId === opportunities[0].id) || recommendations[0];

  const brief = {
    businessHealth: { score: businessHealth.overallScore, rating: businessHealth.rating },
    overallAssessment: buildOverallAssessment(opportunities),
    evidence: buildEvidence(opportunities),
    financialOpportunity: buildFinancialOpportunity(opportunities),
    highestPriority: topRecommendation ? topRecommendation.action : opportunities[0].title,
    confidence: opportunities[0].confidence,
  };

  console.log('[executive-brief] Brief generated.');
  return brief;
}

module.exports = { generateExecutiveBrief };
