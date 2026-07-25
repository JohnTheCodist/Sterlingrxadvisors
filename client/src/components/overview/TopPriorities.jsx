// Renders the top 3 priorities exactly as returned by the existing
// Recommendation Engine (bizHealth.topPriorities — already the top 3 of
// generateInsights(), sorted by priorityScore server-side). No new ranking
// logic; this only lays the same fields out as compact priority cards.

function severityLabel(impact) {
  if (impact >= 3) return { label: 'HIGH', cls: 'bg-destructive/10 text-destructive' };
  if (impact >= 2) return { label: 'MEDIUM', cls: 'bg-warning/10 text-warning' };
  return { label: 'LOW', cls: 'bg-primary/10 text-[var(--color-primary)]' };
}

export default function TopPriorities({ topPriorities }) {
  if (!topPriorities || topPriorities.length === 0) return null;

  return (
    <div className="mb-6">
      <h2 className="mb-3 text-base font-semibold text-[var(--color-ink)]">Top Business Priorities</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {topPriorities.slice(0, 3).map((ins, i) => {
          const sev = severityLabel(ins.impact);
          return (
            <div key={i} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 flex flex-col">
              <span className={`self-start rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${sev.cls}`}>
                {sev.label}
              </span>
              <p className="mt-2 text-sm font-semibold text-[var(--color-ink)] leading-snug">
                {ins.metric || ins.pillar}
              </p>
              <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Potential Impact</p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-soft)] leading-relaxed flex-1">{ins.businessImpact}</p>
              <div className="mt-3 pt-3 border-t border-[var(--color-line)] flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Confidence</span>
                <span className="font-mono text-sm font-bold text-[var(--color-ink)]">{ins.confidence}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
