import { supabase } from './supabaseClient.js';

/**
 * Where the API lives.
 *
 * The web build leaves this empty, so paths stay relative ('/api/analytics')
 * and are served by the same origin — exactly as before. Nothing changes for
 * the deployed site.
 *
 * The desktop build sets VITE_API_BASE_URL at build time. An Electron window
 * loads its UI from a local file, so a relative '/api/...' would resolve
 * against that local origin and find nothing; the desktop bundle needs the
 * absolute address of the hosted backend instead.
 *
 * Trailing slash is stripped so joining never produces '//api'.
 */
const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/+$/, '');

/** Absolute URLs are passed through; only app-relative paths get the base. */
function resolve(path) {
  if (!API_BASE) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return API_BASE + (path.startsWith('/') ? path : `/${path}`);
}

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

  return fetch(resolve(path), { ...options, headers });
}
