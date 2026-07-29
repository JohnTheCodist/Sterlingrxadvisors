/**
 * Signal Fusion Engine — source reliability weights.
 *
 * Lives here, not in signalFusionEngine.js, specifically so these can be
 * tuned later against real pharmacy outcomes without touching the fusion
 * logic itself. Disease surveillance data is the most direct evidence
 * (real observed case counts); Weather is a clinical correlation, one
 * step more indirect; Calendar is the most indirect (seasonal/cultural
 * pattern, no observed health data at all).
 */

const SOURCE_WEIGHTS = {
  Disease: 1.0,
  Weather: 0.8,
  Calendar: 0.6,
};

module.exports = { SOURCE_WEIGHTS };
