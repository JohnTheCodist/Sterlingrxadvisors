/**
 * Intelligence Orchestrator — type definition only. No logic, no I/O.
 *
 * The one common shape every intelligence source's output gets converted
 * into. `signal` names WHAT triggered it (e.g. "High Humidity", "Christmas",
 * "Malaria") — distinct from `category`, which is the pharmacy therapeutic
 * category it affects (e.g. "Anti-Malarial"). Source-specific detail that
 * doesn't fit the common fields goes in `metadata`, not by adding new
 * top-level fields per source.
 *
 * @typedef {Object} BusinessSignal
 * @property {"Weather"|"Calendar"|"Disease"} source
 * @property {string} category
 * @property {string} signal
 * @property {"Increase"|"Decrease"|"Neutral"} expectedDemand
 * @property {number} confidence - 0.0-1.0, normalized from whatever scale the source uses natively.
 * @property {string} rationale
 * @property {Record<string, unknown>} [metadata]
 */

module.exports = {};
