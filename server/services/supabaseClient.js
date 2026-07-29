/**
 * Supabase client — server-side only, keyed with the service_role secret.
 *
 * Two things this one client is used for:
 *   1. `auth.getUser(token)` — verifies a caller-supplied access token
 *      against Supabase's Auth server. This checks the TOKEN, not the
 *      key the client was built with, so one client covers both auth
 *      verification and (if ever needed) admin auth operations.
 *   2. Anything reaching for Supabase Auth admin APIs (e.g. user lookup).
 *      All actual application data access goes through server/services/db.js
 *      (direct Postgres, not PostgREST) — this client is not used for
 *      table queries in the app's data layer.
 *
 * Never import this on the client — the service_role key bypasses Row-Level
 * Security entirely and must never reach the browser.
 */

const { createClient } = require('@supabase/supabase-js');

let client = null;

function getSupabaseClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

module.exports = { getSupabaseClient };
