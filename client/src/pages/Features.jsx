import { Link } from 'react-router-dom';

const features = [
  {
    icon: '₦',
    title: 'Commercial Pulse',
    body: 'Daily, weekly, and monthly revenue, broken into counter, wholesale, and e-channel — updated the moment you upload.',
  },
  {
    icon: '✓',
    title: 'NHIA & Collections Tracker',
    body: 'See real cash in hand versus outstanding NHIA claims. Catch human error, mismatched entries, and unclaimed balances before they cost you.',
  },
  {
    icon: '%',
    title: 'Profitability Analysis',
    body: 'Find out which categories, brands, or SKUs build turnover and profit, which just recycle cash, and which are quietly losing you money.',
  },
  {
    icon: '▤',
    title: 'Sales X-Ray',
    body: 'Spot your best-margin performers and the slow movers rotting on the shelf. Free up cash tied up in dead stock.',
  },
  {
    icon: '⇄',
    title: 'Multi-Branch Comparison',
    body: 'Line up branches side by side on the same metrics, so you know which locations need support and which to replicate.',
  },
  {
    icon: '⚑',
    title: 'Signal Alerts',
    body: 'A simple green / amber / red system flags what needs attention today — no digging through spreadsheets required.',
  },
];

export default function Features() {
  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Features</span>
            <h1>Everything your printouts won't tell you</h1>
            <p className="lead">
              One upload turns scattered POS exports into a clear financial picture — built
              around how Nigerian pharmacies actually get paid.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="feature-grid">
            {features.map((f) => (
              <div className="feature-card" key={f.title}>
                <div className="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <div className="shell">
          <div className="grid-2">
            <div>
              <span className="eyebrow">Built Nigerian-first</span>
              <h2>Calculations that speak your pharmacy's language</h2>
              <p className="lead" style={{ marginTop: 16 }}>
                Our reports understand Rx, OTC, VAT, and NHIA claims. No black-box math — if a
                number looks strange, you can trace exactly how it was calculated.
              </p>
            </div>
            <div className="printout">
              <div className="row"><span>Rx revenue</span><span>₦218,400</span></div>
              <div className="row"><span>OTC revenue</span><span>₦141,900</span></div>
              <div className="row"><span>VAT (7.5%)</span><span>₦26,663</span></div>
              <div className="row"><span>NHIA outstanding</span><span>₦64,200</span></div>
              <div className="row" style={{ borderBottom: 'none' }}><span>Net gross margin</span><span>₦96,150</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="cta-band">
            <h2>See it running on your own numbers</h2>
            <p>Upload one file and get your first Commercial Pulse report today.</p>
            <Link to="/contact" className="btn btn-accent">Start free trial</Link>
          </div>
        </div>
      </section>
    </>
  );
}
