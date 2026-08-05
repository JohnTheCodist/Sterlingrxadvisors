import { createClient } from '@supabase/supabase-js';
import { isDesktop } from './platform.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — auth will not work.');
}

/**
 * These three are Supabase's defaults, written out on purpose.
 *
 * An installed desktop app that asks for a password every launch feels broken,
 * so "stay signed in until you sign out" is a product requirement here, not a
 * convenience — and it rests entirely on the first two flags. Leaving them
 * implicit means a library default could change under us and the only symptom
 * would be users quietly being logged out.
 *
 *   persistSession     writes the session to localStorage. Survives quitting
 *                      the app: localStorage on a file:// origin persists
 *                      across an Electron restart (verified directly — key
 *                      written, app quit, key read back).
 *   autoRefreshToken   renews the access token in the background, so an app
 *                      reopened weeks later resumes instead of expiring.
 *   detectSessionInUrl reads OAuth tokens back out of the URL hash. The
 *                      desktop build has no OAuth (no web origin to redirect
 *                      to) and routes through HashRouter, whose hash is
 *                      "#/dashboard" — so there is nothing to detect there and
 *                      a parser looking at our routes is only a way to go
 *                      wrong.
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: !isDesktop,
  },
});
