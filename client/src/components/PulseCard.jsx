export default function PulseCard() {
  return (
    <div className="pulse-card" role="img" aria-label="Sample daily pharmacy performance dashboard">
      <div className="pulse-head">
        <span className="pulse-title">
          <span className="pulse-dot" /> Today's Pulse
        </span>
        <span className="pulse-date">Tue 15 Jul</span>
      </div>

      <div className="pulse-grid">
        <div className="pulse-metric">
          <span className="label">Revenue</span>
          <span className="value">₦412K</span>
          <span className="delta delta-up">▲ 3.1% vs yesterday</span>
        </div>
        <div className="pulse-metric">
          <span className="label">Avg. Receipt</span>
          <span className="value">₦4,850</span>
          <span className="delta delta-up">▲ 6.4%</span>
        </div>
        <div className="pulse-metric">
          <span className="label">Receipts</span>
          <span className="value">85</span>
          <span className="delta delta-down">▼ 2.0%</span>
        </div>
      </div>

      <div className="pulse-split">
        <div className="donut" />
        <div className="split-legend">
          <div className="row">
            <span className="swatch" style={{ background: 'var(--color-primary)' }} />
            Counter cash <strong>46%</strong>
          </div>
          <div className="row">
            <span className="swatch" style={{ background: 'var(--color-accent)' }} />
            NHIA claims <strong>28%</strong>
          </div>
          <div className="row">
            <span className="swatch" style={{ background: 'var(--color-ink-faint)' }} />
            Wholesale <strong>26%</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
