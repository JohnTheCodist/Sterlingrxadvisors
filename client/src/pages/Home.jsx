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
            <h1>Know your pharmacy's real numbers in three minutes.</h1>
            <p className="lead">
              See what's actually selling, what's leaving you profit, and what's quietly
              costing you money. Separate counter sales from e-channel, cash from NHIA claims —
              from one file, no installs, no IT team.
            </p>
            <div className="hero-actions">
              <Link to="/contact" className="btn btn-primary">Start free trial</Link>
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

      {/* PROBLEM */}
      <section className="section">
        <div className="shell">
          <div className="problem-grid">
            <div>
              <span className="eyebrow">The problem</span>
              <h2>You're on your feet all day. Are you actually keeping what you earn?</h2>
              <div className="problem-list" style={{ marginTop: 32 }}>
                <div className="problem-item">
                  <span className="num">01</span>
                  <div>
                    <h3>Numbers that don't talk back</h3>
                    <p>Your POS or ERP logs everything, but there's no single screen that tells you, plainly, how today actually went.</p>
                  </div>
                </div>
                <div className="problem-item">
                  <span className="num">02</span>
                  <div>
                    <h3>The blind spot in your orders</h3>
                    <p>Which SKUs sell with zero margin? Which supplier deal quietly lost you money? Not knowing costs you cash, directly.</p>
                  </div>
                </div>
                <div className="problem-item">
                  <span className="num">03</span>
                  <div>
                    <h3>Managing after the fact</h3>
                    <p>You can't make March decisions on January's printouts. Getting back in control means seeing today, today.</p>
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
              You shouldn't need to be a data analyst to run your pharmacy. RxNaija Analytics
              works like your personal auditor — turning printout noise into direct financial
              answers, showing not just what you sold, but what actually made you money.
            </p>
          </div>

          <div className="compare-table">
            <div className="compare-col old">
              <div className="compare-col-head">Without RxNaija</div>
              <div className="compare-row">
                <strong>The revenue illusion</strong>
                <span>"I made ₦400K today, so business is good" — ignoring VAT and unpaid NHIA claims.</span>
              </div>
              <div className="compare-row">
                <strong>Sunday-night spreadsheets</strong>
                <span>Whole afternoons spent squinting at printouts and rebuilding Excel sheets.</span>
              </div>
              <div className="compare-row">
                <strong>At suppliers' mercy</strong>
                <span>Negotiating discounts and rebates on a rough guess, not real numbers.</span>
              </div>
              <div className="compare-row">
                <strong>Blind ordering</strong>
                <span>Slow-moving SKUs sit on the shelf, hidden inside your total turnover figure.</span>
              </div>
            </div>

            <div className="compare-col new">
              <div className="compare-col-head">With RxNaija</div>
              <div className="compare-row">
                <strong>The real cash truth</strong>
                <span>Commercial performance separated from actual collections. Revenue − Cost − Cash in hand.</span>
              </div>
              <div className="compare-row">
                <strong>Three clicks, done</strong>
                <span>A ready picture of the day, week, or month. Close the laptop, keep your evening.</span>
              </div>
              <div className="compare-row">
                <strong>Real negotiating power</strong>
                <span>Walk into supplier talks with the hard sales numbers to back your ask.</span>
              </div>
              <div className="compare-row">
                <strong>Targeted restocking</strong>
                <span>Revenue and margin broken down by category and brand — what to buy, what to drop.</span>
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
            <h2>3 steps. 1 file. 5 minutes a day.</h2>
            <p className="lead">You need clear answers, not a software course. We removed every technical hurdle — no install, no special skills required.</p>
          </div>

          <div className="steps">
            <div className="step-card">
              <div className="step-num">01</div>
              <h3>Export</h3>
              <p>Set up your export template once in your POS or ERP with the columns RxNaija needs. After that, just pull the file whenever you like.</p>
            </div>
            <div className="step-card">
              <div className="step-num">02</div>
              <h3>Upload</h3>
              <p>Drop the file into RxNaija. No bridges, no permanent connection to your dispensing system required.</p>
            </div>
            <div className="step-card">
              <div className="step-num">03</div>
              <h3>See it clearly</h3>
              <p>Your performance picture is ready within minutes — check and act on it without the guesswork.</p>
            </div>
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
