/**
 * Calendar Intelligence — type definitions only. No logic, no I/O.
 *
 * @typedef {Object} CalendarDemandRule
 * @property {string} event - Calendar event name (e.g. "Christmas").
 * @property {string} category - Pharmacy therapeutic category.
 * @property {'Increase'|'Decrease'|'Neutral'} expectedDemand - Expected change in demand.
 * @property {'Strong'|'Moderate'|'Limited'} evidenceStrength - Strength of supporting evidence.
 * @property {string} rationale - Short business explanation.
 * @property {number} startOffsetDays - Days before the event the signal becomes active (negative = before).
 * @property {number} endOffsetDays - Days after the event the signal expires.
 */

module.exports = {};
