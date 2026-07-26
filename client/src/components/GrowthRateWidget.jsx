import { useState } from 'react';
import InfoBadge from './InfoBadge';

const GRANULARITY_LABELS = { month: 'Month', week: 'Week', day: 'Day' };

function GrowthRateWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  const drillLevels = result.drillLevels;
  const levels = drillLevels ? Object.keys(drillLevels) : null;
  const [activeLevel, setActiveLevel] = useState(result.displayGranularity || (levels ? levels[0] : null));

  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Unavailable</p>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  // Each drill level carries its own full summary (growth/classification/
  // insight/decisionSupport) computed server-side — the toggle just swaps
  // which one is displayed, it doesn't recompute anything client-side.
  const active = (levels && drillLevels[activeLevel]) || result;

  const growth = active?.growth ?? 0;
  const classification = active?.growthClassification ?? 'Stable';
  const supportingInsight = active?.supportingInsight ?? 'No insight available.';
  const decisionSupport = active?.decisionSupport ?? 'Use historical data for better insights.';
  const sublabel = active?.sublabel || 'vs Previous Month';

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
        <div className="flex items-center gap-3 shrink-0">
          {levels && levels.length > 1 && (
            <div className="flex items-center gap-1">
              {levels.map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setActiveLevel(lvl)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    activeLevel === lvl
                      ? 'bg-[var(--color-primary)] text-primary-foreground'
                      : 'bg-[var(--color-bg)] text-[var(--color-ink-soft)] hover:bg-[var(--color-primary-tint)]'
                  }`}
                >
                  {GRANULARITY_LABELS[lvl] || lvl}
                </button>
              ))}
            </div>
          )}
          <div className={`flex h-10 w-10 items-center justify-center rounded-full ${trendBg}`}>
            <span className={`text-sm font-bold ${trendColor}`}>
              {growth > 0 ? '↑' : growth < 0 ? '↓' : '—'}
            </span>
          </div>
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
