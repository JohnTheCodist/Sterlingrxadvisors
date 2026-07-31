import { supabase } from './supabaseClient.js';

/**
 * Thin fetch wrapper that attaches the current Supabase session's access
 * token to every request. Replaces the scattered raw fetch('/api/...')
 * calls across Dashboard.jsx/Upload.jsx — those never sent an auth header
 * at all before multi-tenancy existed.
 *
 * Usage matches native fetch: apiFetch('/api/analytics') or
 * apiFetch('/api/confirm-mapping', { method: 'POST', body: formData }).
 */
export async function apiFetch(path, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  // getSession() refreshes an expired access token on its own, so reaching
  // here without one means the refresh token is gone too — the session is
  // genuinely over, usually after a tab sat idle long enough (or a laptop
  // slept) for the refresh to lapse. Every route this wrapper talks to
  // requires auth, so sending the request anyway just spends a round-trip to
  // be told the same thing, and answers with "Missing Authorization header"
  // — true, but meaningless to a pharmacist who only knows they pressed a
  // button. Answer locally, in words that name the actual problem.
  //
  // Returned as a Response rather than thrown so existing `!res.ok` handling
  // at all call sites keeps working unchanged.
  if (!token) {
    return new Response(
      JSON.stringify({ error: 'Your session has expired. Please sign in again, then retry.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  return fetch(path, { ...options, headers });
}
