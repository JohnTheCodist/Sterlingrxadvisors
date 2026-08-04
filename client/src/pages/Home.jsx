import { Link } from 'react-router-dom';
import PulseCard from '../components/PulseCard.jsx';

export default function Home() {
  return (
    <>
      {/* HERO */}
      <section className="hero">
        <div className="shell">
          <div className="hero-copy">
            <span className="eyebrow">Pharmacy Business Intelligence</span>
            {/* Tight em-dashes, against the spaced style used elsewhere on the
                page. Spaced, the line broke as "— and Losing —" on its own,
                opening and closing a line with a dash. Keeping them closed up
                binds each dash to its word and breaks cleanly. */}
            <h1>Know Where Your Pharmacy Is Making&#8212;and Losing&#8212;Money.</h1>
            <p className="lead">
              Turn your pharmacy data into clear, actionable business decisions in under 5 minutes.
            </p>
            <p className="hero-nos">No integrations. No spreadsheets. No data analyst required.</p>
            <div className="hero-actions">
              {/* Points at /signup, not /contact where "Start free trial" used to
                  go. "Analyze My Pharmacy" promises the product, so landing on a
                  contact form would be a broken promise on the first click. */}
              <Link to="/signup" className="btn btn-primary">
                Analyze My Pharmacy <span aria-hidden="true">→</span>
              </Link>
              <Link to="/how-it-works" className="btn btn-ghost">See how it works</Link>
            </div>
            <div className="hero-microcopy">
              <span>14-day free trial</span>
              <span>No card required</span>
              <span>Cancel anytime</span>
            </div>
          </div>

          <PulseCard />
        </div>
      </section>

      {/* TRUST STRIP */}
      <section className="trust-strip">
        <div className="shell">
          <span className="trust-label">Built for pharmacies like</span>
          <div className="trust-names">
            <span>Independent chemists</span>
            <span>Community pharmacy groups</span>
            <span>Hospital-adjacent outlets</span>
            <span>Multi-branch retailers</span>
          </div>
        </div>
      </section>

      {/* APPROACH — the .problem-* class names predate this copy and are left
          alone deliberately: they are structural, shared with the stylesheet,
          and renaming them would be a CSS change dressed up as a copy change. */}
      <section className="section">
        <div className="shell">
          <div className="problem-grid">
            <div>
              <span className="eyebrow">The approach</span>
              <h2>From what your pharmacy records to what it should do next.</h2>
              <div className="problem-list" style={{ marginTop: 32 }}>
                <div className="problem-item">
                  <span className="num">01</span>
                  <div>
                    <h3>Your pharmacy produces data. We turn it into decisions.</h3>
                    <p>Every sale, supplier invoice, and inventory movement tells a story. Most systems simply record it. We reveal what it means — and what management should do next.</p>
                  </div>
                </div>
                <div className="problem-item">
                  <span className="num">02</span>
                  <div>
                    <h3>Every hidden inefficiency is money left on the table.</h3>
                    <p>Poor product mix, shrinking margins, excess inventory, supplier performance, and expiry risk quietly erode profitability. We surface the issues that deserve immediate attention.</p>
                  </div>
                </div>
                <div className="problem-item">
                  <span className="num">03</span>
                  <div>
                    <h3>Know today's priorities before they become tomorrow's problems.</h3>
                    <p>Don't wait until month-end reports tell you what already happened. Make faster, evidence-based decisions with AI that continuously monitors your business and highlights the actions with the greatest financial impact.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="printout">
              <div className="row"><span>Total revenue</span><span>₦412,000</span></div>
              <div className="row"><span>Rx / OTC split</span><span className="unknown">??? </span></div>
              <div className="row"><span>Cash vs NHIA owed</span><span className="unknown">???</span></div>
              <div className="row"><span>Gross margin</span><span className="unknown">???</span></div>
              <div className="row"><span>Real month-to-date performance</span><span className="unknown">??????</span></div>
              <div className="row" style={{ borderBottom: 'none' }}><span>What to reorder tonight</span><span className="unknown">???</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* SOLUTION / COMPARISON */}
      <section className="section section--alt">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">The solution</span>
            <h2>Complete visibility. No more report chaos.</h2>
            <p className="lead">
              You shouldn't need to be a data analyst to run your pharmacy. SterlingRx Advisors
              works like your personal auditor — turning printout noise into direct financial
              answers, showing not just what you sold, but what actually made you money.
            </p>
          </div>

          <div className="compare-table">
            <div className="compare-col old">
              <div className="compare-col-head">Without SterlingRx Advisors</div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">⏳</span>4 hours building reports</strong>
                <span>"It's already 8:30 PM. You're still exporting reports, combining Excel files, and trying to figure out why today's sales feel good but your bank balance doesn't."</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">💰</span>Revenue with no profit visibility</strong>
                <span>You celebrate a ₦2.5M sales week, only to discover later that your highest-selling products were also your lowest-margin products.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">📦</span>Guessing what to reorder</strong>
                <span>You reorder 30 packs of a product because it "usually sells," while your actual best-seller runs out three days later.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">💸</span>Cash trapped in inventory</strong>
                <span>₦1.8M is sitting on your shelves, but ₦450,000 of it hasn't moved in months and another ₦120,000 is approaching expiry.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">🚨</span>Reacting after problems occur</strong>
                <span>You only notice expired products during stock count — or discover a stockout after customers have already gone elsewhere.</span>
              </div>
            </div>

            <div className="compare-col new">
              <div className="compare-col-head">With SterlingRx Advisors</div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">⚡</span>5 minutes to executive insights</strong>
                <span>Upload your POS data and instantly see revenue, profit, inventory risks, and the actions that deserve your attention today.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">📈</span>Revenue, profit, margins &amp; cash flow in one place</strong>
                <span>Know exactly which products generated profit, which reduced it, and where your biggest financial opportunities are hiding.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">🎯</span>AI tells you exactly what to buy more — or less — of</strong>
                <span>Prioritize fast-moving, high-margin products and avoid tying cash up in slow-moving inventory.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">💼</span>Working capital optimized with data-backed decisions</strong>
                <span>See where cash is locked up, what can be liquidated, and which products deserve additional investment.</span>
              </div>
              <div className="compare-row">
                <strong><span className="compare-icon" aria-hidden="true">🛡️</span>Identify risks before they cost you money</strong>
                <span>Receive early warnings for expiry risks, low stock, declining margins, and supplier issues before they impact your business.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PROCESS */}
      <section className="section">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">The process</span>
            <h2>From pharmacy data to executive decisions — in just 3 steps.</h2>
            <p className="lead">You need clear answers, not a software course. We removed every technical hurdle — no special skills required.</p>
          </div>

          <div className="steps">
            <div className="step-card">
              <div className="step-num">01</div>
              <h3>Export your report</h3>
              <p>From your existing POS or pharmacy software, export your sales or inventory data.</p>
              <span className="step-time">≈ 30 seconds</span>
            </div>
            <div className="step-card">
              <div className="step-num">02</div>
              <h3>Let AI do the heavy lifting</h3>
              <p>Upload the file and let SterlingRx Advisors clean, analyze, and interpret your data automatically.</p>
              <span className="step-time">≈ 2 minutes</span>
            </div>
            <div className="step-card">
              <div className="step-num">03</div>
              <h3>Act with confidence</h3>
              <p>Receive a complete business health assessment, executive dashboards, and clear recommendations on what to do next.</p>
              <span className="step-time">≈ 2–3 minutes</span>
            </div>
          </div>

          <div className="outcome">
            <p className="outcome-ask">
              Instead of asking <em>"What happened?"</em> — you'll know:
            </p>
            <ul className="outcome-list">
              <li>Where profit is growing</li>
              <li>Where cash is trapped</li>
              <li>Which products deserve more investment</li>
              <li>Which products should leave your shelves</li>
              <li>Which actions will have the biggest financial impact today</li>
            </ul>
          </div>
        </div>
      </section>

      {/* SIGNAL SYSTEM */}
      <section className="section section--alt">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Instant diagnosis</span>
            <h2>Know exactly where to focus, at a glance</h2>
            <p className="lead">A simple traffic-light logic tells you what needs attention today.</p>
          </div>

          <div className="signal-row">
            <div className="signal-card green">
              <h3><span className="signal-dot" />All clear</h3>
              <p>Margins and stock levels are on target. Nothing to change today.</p>
            </div>
            <div className="signal-card amber">
              <h3><span className="signal-dot" />Watch this</h3>
              <p>A category or claim is drifting — worth a look before it becomes a problem.</p>
            </div>
            <div className="signal-card red">
              <h3><span className="signal-dot" />Act now</h3>
              <p>A loss-making line or unclaimed balance needs your attention immediately.</p>
            </div>
          </div>
        </div>
      </section>

      {/* STAT BAND */}
      <section className="section">
        <div className="shell">
          <div className="stat-band">
            <div className="shell-inner">
              <div className="stat-item">
                <div className="value">30%</div>
                <div className="label">less time on manual reporting</div>
              </div>
              <div className="stat-item">
                <div className="value">40%</div>
                <div className="label">average profit lift on services</div>
              </div>
              <div className="stat-item">
                <div className="value">25%</div>
                <div className="label">reduction in dead stock</div>
              </div>
              <div className="stat-item">
                <div className="value">5 min</div>
                <div className="label">a day to review performance</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* TESTIMONIAL */}
      <section className="section section--alt">
        <div className="shell">
          <div className="testimonial">
            <div>
              <blockquote>
                "We finally see cash, claims, and margin as three separate stories instead of
                one confusing number. Reordering stopped being a guessing game."
              </blockquote>
              <cite>— Pharmacy Manager, 3-branch independent group, Lagos</cite>
            </div>
            <div className="testimonial-stats">
              <div>
                <div className="value">₦2.1M</div>
                <div className="label">recovered from unclaimed NHIA balances</div>
              </div>
              <div>
                <div className="value">18%</div>
                <div className="label">margin improvement in 4 months</div>
              </div>
              <div>
                <div className="value">3 wks</div>
                <div className="label">to go live across all branches</div>
              </div>
              <div>
                <div className="value">100%</div>
                <div className="label">visibility across cash, claims and stock</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section">
        <div className="shell">
          <div className="cta-band">
            <h2>Stop just moving stock. Start keeping the profit.</h2>
            <p>Upload your file tonight and see your real numbers before you close the shop tomorrow.</p>
            <Link to="/contact" className="btn btn-accent">Start free trial</Link>
          </div>
        </div>
      </section>
    </>
  );
}
