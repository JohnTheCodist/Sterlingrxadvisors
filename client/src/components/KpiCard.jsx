import InfoBadge from './InfoBadge';

export default function KpiCard({ label, value, format, sub, trend, description }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">{label}</p>
        <InfoBadge description={description} />
      </div>
      <p className="mt-2 font-mono text-2xl font-bold text-[var(--color-ink)]">
        {format ? format(value) : value ?? '—'}
      </p>
      {sub && <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{sub}</p>}
      {trend != null && (
        <p className={`mt-1 text-xs font-semibold ${trend > 0 ? 'text-success' : trend < 0 ? 'text-destructive' : 'text-[var(--color-ink-faint)]'}`}>
          {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}% vs prior month
        </p>
      )}
    </div>
  );
}
