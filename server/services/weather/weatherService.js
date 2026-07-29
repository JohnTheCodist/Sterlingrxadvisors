/**
 * Weather Service — talks to OpenWeather. Nothing else.
 *
 * Input:  a Nigerian state name, e.g. "Lagos"
 * Output: the raw OpenWeather API response, untouched.
 *
 * No calculations, no risk classification, no caching, no business logic —
 * that's weatherNormalizer.js / weatherTypes.js / weatherCache.js. This file
 * is only a translator between "give me weather for this state" and an HTTP
 * call to whichever provider is configured.
 */

const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
const OPENWEATHER_API_URL = process.env.OPENWEATHER_API_URL || 'https://api.openweathermap.org/data/2.5/weather';
const OPENWEATHER_TIMEOUT_MS = parseInt(process.env.OPENWEATHER_TIMEOUT_MS || '10000', 10);

// Full state -> capital-city map. Most Nigerian state names do NOT match
// a geocodable city (e.g. "Ekiti" 404s — the real city is "Ado Ekiti"), so
// this is deliberately complete rather than relying on a few exceptions —
// every option in the Settings state picker must actually resolve.
const STATE_CITY_OVERRIDES = {
  Abia: 'Umuahia',
  Adamawa: 'Yola',
  'Akwa Ibom': 'Uyo',
  Anambra: 'Awka',
  Bauchi: 'Bauchi',
  Bayelsa: 'Yenagoa',
  Benue: 'Makurdi',
  Borno: 'Maiduguri',
  'Cross River': 'Calabar',
  Delta: 'Asaba',
  Ebonyi: 'Abakaliki',
  Edo: 'Benin City',
  Ekiti: 'Ado Ekiti',
  Enugu: 'Enugu',
  'Federal Capital Territory': 'Abuja',
  FCT: 'Abuja',
  Gombe: 'Gombe',
  Imo: 'Owerri',
  Jigawa: 'Dutse',
  Kaduna: 'Kaduna',
  Kano: 'Kano',
  Katsina: 'Katsina',
  Kebbi: 'Birnin Kebbi',
  Kogi: 'Lokoja',
  Kwara: 'Ilorin',
  Lagos: 'Lagos',
  Nasarawa: 'Lafia',
  Niger: 'Minna',
  Ogun: 'Abeokuta',
  Ondo: 'Akure',
  Osun: 'Osogbo',
  Oyo: 'Ibadan',
  Plateau: 'Jos',
  Rivers: 'Port Harcourt',
  Sokoto: 'Sokoto',
  Taraba: 'Jalingo',
  Yobe: 'Damaturu',
  Zamfara: 'Gusau',
};

function isConfigured() {
  return !!OPENWEATHER_API_KEY;
}

/**
 * Fetch the raw current-weather payload for a Nigerian state.
 * Returns null (never throws) if unconfigured, unreachable, or the
 * provider errors — callers decide what "no weather data" means.
 */
async function getRawWeather(state) {
  if (!OPENWEATHER_API_KEY || !state) return null;

  const city = STATE_CITY_OVERRIDES[state] || state;
  const url = `${OPENWEATHER_API_URL}?q=${encodeURIComponent(city)},NG&appid=${OPENWEATHER_API_KEY}&units=metric`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENWEATHER_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[weatherService] OpenWeather returned ${response.status} for state "${state}"`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(`[weatherService] fetch failed for state "${state}": ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { getRawWeather, isConfigured };
