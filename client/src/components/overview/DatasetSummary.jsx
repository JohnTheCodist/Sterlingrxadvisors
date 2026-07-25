const LABELS = { sales: 'Sales', inventory: 'Inventory', expiry: 'Expiry', supplier: 'Suppliers', customer: 'Customers' };

export default function DatasetSummary({ fileName, generatedAt, capabilities }) {
  const active = Object.entries(capabilities || {}).filter(([, v]) => v).map(([k]) => k);
  if (!fileName && active.length === 0) return null;

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--color-ink)] truncate">{fileName || 'Uploaded dataset'}</p>
        {generatedAt && (
          <p className="text-xs text-[var(--color-ink-faint)]">Analyzed {new Date(generatedAt).toLocaleString()}</p>
        )}
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {active.map((key) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-primary-tint)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-primary)]"
            >
              {LABELS[key] || key}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
