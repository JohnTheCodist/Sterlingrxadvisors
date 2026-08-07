import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { apiFetch } from '../lib/apiClient.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [organization, setOrganization] = useState(null); // { organizationId, name, role } | null
  const [loading, setLoading] = useState(true); // true until the initial session + org check finishes
  // 'unknown' until a request definitively answers. `organization === null`
  // alone can't distinguish "confirmed: no pharmacy yet" from "we failed to
  // find out" — and treating the second as the first is what sent users
  // who already had a pharmacy back to /onboarding to create a duplicate.
  const [orgStatus, setOrgStatus] = useState('unknown'); // 'unknown' | 'resolved' | 'error'

  // Takes hasSession (not the token itself) — apiFetch re-checks
  // supabase.auth.getSession() fresh right before the request, which lets
  // supabase-js auto-refresh an expired access token. Passing a token
  // captured earlier in React state skips that refresh entirely, so a
  // long-lived tab (session open for hours) would keep sending an expired
  // token and 401 forever instead of self-healing.
  //
  // Only a 403 means "this user genuinely has no organization yet." Every
  // other failure (network drop, 500, timeout) says nothing about whether
  // one exists, so it resolves to 'error' — never to "no organization."
  const fetchOrganization = useCallback(async (hasSession) => {
    if (!hasSession) {
      setOrganization(null);
      setOrgStatus('resolved'); // signed out: definitively no organization
      return;
    }

    // Back to 'unknown' for the duration of the lookup, because the state we
    // are leaving is a real answer to a different question.
    //
    // Signed out, the branch above sets organization null and orgStatus
    // 'resolved' -- correct then, and poison the instant a session appears.
    // SignIn navigates to /dashboard as soon as signInWithPassword resolves,
    // which is before this request finishes, so RequireAuth read that leftover
    // pair as "confirmed: this user has no pharmacy" and redirected an existing
    // customer to /onboarding to create one they already had. Whether it
    // happened came down to whether the network beat React's next render.
    setOrgStatus('unknown');

    try {
      const res = await apiFetch('/api/organizations/me');
      if (res.status === 403) {
        setOrganization(null);
        setOrgStatus('resolved');
        return;
      }
      if (!res.ok) {
        setOrgStatus('error');
        return;
      }
      const data = await res.json();
      setOrganization(data);
      setOrgStatus('resolved');
    } catch (_) {
      setOrgStatus('error');
    }
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await fetchOrganization(!!data.session);
      if (active) setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      await fetchOrganization(!!newSession);
    });

    return () => {
      active = false;
      listener?.subscription?.unsubscribe();
    };
  }, [fetchOrganization]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setOrganization(null);
    // Left at whatever the previous session produced, this could be 'error',
    // and the next sign-in would render the "can't reach the server" retry
    // screen using a failure that belonged to someone else's session.
    setOrgStatus('resolved');
  }, []);

  const refreshOrganization = useCallback(async () => {
    await fetchOrganization(!!session);
  }, [session, fetchOrganization]);

  const value = {
    session,
    user: session?.user || null,
    organization,
    orgStatus,
    loading,
    signOut,
    refreshOrganization,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
