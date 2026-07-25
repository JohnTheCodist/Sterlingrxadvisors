import { useState } from 'react';

const initialForm = { name: '', email: '', pharmacyName: '', message: '' };

export default function Contact() {
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState(null); // { type: 'success' | 'error', message }
  const [submitting, setSubmitting] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus({ type: 'error', message: data.error || 'Something went wrong. Please try again.' });
      } else {
        setStatus({ type: 'success', message: data.message });
        setForm(initialForm);
      }
    } catch (err) {
      setStatus({ type: 'error', message: 'Could not reach the server. Please try again shortly.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Contact</span>
            <h1>Let's talk about your pharmacy's numbers</h1>
            <p className="lead">
              Tell us a bit about your setup and we'll get back to you within one business day —
              or book a short call to see your first report live.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="contact-grid">
            <div className="contact-info">
              <div className="info-row">
                <span className="k">Email</span>
                <span>hello@rxnaija-analytics.com</span>
              </div>
              <div className="info-row">
                <span className="k">Phone</span>
                <span>+234 800 000 0000</span>
              </div>
              <div className="info-row">
                <span className="k">Office</span>
                <span>Lagos, Nigeria</span>
              </div>
              <div className="info-row">
                <span className="k">Hours</span>
                <span>Mon – Fri, 9am – 6pm WAT</span>
              </div>
            </div>

            <form className="contact-form" onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="name">Full name</label>
                  <input id="name" name="name" required value={form.name} onChange={handleChange} placeholder="Adaeze Okafor" />
                </div>
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input id="email" name="email" type="email" required value={form.email} onChange={handleChange} placeholder="you@pharmacy.com" />
                </div>
              </div>

              <div className="field">
                <label htmlFor="pharmacyName">Pharmacy name (optional)</label>
                <input id="pharmacyName" name="pharmacyName" value={form.pharmacyName} onChange={handleChange} placeholder="Okafor Community Pharmacy" />
              </div>

              <div className="field">
                <label htmlFor="message">What would you like to know?</label>
                <textarea
                  id="message"
                  name="message"
                  required
                  rows={5}
                  value={form.message}
                  onChange={handleChange}
                  placeholder="Tell us about your branches, your POS/ERP, and what you'd like to see."
                />
              </div>

              <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send message'}
              </button>

              {status && (
                <div className={`form-status ${status.type}`}>{status.message}</div>
              )}
            </form>
          </div>
        </div>
      </section>
    </>
  );
}
