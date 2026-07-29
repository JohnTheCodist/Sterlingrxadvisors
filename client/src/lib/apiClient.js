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

  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(path, { ...options, headers });
}
