import { useState } from 'react';
import { Link } from 'react-router-dom';
import FAQItem from '../components/FAQItem.jsx';

const plans = [
  {
    name: 'The Baseline',
    sub: 'Everyday sales visibility for one location',
    monthly: 25000,
    yearly: 20000,
    perDay: '₦830 / day',
    features: [
      'Daily / weekly / monthly sales pulse',
      'Cash, VAT & NHIA collections view',
      'Sales by category, brand & supplier',
    ],
  },
  {
    name: 'Scientific Suite',
    sub: 'Full profitability control',
    monthly: 55000,
    yearly: 44000,
    perDay: '₦1,830 / day',
    featured: true,
    features: [
      'Everything in Baseline, plus:',
      'Full profitability analysis',
      'E-channel & omni-channel insights',
      'Branch-to-branch comparison',
    ],
  },
  {
    name: 'The Workspace',
    sub: 'Multi-branch, enterprise control',
    custom: true,
    features: [
      'Custom reporting, built to your needs',
      'Dedicated onboarding & training',
      'Additional data source integrations',
    ],
  },
];

export default function Pricing() {
  const [yearly, setYearly] = useState(false);

  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Pricing</span>
            <h1>Clear visibility. Clear pricing.</h1>
            <p className="lead">Pick the level of control your pharmacy needs — from everyday cash checks to full strategic review.</p>
          </div>

          <div style={{ textAlign: 'center' }}>
            <div className="billing-toggle">
              <button className={!yearly ? 'active' : ''} onClick={() => setYearly(false)}>Monthly</button>
              <button className={yearly ? 'active' : ''} onClick={() => setYearly(true)}>
                Yearly <span className="save-badge">Save 20%</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="pricing-grid">
            {plans.map((p) => (
              <div className={`price-card ${p.featured ? 'featured' : ''}`} key={p.name}>
                {p.featured && <span className="tag">Most popular</span>}
                <h3>{p.name}</h3>
                <p className="price-sub">{p.sub}</p>

                {p.custom ? (
                  <div className="price-value">Let's talk</div>
                ) : (
                  <div className="price-value">
                    ₦{(yearly ? p.yearly : p.monthly).toLocaleString()}<span>/ month</span>
                  </div>
                )}
                {!p.custom && <div className="price-per-day">{p.perDay}</div>}
                {p.custom && <div className="price-per-day">Covers multiple branches</div>}

                <ul className="price-features">
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>

                <Link to="/contact" className={`btn btn-block ${p.featured ? 'btn-primary' : 'btn-ghost'}`}>
                  {p.custom ? 'Talk to us' : 'Start free trial'}
                </Link>
              </div>
            ))}
          </div>

          <div className="pricing-note">
            <span>Prices exclude VAT</span>
            <span>14-day free trial</span>
            <span>No card required</span>
            <span>Cancel anytime</span>
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Pricing FAQ</span>
            <h2>Questions about plans</h2>
          </div>

          <div className="faq-list">
            <FAQItem
              question="Does the Baseline plan cover more than one branch?"
              answer="The Baseline and Scientific Suite plans each cover one pharmacy location. Add ₦25,000/month per additional branch, or move to The Workspace for full multi-branch pricing."
            />
            <FAQItem
              question="What happens after my free trial ends?"
              answer="You'll get a reminder before the 14 days are up. If you don't choose a plan, your account simply pauses — no charge, no card needed to start."
            />
            <FAQItem
              question="Can I switch plans later?"
              answer="Yes — upgrade, downgrade, or cancel at any time from your account settings. Changes apply from your next billing cycle."
            />
          </div>
        </div>
      </section>
    </>
  );
}
