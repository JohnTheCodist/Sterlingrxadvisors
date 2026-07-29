/**
 * Decision Intelligence Engine — type definition only. No logic, no I/O.
 *
 * @typedef {Object} DecisionOpportunity
 * @property {string} id
 * @property {"Sales"|"Inventory"|"Profitability"|"Customer"|"Operations"} pillar
 * @property {"Critical"|"High"|"Medium"|"Low"} priority
 * @property {string} title
 * @property {string} finding
 * @property {string[]} evidence
 * @property {number} [financialImpact] - NGN, only present when it could be honestly estimated.
 * @property {number} confidence - 0.0-1.0
 */

module.exports = {};
