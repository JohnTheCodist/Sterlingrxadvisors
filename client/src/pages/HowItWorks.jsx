import { Link } from 'react-router-dom';

export default function HowItWorks() {
  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">How it works</span>
            <h1>No installs. No IT team. Just a file.</h1>
            <p className="lead">
              You already have everything SterlingRx Advisors needs — it's sitting inside your POS or ERP.
              We just help you see it clearly.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="steps">
            <div className="step-card">
              <div className="step-num">01</div>
              <h3>Set up your export, once</h3>
              <p>
                Together, we design the export template inside your existing dispensing or POS
                system — the exact columns SterlingRx Advisors needs, nothing more. This is a one-time setup.
              </p>
            </div>
            <div className="step-card">
              <div className="step-num">02</div>
              <h3>Pull the file whenever you like</h3>
              <p>
                Daily, weekly, whenever suits your routine — just request the export from your
                system and download it. No permanent connection or "bridge" to your ERP required.
              </p>
            </div>
            <div className="step-card">
              <div className="step-num">03</div>
              <h3>Upload to SterlingRx Advisors</h3>
              <p>
                Drag the file into your dashboard. It's parsed, checked, and matched against your
                pharmacy's categories in under a minute.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <div className="shell">
          <div className="grid-2">
            <div>
              <span className="eyebrow">What you get back</span>
              <h2>A clear picture, not a spreadsheet</h2>
              <p className="lead" style={{ marginTop: 16 }}>
                Your Commercial Pulse, Profitability, and Collections views update instantly —
                built to be read at a glance, on your phone or your laptop, in under three minutes.
              </p>
            </div>
            <div className="printout">
              <div className="row"><span>File received</span><span>pharmacy_export_15jul.csv</span></div>
              <div className="row"><span>Rows processed</span><span>1,842</span></div>
              <div className="row"><span>Categories matched</span><span>98.6%</span></div>
              <div className="row"><span>Report ready</span><span>in 47 seconds</span></div>
              <div className="row" style={{ borderBottom: 'none' }}><span>Status</span><span>Ready to review</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Support along the way</span>
            <h2>Onboarding that doesn't leave you guessing</h2>
          </div>
          <div className="feature-grid">
            <div className="feature-card">
              <div className="feature-icon">1</div>
              <h3>Template setup call</h3>
              <p>We walk through your ERP's export screen with you, once, so the columns line up correctly from day one.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">2</div>
              <h3>First-upload review</h3>
              <p>Your first report is checked with you together, so any "odd" figures from your ERP are explained, not left as a mystery.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">3</div>
              <h3>Ongoing support</h3>
              <p>Questions about a number? Reach out any time — we're independent, and our only job is telling you the truth of your numbers.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="cta-band">
            <h2>Your first report is minutes away</h2>
            <p>Book a short call and we'll help you set up your first export template.</p>
            <Link to="/contact" className="btn btn-accent">Talk to us</Link>
          </div>
        </div>
      </section>
    </>
  );
}
