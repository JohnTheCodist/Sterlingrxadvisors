import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import GoogleSignInButton from '../components/GoogleSignInButton.jsx';

export default function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  // RequireAuth sends the page the user was trying to reach as
  // state.from — e.g. a session that expired mid-upload. Honour it so
  // they land back where they were instead of always the dashboard.
  const redirectTo = location.state?.from?.pathname || '/dashboard';
  const [form, setForm] = useState({ email: '', password: '' });
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);

    const { error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });

    if (error) {
      setStatus({ type: 'error', message: error.message });
      setSubmitting(false);
      return;
    }

    navigate(redirectTo, { replace: true });
  }

  return (
    <section className="page-header">
      <div className="shell" style={{ maxWidth: 420 }}>
        <div className="section-head center">
          <span className="eyebrow">Welcome back</span>
          <h1>Sign in</h1>
        </div>

        <GoogleSignInButton label="Sign in with Google" />

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.25rem 0', color: 'var(--color-ink-faint)', fontSize: '0.8rem' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--color-line)' }} />
          or
          <span style={{ flex: 1, height: 1, background: 'var(--color-line)' }} />
        </div>

        <form className="contact-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required value={form.email} onChange={handleChange} placeholder="you@pharmacy.com" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required value={form.password} onChange={handleChange} placeholder="Your password" />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          {status && <div className={`form-status ${status.type}`}>{status.message}</div>}
        </form>

        <p className="lead" style={{ marginTop: '1.5rem', textAlign: 'center' }}>
          Don't have an account? <Link to="/signup">Create one</Link>
        </p>
      </div>
    </section>
  );
}
