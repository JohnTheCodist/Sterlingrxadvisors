import { Link } from 'react-router-dom';

/**
 * Icons are hand-drawn inline SVG on one shared geometry: a 20×20 box, 1.5
 * stroke, round caps and joins, no fills, currentColor.
 *
 * The supplied copy carried emoji (💰 📦 ⚠️ 📈 …). They were not used, for
 * three reasons: emoji render as a different picture on every operating
 * system, so the page cannot be art-directed; they arrive full-colour and
 * fight a palette built on one teal; and the set contained near-duplicates
 * (💰/💵, 📈/📊) that would have read as two names for the same feature.
 *
 * The glyphs they replace (₦ ✓ % ▤ ⇄ ⚑) had the opposite problem — visually
 * inconsistent with each other, and there is no tenth sensible glyph.
 *
 * One stroke width across ten drawings is what makes them look like a set
 * rather than ten clip-art choices.
 */
const Icon = ({ children }) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const features = [
  {
    title: 'Profit & Margin Intelligence',
    body: 'Know exactly which products, brands, and categories make you money — and which quietly destroy your margins.',
    icon: <Icon><path d="M3 15.5 8 10l3.5 3.5L17 7" /><path d="M13 7h4v4" /></Icon>,
  },
  {
    title: 'Inventory Decision Engine',
    body: 'Stop over-ordering and stockouts. Know what to reorder, what to reduce, and where your cash is trapped.',
    icon: <Icon><rect x="3" y="8.5" width="6" height="8" rx="1" /><rect x="11" y="4" width="6" height="12.5" rx="1" /><path d="M3 8.5h6M11 4h6" /></Icon>,
  },
  {
    title: 'Expiry & Dead Stock Monitor',
    body: 'Identify products at risk of expiry, dead stock draining your cash, and the fastest actions to recover value.',
    icon: <Icon><circle cx="10" cy="11" r="6" /><path d="M10 8v3.2l2 1.6" /><path d="M7.5 3h5" /></Icon>,
  },
  {
    title: 'Sales Performance Dashboard',
    body: 'Track revenue, transactions, best sellers, slow movers, and business trends with executive-level clarity.',
    icon: <Icon><path d="M3 16.5h14" /><path d="M6 16.5v-4M10 16.5V7M14 16.5v-6.5" /></Icon>,
  },
  {
    title: 'AI Pharmacy Advisor',
    body: 'Ask questions in plain English — "Which products should I invest in?" — and get evidence-backed recommendations from your own data.',
    icon: <Icon><path d="M16.5 12.5a1.8 1.8 0 0 1-1.8 1.8H7.4L4 17V5.3a1.8 1.8 0 0 1 1.8-1.8h8.9a1.8 1.8 0 0 1 1.8 1.8z" /><path d="M10.2 6.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z" /></Icon>,
  },
  {
    title: 'Executive Decision Intelligence',
    body: "Go beyond reports. Every analysis explains what's happening, why it matters, its financial impact, and the highest-priority actions to take.",
    icon: <Icon><circle cx="5" cy="10" r="2" /><circle cx="15" cy="5.5" r="2" /><circle cx="15" cy="14.5" r="2" /><path d="M7 9.2 13 6M7 10.8 13 14" /></Icon>,
  },
  {
    title: 'Cash Flow & Working Capital',
    body: 'See where money is tied up in inventory, where profit is leaking, and how to free up cash for growth.',
    icon: <Icon><path d="M3.5 7.5h10.5" /><path d="M11.5 5 14 7.5 11.5 10" /><path d="M16.5 12.5H6" /><path d="M8.5 10 6 12.5 8.5 15" /></Icon>,
  },
  {
    title: 'Smart Reorder Recommendations',
    body: 'Prioritise products by stock level, profitability, demand, seasonality, and expiry risk — not guesswork.',
    icon: <Icon><path d="M3.5 5.5h3l1.4 7.2a1.3 1.3 0 0 0 1.3 1h5.6" /><circle cx="9" cy="16.5" r="1" /><circle cx="14.5" cy="16.5" r="1" /><path d="M11 5.5h5.5l-1 4.5H11.9" /></Icon>,
  },
  {
    title: 'Business Health Score',
    body: 'Measure the overall health of your pharmacy with a single score backed by profitability, inventory, cash flow, and operations.',
    icon: <Icon><path d="M3.5 14a7 7 0 1 1 13 0" /><path d="M10 14l3.2-4" /><circle cx="10" cy="14" r="0.9" /></Icon>,
  },
  {
    title: 'Works With Your Existing POS',
    body: 'Upload your Excel or CSV export from almost any pharmacy system. No integrations, no migration, no IT team required.',
    icon: <Icon><path d="M11 2.8H6.2a1.7 1.7 0 0 0-1.7 1.7v11a1.7 1.7 0 0 0 1.7 1.7h7.6a1.7 1.7 0 0 0 1.7-1.7V7.2z" /><path d="M11 2.8v4.4h4.5" /><path d="M7.8 11.5h4.4M7.8 14h2.8" /></Icon>,
  },
];

export default function Features() {
  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Features</span>
            <h1>Everything you need to run a more profitable pharmacy</h1>
            <p className="lead">
              One upload turns scattered POS exports into a clear financial picture — built
              around how Nigerian pharmacies actually get paid.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          {/* A list, not a deck of cards. Ten bordered tiles is ten boxes of
              visual weight competing with each other; ten hairline-ruled rows
              read as one substantial inventory of capability. */}
          <ul className="capability-list">
            {features.map((f) => (
              <li className="capability" key={f.title}>
                <span className="capability-icon">{f.icon}</span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
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
