import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import { apiFetch } from '../lib/apiClient.js';
import { useAuth } from '../context/AuthContext.jsx';
import { NIGERIAN_STATES } from '../lib/nigerianStates.js';
import GoogleSignInButton from '../components/GoogleSignInButton.jsx';

/**
 * Sign up — two steps: the account, then the pharmacy.
 *
 * Split rather than one long form because the halves fail for different
 * reasons at different times. Supabase owns step 1 and can reject an email
 * that is already registered; only once a session exists can step 2 create
 * the organization. Asking for a pharmacy name before knowing the account is
 * even possible would mean discarding it on a duplicate-email error.
 *
 * The state picked in step 2 is written straight into organization_profile —
 * the same row the dashboard's Settings panel edits and the weather signal
 * reads — so it never has to be asked for twice.
 */

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

export default function SignUp() {
  const navigate = useNavigate();
  const { refreshOrganization } = useAuth();

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ email: '', password: '', pharmacy: '', state: '' });
  const [touched, setTouched] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState(null);
  const [notice, setNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const errors = {
    email: !form.email.trim()
      ? 'Enter your email address.'
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
        ? 'That address is missing an @ or a domain.'
        : null,
    // Supabase rejects anything shorter, so saying it up front beats a round
    // trip that comes back with the same rule.
    password: !form.password
      ? 'Choose a password.'
      : form.password.length < 8
        ? 'Use at least 8 characters.'
        : null,
    pharmacy: !form.pharmacy.trim() ? 'Enter your pharmacy’s name.' : null,
    state: !form.state ? 'Pick the state you operate in.' : null,
  };
  const showError = (f) => touched[f] && errors[f];

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (status) setStatus(null);
  }
  const handleBlur = (e) => setTouched((t) => ({ ...t, [e.target.name]: true }));

  async function submitAccount(e) {
    e.preventDefault();
    setTouched((t) => ({ ...t, email: true, password: true }));
    if (errors.email || errors.password) return;

    setSubmitting(true);
    setStatus(null);

    const { data, error } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
    });

    if (error) {
      setStatus(error.message);
      setSubmitting(false);
      return;
    }

    if (!data.session) {
      // The project requires email confirmation, so there is no session to
      // create an organization with yet. Say so plainly rather than advancing
      // to a step that would fail on every submit.
      setNotice(
        'Check your email to confirm your account, then sign in — we’ll ask for your pharmacy details straight after.',
      );
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    setStep(2);
  }

  async function submitPharmacy(e) {
    e.preventDefault();
    setTouched((t) => ({ ...t, pharmacy: true, state: true }));
    if (errors.pharmacy || errors.state) return;

    setSubmitting(true);
    setStatus(null);

    try {
      const res = await apiFetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.pharmacy, state: form.state }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error || 'Could not set up your pharmacy.');
        setSubmitting(false);
        return;
      }
      await refreshOrganization();
      navigate('/dashboard', { replace: true });
    } catch {
      setStatus('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="auth">

      <div className="auth__form-col">
        <div className="auth__inner">
          <Link to="/" className="auth__wordmark">RxNaija <span>Analytics</span></Link>

          <ol className="auth__steps">
            <li aria-current={step === 1 ? 'step' : undefined} data-done={step > 1 ? 'true' : undefined}>
              Your account
            </li>
            <li aria-current={step === 2 ? 'step' : undefined}>Your pharmacy</li>
          </ol>

          {step === 1 ? (
            <>
              <h1 className="auth__title">Create your account</h1>

              <form onSubmit={submitAccount} noValidate>
                <div className="auth__fields">
                  <div className="auth__field">
                    <label className="auth__label" htmlFor="email">Email</label>
                    <div className="auth__input-wrap">
                      <input
                        id="email" name="email" type="email" className="auth__input"
                        autoComplete="email" placeholder="you@pharmacy.com"
                        value={form.email} onChange={handleChange} onBlur={handleBlur}
                        disabled={submitting}
                        aria-invalid={showError('email') ? 'true' : undefined}
                        aria-describedby="email-helper"
                      />
                    </div>
                    <p id="email-helper" className="auth__helper" data-tone={showError('email') ? 'error' : undefined}>
                      {showError('email') ? errors.email : ''}
                    </p>
                  </div>

                  <div className="auth__field">
                    <label className="auth__label" htmlFor="password">Password</label>
                    <div className="auth__input-wrap">
                      <input
                        id="password" name="password" className="auth__input"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password" placeholder="At least 8 characters"
                        value={form.password} onChange={handleChange} onBlur={handleBlur}
                        disabled={submitting}
                        aria-invalid={showError('password') ? 'true' : undefined}
                        aria-describedby="password-helper"
                      />
                      <button
                        type="button" className="auth__reveal"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-pressed={showPassword}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        <EyeIcon off={showPassword} />
                      </button>
                    </div>
                    <p id="password-helper" className="auth__helper" data-tone={showError('password') ? 'error' : undefined}>
                      {showError('password') ? errors.password : ''}
                    </p>
                  </div>
                </div>

                <button type="submit" className="btn btn-primary auth__submit" disabled={submitting}>
                  {submitting ? 'Creating account…' : 'Continue'}
                </button>

                <div role="alert" aria-live="polite">
                  {status && <div className="auth__alert">{status}</div>}
                  {notice && <div className="auth__notice">{notice}</div>}
                </div>
              </form>

              <div className="auth__divider">or</div>
              <GoogleSignInButton label="Continue with Google" />

              <p className="auth__foot">
                Already have an account? <Link to="/signin">Sign in</Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="auth__title">Tell us about your pharmacy</h1>
              <p className="auth__panel-sub">
                Your state drives the weather and disease signals on your dashboard.
                You can change it later in Settings.
              </p>

              <form onSubmit={submitPharmacy} noValidate>
                <div className="auth__fields">
                  <div className="auth__field">
                    <label className="auth__label" htmlFor="pharmacy">Pharmacy name</label>
                    <div className="auth__input-wrap">
                      <input
                        id="pharmacy" name="pharmacy" className="auth__input"
                        autoComplete="organization" placeholder="Okafor Community Pharmacy"
                        value={form.pharmacy} onChange={handleChange} onBlur={handleBlur}
                        disabled={submitting}
                        aria-invalid={showError('pharmacy') ? 'true' : undefined}
                        aria-describedby="pharmacy-helper"
                      />
                    </div>
                    <p id="pharmacy-helper" className="auth__helper" data-tone={showError('pharmacy') ? 'error' : undefined}>
                      {showError('pharmacy') ? errors.pharmacy : ''}
                    </p>
                  </div>

                  <div className="auth__field">
                    <label className="auth__label" htmlFor="state">State</label>
                    <div className="auth__input-wrap">
                      <select
                        id="state" name="state" className="auth__input auth__select"
                        value={form.state} onChange={handleChange} onBlur={handleBlur}
                        disabled={submitting}
                        aria-invalid={showError('state') ? 'true' : undefined}
                        aria-describedby="state-helper"
                      >
                        <option value="">Select a state</option>
                        {NIGERIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <p id="state-helper" className="auth__helper" data-tone={showError('state') ? 'error' : undefined}>
                      {showError('state') ? errors.state : ''}
                    </p>
                  </div>
                </div>

                <button type="submit" className="btn btn-primary auth__submit" disabled={submitting}>
                  {submitting ? 'Setting up…' : 'Finish setup'}
                </button>

                <div role="alert" aria-live="polite">
                  {status && <div className="auth__alert">{status}</div>}
                </div>
              </form>
            </>
          )}
        </div>
      </div>

      <aside className="auth__promo">
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
