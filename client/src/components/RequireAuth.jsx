import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

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

  if (loading) {
    return (
      <section className="page-header">
        <div className="shell">
          <p className="lead">Loading…</p>
        </div>
      </section>
    );
  }

  if (!session) {
    return <Navigate to="/signin" state={{ from: location }} replace />;
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
