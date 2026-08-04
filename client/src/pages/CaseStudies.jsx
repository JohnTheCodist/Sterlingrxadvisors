import { Link } from 'react-router-dom';

const cases = [
  {
    name: 'Ilupeju Community Pharmacy Group',
    result: 'Recovered ₦2.1M in unclaimed NHIA balances within one quarter',
    body: "A 3-branch independent group was writing off missed NHIA claims as routine loss. SterlingRx Advisors's collections tracker flagged every unclaimed and mismatched entry across branches, recovering balances that had been slipping through for months.",
    figs: [
      { value: '₦2.1M', label: 'Recovered in unclaimed balances' },
      { value: '73%', label: 'Reduction in claim losses' },
    ],
  },
  {
    name: 'Garki Family Pharmacy',
    result: '18% margin improvement in four months',
    body: 'Profitability analysis surfaced which OTC categories were selling well but earning almost nothing after supplier terms. Reordering shifted toward higher-margin lines within weeks, without cutting range.',
    figs: [
      { value: '18%', label: 'Gross margin improvement' },
      { value: '25%', label: 'Less dead stock on shelf' },
    ],
  },
  {
    name: 'Trinity Retail Pharmacies (4 branches)',
    result: '30% less time spent on manual monthly reporting',
    body: 'Branch managers previously spent entire Sunday afternoons rebuilding spreadsheets from ERP printouts. With daily automated Pulse reports, monthly review dropped from a full day to under an hour per branch.',
    figs: [
      { value: '30%', label: 'Time saved on reporting' },
      { value: '3 wks', label: 'To go live across all branches' },
    ],
  },
];

export default function CaseStudies() {
  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Customer success</span>
            <h1>Real pharmacies, real numbers</h1>
            <p className="lead">
              How independent pharmacies and small groups have used SterlingRx Advisors to recover
              cash, cut dead stock, and take back their evenings.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="case-grid">
            {cases.map((c) => (
              <div className="case-card" key={c.name}>
                <span className="eyebrow">{c.name}</span>
                <h3>{c.result}</h3>
                <div className="case-figs">
                  {c.figs.map((f) => (
                    <div key={f.label}>
                      <span className="value">{f.value}</span>
                      <span className="label">{f.label}</span>
                    </div>
                  ))}
                </div>
                <p className="body">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <div className="shell">
          <div className="testimonial">
            <div>
              <blockquote>
                "RWA-style reports were never built for how Nigerian pharmacies actually get
                paid. SterlingRx Advisors finally separates cash, claims, and margin the way we think about
                the business day to day."
              </blockquote>
              <cite>— Owner, 2-branch independent pharmacy, Abuja</cite>
            </div>
            <div className="testimonial-stats">
              <div>
                <div className="value">98.6%</div>
                <div className="label">of export rows matched automatically</div>
              </div>
              <div>
                <div className="value">5 min</div>
                <div className="label">daily review time per branch</div>
              </div>
              <div>
                <div className="value">60+</div>
                <div className="label">pharmacies using automated reports</div>
              </div>
              <div>
                <div className="value">630K</div>
                <div className="label">automated reports generated yearly*</div>
              </div>
            </div>
          </div>
          <p style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--color-ink-faint)', marginTop: 16 }}>
            *Illustrative figures — replace with your own customer metrics before launch.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="cta-band">
            <h2>Become the next success story</h2>
            <p>Tell us about your pharmacy and we'll show you what your own numbers could look like.</p>
            <Link to="/contact" className="btn btn-accent">Talk to us</Link>
          </div>
        </div>
      </section>
    </>
  );
}
