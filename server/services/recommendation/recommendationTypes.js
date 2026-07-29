/**
 * Recommendation Engine — type definition only. No logic, no I/O.
 *
 * @typedef {Object} Recommendation
 * @property {string} id
 * @property {string} opportunityId - Traces back to the DecisionOpportunity this was derived from.
 * @property {"Sales"|"Inventory"|"Profitability"|"Customer"|"Operations"} pillar
 * @property {"Critical"|"High"|"Medium"|"Low"} priority
 * @property {string} action
 * @property {string[]} reason - The opportunity's own evidence, carried through unchanged.
 * @property {number} [estimatedStockoutRisk] - 0-100, only when coverage data was available.
 * @property {number} [financialImpact] - NGN, carried through from the opportunity when present.
 * @property {number} confidence - 0.0-1.0, carried through from the opportunity.
 */

module.exports = {};
