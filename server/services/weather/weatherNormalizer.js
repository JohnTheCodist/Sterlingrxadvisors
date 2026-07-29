/**
 * Weather Normalizer — converts a raw provider payload into one fixed shape.
 *
 * Every other module reads THIS shape. If the provider changes (OpenWeather
 * -> NiMet, or a different OpenWeather endpoint), only this file changes.
 *
 * Output: { state, forecastDate, temperature, humidity, rainfall_mm }
 */

function normalize(raw, state) {
  if (!raw) return null;

  const temperature = raw.main?.temp != null ? Math.round(raw.main.temp * 10) / 10 : null;
  const humidity = raw.main?.humidity != null ? Math.round(raw.main.humidity) : null;

  // OpenWeather's current-weather endpoint reports rain as either a 1h or
  // 3h accumulation, only present when it's actually raining. Absent = dry.
  const rainfall_mm = raw.rain?.['1h'] ?? raw.rain?.['3h'] ?? 0;

  const forecastDate = raw.dt
    ? new Date(raw.dt * 1000).toISOString().substring(0, 10)
    : new Date().toISOString().substring(0, 10);

  // Provider's own weather-condition label (e.g. "Rain", "Dust", "Haze",
  // "Clear") — used downstream as the primary Harmattan/dust signal.
  const conditionMain = raw.weather?.[0]?.main || null;

  if (temperature == null || humidity == null) return null;

  return {
    state,
    forecastDate,
    temperature,
    humidity,
    rainfall_mm: Math.round(rainfall_mm * 10) / 10,
    conditionMain,
  };
}

module.exports = { normalize };
