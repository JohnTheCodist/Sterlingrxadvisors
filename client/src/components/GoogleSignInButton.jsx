import { useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { isDesktop, webOrigin } from '../lib/platform.js';

/**
 * Shared "Continue with Google" button for SignIn/SignUp — identical
 * behavior on both pages: Supabase redirects to Google, then back to
 * /dashboard, where RequireAuth's existing session-then-org check sends a
 * brand-new user to /onboarding automatically. No separate callback route
 * or new-vs-returning-user branching needed.
 *
 * ...on the web. In the desktop app this flow cannot work, and failed in a
 * way that looked like the app was broken:
 *
 *   1. Supabase navigates the window to Google's sign-in page.
 *   2. Electron sees a navigation to a third-party origin and hands it to the
 *      system browser, as it must — an OAuth page inside an app window is
 *      exactly what phishing looks like, and Google refuses embedded webviews
 *      anyway (disallowed_useragent).
 *   3. Google returns to `redirectTo`. Over file:// window.location.origin is
 *      the string "null", so that target was "null/dashboard" — unreachable.
 *   4. The session lands in the BROWSER. The desktop window still has none,
 *      so signing in again on the website changed nothing it could see.
 *
 * Making this work needs a custom protocol (rxnaija://) registered by the
 * shell and added to Supabase's allowed redirect URLs, so the browser can
 * hand the session back. Until that exists, offering the button would be
 * offering a dead end, so the desktop build says so and points at the method
 * that does work. Email and password sign-in is unaffected: it talks to
 * Supabase directly and never needs a redirect.
 */
export default function GoogleSignInButton({ label = 'Continue with Google' }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const origin = webOrigin();

  async function handleClick() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${origin}/dashboard` },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
    // On success the browser navigates away to Google immediately —
    // nothing else to do here.
  }

  // No usable origin means no usable redirect. Say what to do instead rather
  // than rendering a button that opens a browser and strands the user there.
  if (isDesktop || !origin) {
    return (
      <p className="oauth-unavailable">
        Google sign-in isn’t available in the desktop app yet — please sign in
        with your email and password above.
      </p>
    );
  }

  return (
    <>
      <button type="button" className="btn btn-ghost btn-block" onClick={handleClick} disabled={loading}>
        <svg width="18" height="18" viewBox="0 0 18 18" style={{ marginRight: '0.5rem', verticalAlign: '-3px' }} aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
        </svg>
        {loading ? 'Redirecting…' : label}
      </button>
      {error && <div className="form-status error">{error}</div>}
    </>
  );
}
