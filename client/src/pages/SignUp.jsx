import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import GoogleSignInButton from '../components/GoogleSignInButton.jsx';

export default function SignUp() {
  const navigate = useNavigate();
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

    const { data, error } = await supabase.auth.signUp({ email: form.email, password: form.password });

    if (error) {
      setStatus({ type: 'error', message: error.message });
      setSubmitting(false);
      return;
    }

    if (!data.session) {
      // Email confirmation is required before a session exists.
      setStatus({ type: 'success', message: 'Check your email to confirm your account, then sign in.' });
      setSubmitting(false);
      return;
    }

    navigate('/onboarding');
  }

  return (
    <section className="page-header">
      <div className="shell" style={{ maxWidth: 420 }}>
        <div className="section-head center">
          <span className="eyebrow">Get started</span>
          <h1>Create your account</h1>
          <p className="lead">Set up your pharmacy's account in a minute.</p>
        </div>

        <GoogleSignInButton label="Sign up with Google" />

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
            <input id="password" name="password" type="password" required minLength={8} value={form.password} onChange={handleChange} placeholder="At least 8 characters" />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>

          {status && <div className={`form-status ${status.type}`}>{status.message}</div>}
        </form>

        <p className="lead" style={{ marginTop: '1.5rem', textAlign: 'center' }}>
          Already have an account? <Link to="/signin">Sign in</Link>
        </p>
      </div>
    </section>
  );
}
