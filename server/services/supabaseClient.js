/**
 * Supabase Auth client — server-side only, keyed with the service_role secret.
 *
 * Two things this is used for, and both are Auth calls:
 *   1. `auth.getUser(token)` — verifies a caller-supplied access token against
 *      Supabase's Auth server. This checks the TOKEN, not the key the client
 *      was built with.
 *   2. `auth.admin.createUser(...)` — WhatsApp onboarding provisions accounts.
 *
 * All application data goes through server/services/db.js on direct Postgres,
 * never PostgREST, so nothing here touches tables.
 *
 * WHY AuthClient AND NOT createClient. The full supabase-js client builds a
 * RealtimeClient in its constructor, and as of v2.110 that needs a global
 * WebSocket — which Node 22 has and Node 20 does not. On a Node 20 host every
 * authenticated request therefore died inside createClient(), before any token
 * was examined, complaining about WebSockets: a frightening message about a
 * feature this server has never used. We subscribe to nothing.
 *
 * @supabase/auth-js is the same Auth implementation supabase-js wraps, with
 * tslib as its only dependency, so it cannot pull realtime in. getUser and
 * admin.createUser keep identical signatures and return shapes, which is why
 * the call sites are unchanged.
 *
 * Returned wrapped in { auth } so callers keep reading `supabase.auth.getUser`
 * — the shape supabase-js presents.
 *
 * Never import this on the client: the service_role key bypasses Row-Level
 * Security entirely and must never reach a browser.
 */

const { AuthClient } = require('@supabase/auth-js');

let client = null;

function getSupabaseClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  const auth = new AuthClient({
    // supabase-js appends this path itself; building AuthClient directly means
    // naming the Auth endpoint in full.
    url: `${url.replace(/\/+$/, '')}/auth/v1`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    autoRefreshToken: false,
    persistSession: false,
  });

  client = { auth };
  return client;
}

module.exports = { getSupabaseClient };
