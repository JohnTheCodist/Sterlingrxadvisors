import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/apiClient.js';
import { useAuth } from '../context/AuthContext.jsx';
import { NIGERIAN_STATES } from '../lib/nigerianStates.js';

/**
 * Onboarding — the pharmacy half of signup, for people who never saw it.
 *
 * A Google signup goes straight from the provider to /dashboard, where
 * RequireAuth finds no organization and redirects here. That path skips
 * SignUp's step 2 entirely, so this page asks the same two questions and
 * writes to the same place. Leaving state out here is how a Google user ends
 * up with no weather signal and nothing on screen explaining why.
 */

const ASKS = [
  { tag: 'Expiry', q: 'What expires in the next 90 days?' },
  { tag: 'Margin', q: 'Which products earn me the least?' },
  { tag: 'Supply', q: 'Which supplier am I most exposed to?' },
  { tag: 'Reorder', q: 'What should I reorder this week?' },
  { tag: 'Cash', q: 'Where is cash trapped in overstock?' },
  { tag: 'Planning', q: 'How do I reach ₦2M next month?' },
];

export default function OnboardingOrg() {
  const navigate = useNavigate();
  const { refreshOrganization } = useAuth();

  const [form, setForm] = useState({ pharmacy: '', state: '' });
  const [touched, setTouched] = useState({});
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const errors = {
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

  async function handleSubmit(e) {
    e.preventDefault();
    setTouched({ pharmacy: true, state: true });
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
        setStatus(data.error || 'Could not create your pharmacy account.');
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

          <h1 className="auth__title">Tell us about your pharmacy</h1>
          <p className="auth__panel-sub">
            One step left. Your state drives the weather and disease signals on your
            dashboard — you can change it later in Settings.
          </p>

          <form onSubmit={handleSubmit} noValidate>
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
              {submitting ? 'Setting up…' : 'Continue to dashboard'}
            </button>

            <div role="alert" aria-live="polite">
              {status && <div className="auth__alert">{status}</div>}
            </div>
          </form>
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
