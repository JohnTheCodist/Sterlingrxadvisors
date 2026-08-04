/**
 * Which shell is this bundle running in?
 *
 * The same React app serves the website and the desktop window, and almost
 * nothing should care which. The exception is anything that relies on a real
 * web origin — OAuth redirects in particular, because over file:// the origin
 * is the string "null" and a redirect built from it goes nowhere.
 *
 * Two signals, because neither alone is enough:
 *
 *   VITE_DESKTOP   set by desktop/scripts/build-renderer.js. Authoritative for
 *                  a packaged build.
 *   file: protocol catches the case where the flag was not set — a renderer
 *                  loaded from disk is always the desktop app.
 *
 * Deliberately NOT sniffing the user agent for "Electron": that is easy to
 * spoof, changes between versions, and would be a security boundary if
 * anything important depended on it. Nothing here is a security decision — it
 * only picks which sign-in options to show.
 */

const flagged = import.meta.env?.VITE_DESKTOP === 'true';
const fromFile = typeof window !== 'undefined' && window.location?.protocol === 'file:';

export const isDesktop = flagged || fromFile;

/**
 * An origin usable as an OAuth redirect target, or null when there is none.
 *
 * Over file:// `window.location.origin` is "null" — the four-character string,
 * not the value — so building `${origin}/dashboard` yields "null/dashboard",
 * which Supabase accepts and the browser cannot resolve. Callers must treat
 * null as "OAuth is not available here" rather than substituting a guess.
 */
export function webOrigin() {
  if (typeof window === 'undefined') return null;
  const origin = window.location.origin;
  if (!origin || origin === 'null' || window.location.protocol === 'file:') return null;
  return origin;
}
