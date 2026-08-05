/**
 * Environment validation, run once at startup.
 *
 * The failure this exists to prevent: a variable is missing on the host, the
 * app boots anyway, and the first person to click something gets a 500 whose
 * message is about a null URL. On shared hosting that is close to
 * undiagnosable -- there is no console to read, and Passenger will restart the
 * worker and hide it.
 *
 * So: check everything up front, report ALL of it at once, and distinguish two
 * different kinds of missing.
 *
 *   REQUIRED  the app cannot serve a single authenticated request without it.
 *             Refuse to start, and say exactly which ones and where they go.
 *
 *   OPTIONAL  one feature stops working and the rest of the app is fine.
 *             Log a warning naming the feature that is now off, and continue.
 *             A pharmacy with no Twilio account should still get a dashboard.
 *
 * Reporting all of them together matters more than it sounds. Failing on the
 * first missing variable turns configuring a host into a guessing game: fix
 * one, redeploy, discover the next. This prints the whole list once.
 */

/** Cannot serve authenticated traffic without these. */
const REQUIRED = [
  {
    key: 'DATABASE_URL',
    why: 'Postgres connection string. Supabase > Project Settings > Database > Connection string (session pooler).',
  },
  {
    key: 'SUPABASE_URL',
    why: 'Supabase project URL, e.g. https://xxxx.supabase.co',
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    why: 'Supabase service role key. Server-side only -- never expose it to the browser.',
  },
];

/** Each of these switches off exactly one feature when absent. */
const OPTIONAL = [
  { key: 'LLM_API_KEY', feature: 'AI column mapping and the Lume advisor' },
  { key: 'TWILIO_ACCOUNT_SID', feature: 'WhatsApp channel' },
  { key: 'TWILIO_AUTH_TOKEN', feature: 'WhatsApp channel' },
  { key: 'TWILIO_WHATSAPP_NUMBER', feature: 'WhatsApp channel' },
  { key: 'PUBLIC_BASE_URL', feature: 'WhatsApp PDF download links (they need an absolute, publicly reachable URL)' },
  { key: 'OPENWEATHER_API_KEY', feature: 'weather-driven demand signals' },
  { key: 'RELEASES_DIR', feature: 'desktop installer download (falls back to <repo>/releases)' },
];

function missing(key) {
  const v = process.env[key];
  return v == null || String(v).trim() === '';
}

/**
 * @param {{ exitOnFailure?: boolean, logger?: Console }} [opts]
 * @returns {{ ok: boolean, missingRequired: string[], missingOptional: string[] }}
 */
function validateEnv(opts = {}) {
  const { exitOnFailure = true, logger = console } = opts;

  const missingRequired = REQUIRED.filter((r) => missing(r.key));
  const missingOptional = OPTIONAL.filter((o) => missing(o.key));

  if (missingOptional.length > 0) {
    // Grouped by feature so three missing Twilio keys read as one disabled
    // channel rather than three unrelated problems.
    const byFeature = new Map();
    for (const o of missingOptional) {
      if (!byFeature.has(o.feature)) byFeature.set(o.feature, []);
      byFeature.get(o.feature).push(o.key);
    }
    for (const [feature, keys] of byFeature) {
      logger.warn(`[config] ${feature} is disabled -- not set: ${keys.join(', ')}`);
    }
  }

  if (missingRequired.length > 0) {
    const lines = [
      '',
      '  Cannot start: required environment variables are missing.',
      '',
      ...missingRequired.flatMap((r) => [`    ${r.key}`, `      ${r.why}`, '']),
      '  Set these in cPanel under Setup Node.js App > Environment variables,',
      '  or in server/.env for local development. See .env.example.',
      '',
    ];
    logger.error(lines.join('\n'));
    if (exitOnFailure) process.exit(1);
    return { ok: false, missingRequired: missingRequired.map((r) => r.key), missingOptional: missingOptional.map((o) => o.key) };
  }

  return { ok: true, missingRequired: [], missingOptional: missingOptional.map((o) => o.key) };
}

module.exports = { validateEnv, REQUIRED, OPTIONAL };
