import InfoBadge from './InfoBadge';

/**
 * A single KPI figure.
 *
 * The previous card was a uniform rounded box — hairline on all four sides,
 * uppercase tracked-out label, figure in mono at 2xl. Twelve of them in a
 * grid read as twelve identical containers rather than twelve different
 * facts, because the thing distinguishing them (the label) was the smallest
 * element in the card.
 *
 * Now the figure leads: display face, tabular numerals, at a size the label
 * cannot compete with. The container recedes to a single hairline under the
 * label, so a row of these reads as a table of numbers rather than a tray of
 * boxes. Mono keeps exactly one role — the numerals — which is what holds a
 * column of naira figures in alignment.
 *
 * Props and data bindings are unchanged.
 */
export default function KpiCard({ label, value, format, sub, trend, description }) {
  const rendered = format ? format(value) : value ?? '—';
  const trendUp = trend > 0;
  const trendFlat = trend === 0;

  return (
    <div className="kpi-card">
      <div className="kpi-card__head">
        <p className="kpi-card__label">{label}</p>
        <InfoBadge description={description} />
      </div>

      <p className="kpi-card__value">{rendered}</p>

      {sub && <p className="kpi-card__sub">{sub}</p>}

      {trend != null && (
        <p className={`kpi-card__trend ${trendFlat ? 'is-flat' : trendUp ? 'is-up' : 'is-down'}`}>
          {/* Drawn, not an emoji or a second icon library — one stroke voice,
              and it inherits the trend colour rather than declaring its own. */}
          <svg
            className="kpi-card__arrow"
            width="10" height="10" viewBox="0 0 10 10"
            fill="none" stroke="currentColor" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          >
            {trendUp
              ? <path d="M5 8.5V1.5M1.8 4.7L5 1.5l3.2 3.2" />
              : <path d="M5 1.5v7M1.8 5.3L5 8.5l3.2-3.2" />}
          </svg>
          <span>{Math.abs(trend)}% vs prior month</span>
        </p>
      )}
    </div>
  );
}
