import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import LoadingState from './LoadingState.jsx';
import SignIn from '../pages/SignIn.jsx';

/**
 * What the desktop app opens on.
 *
 * The window's root route used to render the sign-in form unconditionally,
 * which asked for a password every single launch. The session was never the
 * problem — Supabase persists it to localStorage, and localStorage on a
 * file:// origin survives an Electron restart (verified by writing a key,
 * quitting, and reading it back). The form simply never looked. Someone who
 * signed in yesterday was still shown a login screen today, typed their
 * password, and was handed back the session they already had.
 *
 * So: ask first, and only show the form to someone who genuinely has no
 * session. Signing out clears it and lands them back here, which is the one
 * time an installed app should be asking.
 *
 * The wait matters as much as the answer. `loading` is true while the initial
 * session check runs, and rendering the form during it would flash a login
 * screen at an already-authenticated owner before replacing it — the exact
 * thing this component exists to stop.
 */
export default function DesktopRoot() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-7 py-24">
        <LoadingState sub="Opening your pharmacy." />
      </div>
    );
  }

  // RequireAuth takes it from here — it resolves the organization and sends
  // anyone without one to onboarding, so this never has to know about that.
  if (session) return <Navigate to="/dashboard" replace />;

  return <SignIn />;
}
