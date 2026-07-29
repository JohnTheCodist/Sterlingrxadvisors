/**
 * Weather Types — pure classification rules. No API calls, no DB access,
 * no dashboard concerns. Numbers in, business-risk labels out.
 *
 * The rest of the platform should never think in millimetres or degrees —
 * only in LOW / MEDIUM / HIGH risk.
 */

function classifyRainfall(mm) {
  if (mm == null) return 'UNKNOWN';
  if (mm >= 80) return 'HIGH';
  if (mm >= 20) return 'MEDIUM';
  return 'LOW';
}

function classifyHumidity(pct) {
  if (pct == null) return 'UNKNOWN';
  if (pct >= 80) return 'HIGH';
  if (pct >= 60) return 'MEDIUM';
  return 'LOW';
}

function classifyHeatwave(celsius) {
  if (celsius == null) return 'UNKNOWN';
  if (celsius >= 36) return 'HIGH';
  if (celsius >= 32) return 'MEDIUM';
  return 'LOW';
}

const HARMATTAN_MONTHS = new Set([11, 12, 1, 2]);
const HARMATTAN_CONDITIONS = new Set(['dust', 'haze', 'smoke']);

/**
 * Harmattan (dry, dusty West-African trade wind) doesn't map to a single
 * OpenWeather field. Primary signal: the provider's own condition text
 * ("Dust"/"Haze"/"Smoke"). Fallback (condition text absent/unhelpful): low
 * humidity during the Nov-Feb Harmattan season is a reasonable proxy.
 */
function classifyHarmattan(conditionMain, humidityPct, month) {
  const condition = (conditionMain || '').toLowerCase();
  if (HARMATTAN_CONDITIONS.has(condition)) return 'HIGH';
  if (month != null && HARMATTAN_MONTHS.has(month) && humidityPct != null) {
    if (humidityPct < 30) return 'HIGH';
    if (humidityPct < 40) return 'MEDIUM';
  }
  return 'LOW';
}

/**
 * "Cold" here is relative to Nigeria's climate, not an absolute scale —
 * the country rarely sees weather this cool outside Harmattan mornings,
 * so even a moderate dip is a meaningful signal.
 */
function classifyCold(celsius) {
  if (celsius == null) return 'UNKNOWN';
  if (celsius < 18) return 'HIGH';
  if (celsius < 22) return 'MEDIUM';
  return 'LOW';
}

/**
 * classify(normalized) -> { rainfallRisk, humidityRisk, heatwaveRisk,
 *   harmattanRisk, coldRisk, confidence }
 *
 * `confidence` here describes confidence in the weather reading itself
 * (live observed conditions, not a multi-day prediction) — it is separate
 * from, and generally higher than, the confidence attached to any business
 * recommendation built on top of it downstream.
 */
function classify(normalized) {
  if (!normalized) return null;
  const month = normalized.forecastDate ? Number(normalized.forecastDate.slice(5, 7)) : null;
  return {
    rainfallRisk: classifyRainfall(normalized.rainfall_mm),
    humidityRisk: classifyHumidity(normalized.humidity),
    heatwaveRisk: classifyHeatwave(normalized.temperature),
    harmattanRisk: classifyHarmattan(normalized.conditionMain, normalized.humidity, month),
    coldRisk: classifyCold(normalized.temperature),
    confidence: 90,
  };
}

module.exports = {
  classify, classifyRainfall, classifyHumidity, classifyHeatwave, classifyHarmattan, classifyCold,
};
