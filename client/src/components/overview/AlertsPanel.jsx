// Aggregates alert-worthy signals that already exist elsewhere in the
// pipeline output — bizHealth.health.concerns (pre-filtered to warning/
// critical bands by server/services/businessHealth.js), the concentration
// risk flag already computed client-side, and the data-quality report from
// the ingestion pipeline. No new scoring — this is a merge-and-cap-at-5,
// not a new alerts engine.

function classify(text) {
  const t = text.toLowerCase();
  if (t.includes('expir')) return { label: 'Near Expiry', cls: 'bg-warning/10 text-warning' };
  if (t.includes('stock') || t.includes('reorder')) return { label: 'Low Stock', cls: 'bg-destructive/10 text-destructive' };
  if (t.includes('margin') || t.includes('profit')) return { label: 'Margin', cls: 'bg-warning/10 text-warning' };
  if (t.includes('overstock')) return { label: 'Overstock', cls: 'bg-warning/10 text-warning' };
  return { label: 'Attention', cls: 'bg-primary/10 text-[var(--color-primary)]' };
}

export default function AlertsPanel({ concerns, top3Pct, dataHealth }) {
  const alerts = [];

  if (top3Pct != null && top3Pct > 30) {
    alerts.push({
      label: 'Concentration Risk',
      cls: 'bg-destructive/10 text-destructive',
      text: `Top 3 products account for ${top3Pct}% of revenue — a supply or demand shock to any one of them puts a large share of income at risk.`,
    });
  }

  if (dataHealth) {
    const issueCount = (dataHealth.structuralTotal || 0) + (dataHealth.businessTotal || 0) + (dataHealth.derivedBusinessIssues?.total || 0);
    if (issueCount > 0 || dataHealth.overallCompleteness < 80) {
      alerts.push({
        label: 'Data Quality',
        cls: 'bg-warning/10 text-warning',
        text: dataHealth.overallCompleteness < 80
          ? `Data completeness is ${Math.round(dataHealth.overallCompleteness)}% — some metrics may be undercounted.`
          : `${issueCount} row-level issue${issueCount === 1 ? '' : 's'} were excluded from analysis.`,
      });
    }
  }

  (concerns || []).forEach((text) => {
    if (alerts.length >= 5) return;
    const { label, cls } = classify(text);
    alerts.push({ label, cls, text });
  });

  if (alerts.length === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-3 text-base font-semibold text-[var(--color-ink)]">Critical Alerts</h2>
      <div className="space-y-2.5">
        {alerts.slice(0, 5).map((a, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${a.cls}`}>{a.label}</span>
            <p className="text-sm text-[var(--color-ink-soft)] leading-relaxed">{a.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
