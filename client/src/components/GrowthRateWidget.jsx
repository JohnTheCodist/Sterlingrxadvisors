import InfoBadge from './InfoBadge';

function GrowthRateWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Unavailable</p>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  const growth = result?.growth ?? 0;
  const classification = result?.growthClassification ?? 'Stable';
  const supportingInsight = result?.supportingInsight ?? 'No insight available.';
  const decisionSupport = result?.decisionSupport ?? 'Use historical data for better insights.';
  const sublabel = result?.sublabel || 'vs Previous Month';

  // Trend color indicator
  const trendColor = classification === 'Growing' ? 'text-emerald-600' : classification === 'Declining' ? 'text-red-600' : 'text-amber-600';
  const trendBg = classification === 'Growing' ? 'bg-emerald-100' : classification === 'Declining' ? 'bg-red-100' : 'bg-amber-100';

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
            <InfoBadge description={w.description} />
          </div>
          <p className="text-xs text-[var(--color-ink-faint)] mt-1">{w.description || 'Identifies whether your business is accelerating, slowing, or remaining stable.'}</p>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-full ${trendBg}`}>
          <span className={`text-sm font-bold ${trendColor}`}>
            {growth > 0 ? '↑' : growth < 0 ? '↓' : '—'}
          </span>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Growth Metric */}
        <div className="rounded-lg bg-[var(--color-bg)] p-4 border border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Current Growth Rate</p>
          <p className={`text-3xl font-bold font-mono ${trendColor}`}>
            {growth > 0 ? '+' : ''}{growth}%
          </p>
          <p className={`text-xs font-semibold mt-2 ${trendColor}`}>
            {classification} {sublabel}
          </p>
        </div>

        {/* Supporting Insight */}
        <div className="rounded-lg bg-[var(--color-bg-alt)] p-4 border border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">Key Insight</p>
          <p className="text-sm text-[var(--color-ink-soft)]">{supportingInsight}</p>
        </div>
      </div>

      {/* Decision Support */}
      <div className="mt-4 rounded-lg bg-[var(--color-bg)] p-4 border border-[var(--color-line)] border-l-4 border-l-[var(--color-primary)]">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">What This Means</p>
        <p className="text-sm text-[var(--color-ink)]">{decisionSupport}</p>
      </div>
    </div>
  );
}

export default GrowthRateWidget;
