/**
 * Weather Cache — never call the weather API more than once per state per
 * day, per organization. Owns its own self-contained table
 * (weather_intelligence, see supabase/migrations/0002_weather_cache.sql) —
 * no foreign keys into the star schema.
 *
 *   Weather API -> normalize -> classify -> save to weather_intelligence
 *   Every subsequent lookup for that org/state/day reads the table instead.
 */

const { getRawWeather } = require('./weatherService');
const { normalize } = require('./weatherNormalizer');
const { classify } = require('./weatherTypes');
const { getSql, assertOrgId } = require('../db');

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

function rowToSignal(row) {
  if (!row) return null;
  return {
    state: row.state,
    forecastDate: row.forecast_date,
    rainfall_mm: row.rainfall_mm != null ? Number(row.rainfall_mm) : null,
    humidity: row.humidity != null ? Number(row.humidity) : null,
    temperature: row.temperature != null ? Number(row.temperature) : null,
    rainfallRisk: row.rainfall_risk,
    humidityRisk: row.humidity_risk,
    heatwaveRisk: row.heatwave_risk,
    harmattanRisk: row.harmattan_risk,
    coldRisk: row.cold_risk,
    conditionMain: row.condition_main,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    fromCache: true,
  };
}

/**
 * Return today's weather signal for a state — cached if already fetched
 * today for this organization, otherwise fetches, classifies, caches, and
 * returns it. Returns null (never throws) if the state is unset or the
 * provider is unavailable/unconfigured — callers treat null as "no
 * weather signal".
 */
async function getOrFetch(organizationId, state) {
  if (!state) return null;
  assertOrgId(organizationId);
  const db = getSql();

  const today = todayStr();
  const [cached] = await db`
    select * from weather_intelligence
    where organization_id = ${organizationId} and state = ${state} and forecast_date = ${today}
  `;
  if (cached) return rowToSignal(cached);

  const raw = await getRawWeather(state);
  const normalized = normalize(raw, state);
  if (!normalized) return null;

  const risk = classify(normalized);
  if (!risk) return null;

  await db`
    insert into weather_intelligence
      (organization_id, state, forecast_date, rainfall_mm, humidity, temperature,
       rainfall_risk, humidity_risk, heatwave_risk, harmattan_risk, cold_risk, condition_main, confidence)
    values (
      ${organizationId}, ${state}, ${today}, ${normalized.rainfall_mm ?? null}, ${normalized.humidity ?? null}, ${normalized.temperature ?? null},
      ${risk.rainfallRisk ?? null}, ${risk.humidityRisk ?? null}, ${risk.heatwaveRisk ?? null},
      ${risk.harmattanRisk ?? null}, ${risk.coldRisk ?? null}, ${normalized.conditionMain ?? null}, ${risk.confidence ?? null}
    )
    on conflict (organization_id, state, forecast_date) do update set
      rainfall_mm = excluded.rainfall_mm,
      humidity = excluded.humidity,
      temperature = excluded.temperature,
      rainfall_risk = excluded.rainfall_risk,
      humidity_risk = excluded.humidity_risk,
      heatwave_risk = excluded.heatwave_risk,
      harmattan_risk = excluded.harmattan_risk,
      cold_risk = excluded.cold_risk,
      condition_main = excluded.condition_main,
      confidence = excluded.confidence
  `;

  return { state, forecastDate: today, ...normalized, ...risk, fromCache: false };
}

module.exports = { getOrFetch };
