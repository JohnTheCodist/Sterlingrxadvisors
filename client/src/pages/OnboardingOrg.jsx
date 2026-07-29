import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/apiClient.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function OnboardingOrg() {
  const navigate = useNavigate();
  const { refreshOrganization } = useAuth();
  const [name, setName] = useState('');
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setStatus(null);

    try {
      const res = await apiFetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ type: 'error', message: data.error || 'Could not create your pharmacy account.' });
        setSubmitting(false);
        return;
      }
      await refreshOrganization();
      navigate('/dashboard');
    } catch (err) {
      setStatus({ type: 'error', message: 'Could not reach the server. Please try again.' });
      setSubmitting(false);
    }
  }

  return (
    <section className="page-header">
      <div className="shell" style={{ maxWidth: 420 }}>
        <div className="section-head center">
          <span className="eyebrow">One last step</span>
          <h1>Name your pharmacy</h1>
          <p className="lead">This is what you'll see across your dashboard — you can't lose access, so pick anything you'll recognize.</p>
        </div>

        <form className="contact-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="orgName">Pharmacy name</label>
            <input id="orgName" name="orgName" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Okafor Community Pharmacy" />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? 'Setting up…' : 'Continue to dashboard'}
          </button>

          {status && <div className={`form-status ${status.type}`}>{status.message}</div>}
        </form>
      </div>
    </section>
  );
}
