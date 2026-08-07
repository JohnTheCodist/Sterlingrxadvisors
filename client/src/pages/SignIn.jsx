import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from '../context/AuthContext.jsx';
import GoogleSignInButton from '../components/GoogleSignInButton.jsx';

/**
 * Sign in — Split Studio, chromeless (App.jsx suppresses Navbar/Footer here).
 *
 * The form comes FIRST in the DOM and is re-ordered to the right visually, so
 * keyboard and screen-reader users reach the thing they came for before the
 * marketing panel. Validation runs on blur rather than per-keystroke, so the
 * page never calls an email invalid while someone is still typing it.
 */

/* Real questions the advisor answers — each maps to a tool that exists
   (expiry risk, margin, supplier concentration, reorder, overstock, goal
   modelling). Product screenshots would have meant inventing numbers. */
const ASKS = [
  { tag: 'Expiry', q: 'What expires in the next 90 days?' },
  { tag: 'Margin', q: 'Which products earn me the least?' },
  { tag: 'Supply', q: 'Which supplier am I most exposed to?' },
  { tag: 'Reorder', q: 'What should I reorder this week?' },
  { tag: 'Cash', q: 'Where is cash trapped in overstock?' },
  { tag: 'Planning', q: 'How do I reach ₦2M next month?' },
];

function EyeIcon({ off }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M6.61 6.61A18.4 18.4 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 5.39-1.61" />
          <path d="m2 2 20 20" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
        </>
      ) : (
        <>
          <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export default function SignIn() {
  const location = useLocation();
  const { session } = useAuth();
  // RequireAuth sends the page the user was trying to reach as state.from —
  // e.g. a session that expired mid-upload. Honour it so they land back where
  // they were instead of always the dashboard.
  const redirectTo = location.state?.from?.pathname || '/dashboard';

  const [form, setForm] = useState({ email: '', password: '' });
  const [touched, setTouched] = useState({ email: false, password: false });
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const errors = {
    email: !form.email.trim()
      ? 'Enter the email you signed up with.'
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
        ? 'That address is missing an @ or a domain.'
        : null,
    password: !form.password ? 'Enter your password.' : null,
  };
  const showError = (field) => touched[field] && errors[field];

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (status) setStatus(null);
  }

  function handleBlur(e) {
    setTouched((t) => ({ ...t, [e.target.name]: true }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (errors.email || errors.password) return;

    setSubmitting(true);
    setStatus(null);

    const { error } = await supabase.auth.signInWithPassword({
      email: form.email,
      password: form.password,
    });

    if (error) {
      setStatus(error.message);
      setSubmitting(false);
      return;
    }

    // Deliberately no navigate() here. This used to call it the moment
    // signInWithPassword resolved, which is before onAuthStateChange has put
    // the session into React state -- so RequireAuth rendered /dashboard
    // against a still-null session and bounced straight back to /signin. The
    // form reappeared as though nothing had happened, and the obvious next
    // click was the wordmark, which is the homepage.
    //
    // Leaving `submitting` true keeps the button disabled meanwhile; the
    // redirect below fires on the session the guard itself will read.
  }

  // The one place the redirect happens, for both email and Google, and for
  // someone who simply revisits /signin while already signed in.
  if (session) return <Navigate to={redirectTo} replace />;

  return (
    <div className="auth">

      <div className="auth__form-col">
        <div className="auth__inner">
          <Link to="/" className="auth__wordmark">SterlingRx Advisors <span>Analytics</span></Link>

          <h1 className="auth__title">Sign in to SterlingRx Advisors</h1>

          <form onSubmit={handleSubmit} noValidate>
            <div className="auth__fields">

              <div className="auth__field">
                <label className="auth__label" htmlFor="email">Email</label>
                <div className="auth__input-wrap">
                  <input
                    id="email"
                    name="email"
                    type="email"
                    className="auth__input"
                    autoComplete="email"
                    placeholder="you@pharmacy.com"
                    value={form.email}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    disabled={submitting}
                    aria-invalid={showError('email') ? 'true' : undefined}
                    aria-describedby="email-helper"
                  />
                </div>
                <p
                  id="email-helper"
                  className="auth__helper"
                  data-tone={showError('email') ? 'error' : undefined}
                >
                  {showError('email') ? errors.email : ''}
                </p>
              </div>

              <div className="auth__field">
                <label className="auth__label" htmlFor="password">Password</label>
                <div className="auth__input-wrap">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    className="auth__input"
                    autoComplete="current-password"
                    placeholder="Your password"
                    value={form.password}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    disabled={submitting}
                    aria-invalid={showError('password') ? 'true' : undefined}
                    aria-describedby="password-helper"
                  />
                  <button
                    type="button"
                    className="auth__reveal"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-pressed={showPassword}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <EyeIcon off={showPassword} />
                  </button>
                </div>
                <p
                  id="password-helper"
                  className="auth__helper"
                  data-tone={showError('password') ? 'error' : undefined}
                >
                  {showError('password') ? errors.password : ''}
                </p>
              </div>

            </div>

            <button type="submit" className="btn btn-primary auth__submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Continue'}
            </button>

            {/* Announced, not merely shown: a sign-in failure is the one thing
                on this page a screen-reader user must not miss. */}
            <div role="alert" aria-live="polite">
              {status && <div className="auth__alert">{status}</div>}
            </div>
          </form>

          <div className="auth__divider">or</div>

          <GoogleSignInButton label="Continue with Google" />

          <p className="auth__foot">
            New here? <Link to="/signup">Create an account</Link>
          </p>
        </div>
      </div>

      <aside className="auth__promo">
        {/* Decoration only — the grid and its sparks carry no information, so
            they stay out of the accessibility tree entirely. */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span className="auth__spark" key={i} aria-hidden="true" />
        ))}

        <h2 className="auth__promo-title">Meet Lume, your AI analyst for the pharmacy counter.</h2>
        <Link to="/features" className="auth__promo-cta">See what it does</Link>

        <div className="auth__promo-grid">
          {ASKS.map((a) => (
            <div className="auth__ask" key={a.tag}>
              <span>{a.tag}</span>
              {a.q}
            </div>
          ))}
        </div>
      </aside>

    </div>
  );
}
