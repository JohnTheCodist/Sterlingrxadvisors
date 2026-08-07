import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import LoadingState from './LoadingState.jsx';

/**
 * Guards /upload and /dashboard only — marketing pages stay public.
 *   no session                     -> /signin
 *   confirmed no organization      -> /onboarding
 *   organization lookup FAILED     -> retry screen (never /onboarding — see below)
 *   session + organization         -> render the protected page
 */
export default function RequireAuth({ children }) {
  const { session, organization, orgStatus, loading, refreshOrganization } = useAuth();
  const location = useLocation();

  // Was a bare "Loading…" line. Signing in therefore crossed two unrelated
  // loading screens back to back — this one, then the dashboard's own — and
  // the reader registered the change rather than the progress. Same treatment
  // as the dashboard now, so the wait is one continuous thing.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-7 py-24">
        <LoadingState sub="Signing you in." />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  // Signed in, but we do not yet know whether this user has a pharmacy. Every
  // branch below answers that question, so deciding now means guessing, and the
  // guess lands on /onboarding -- inviting an existing customer to create a
  // second pharmacy. Wait instead. It is the same loading treatment as above,
  // so the sign-in wait stays one continuous screen rather than two.
  if (orgStatus === 'unknown') {
    return (
      <div className="flex min-h-screen items-center justify-center px-7 py-24">
        <LoadingState sub="Loading your pharmacy." />
      </div>
    );
  }

  // Couldn't determine whether this user has a pharmacy. Say so and offer a
  // retry — never fall through to /onboarding, which would invite them to
  // "create" a pharmacy they may already have.
  if (!organization && orgStatus === 'error') {
    return (
      <section className="page-header">
        <div className="shell">
          <h1>Can&apos;t reach the server</h1>
          <p className="lead">
            We couldn&apos;t load your pharmacy account just now. Check your connection and try again —
            your data is safe.
          </p>
          <button type="button" className="btn btn-primary" onClick={refreshOrganization}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (!organization && orgStatus === 'resolved' && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return children;
}
