import { useMemo } from 'react';
import InfoBadge from './InfoBadge';

function formatNaira(n) {
  if (n == null || n === 0) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNairaCompact(n) {
  if (n == null || n === 0) return '';
  if (n >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return '₦' + (n / 1_000).toFixed(1) + 'k';
  return '₦' + Number(n).toFixed(0);
}

function heatColor(value, min, max) {
  if (value <= 0) return 'var(--color-bg)';
  const t = max > min ? (value - min) / (max - min) : 0.5;
  // Color gradient: cool blue (low) → teal → green (high)
  const r = Math.round(59 + (16 - 59) * t);    // 59 → 16
  const g = Math.round(130 + (185 - 130) * t);   // 130 → 185
  const b = Math.round(246 + (129 - 246) * t);   // 246 → 129
  return `rgb(${r},${g},${b})`;
}

function textColor(value, min, max) {
  if (value <= 0) return 'var(--color-ink-faint)';
  const t = max > min ? (value - min) / (max - min) : 0.5;
  return t > 0.45 ? '#fff' : 'var(--color-ink)';
}

const TRAJECTORY_STYLES = {
  Declining: { badge: 'text-red-700 bg-red-100', icon: '↓' },
  Growing: { badge: 'text-emerald-700 bg-emerald-100', icon: '↑' },
  Stable: { badge: 'text-blue-700 bg-blue-100', icon: '→' },
};

export default function ProductPerformanceWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Product Performance Over Time</p>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  const {
    products,
    months,
    monthLabels,
    globalMin,
    globalMax,
    losingMomentum,
    gainingMomentum,
    insight,
  } = result;

  if (!products || products.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Product Performance Over Time</p>
        <p className="text-xs text-amber-600 mt-1">No product performance data available.</p>
      </div>
    );
  }

  // Max column count for scrolling
  const needsScrollX = (months?.length || 0) > 8;

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {/* Title & Insight */}
      <div className="mb-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">
            {insight?.title || 'Product Performance Over Time'}
          </h3>
          <InfoBadge description={w.description} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)] leading-relaxed">
          {insight?.subtitle}
        </p>
      </div>

      {/* Momentum Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Products</p>
          <p className="text-sm font-bold text-[var(--color-ink)]">{products.length}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">{months?.length || 0} months tracked</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Losing Momentum</p>
          <p className="text-sm font-bold text-red-600">{losingMomentum?.length || 0}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">Needs attention</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Gaining</p>
          <p className="text-sm font-bold text-emerald-600">{gainingMomentum?.length || 0}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">Positive trend</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Stable</p>
          <p className="text-sm font-bold text-blue-600">{products.length - (losingMomentum?.length || 0) - (gainingMomentum?.length || 0)}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">Flat trajectory</p>
        </div>
      </div>

      {/* Momentum Alert — losing products */}
      {losingMomentum && losingMomentum.length > 0 && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3">
          <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-1">Declining Products</p>
          <div className="flex flex-wrap gap-2">
            {losingMomentum.map((p) => (
              <span key={p.name} className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                {p.name}
                <span className="font-mono opacity-70">({p.momentum > 0 ? '+' : ''}{p.momentum}%/mo)</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Heatmap */}
      <div className={needsScrollX ? 'overflow-x-auto' : ''}>
        <div style={{ minWidth: needsScrollX ? months.length * 80 + 180 : '100%' }}>
          {/* Column headers */}
          <div className="flex" style={{ paddingLeft: 164 }}>
            {monthLabels.map((label, i) => (
              <div
                key={label}
                className="flex-shrink-0 text-center"
                style={{ width: 72, marginRight: i < monthLabels.length - 1 ? 4 : 0 }}
              >
                <span className="text-[10px] font-semibold text-[var(--color-ink-faint)]">{label}</span>
              </div>
            ))}
          </div>

          {/* Product rows */}
          <div className="mt-1 space-y-1">
            {products.map((product) => (
              <div key={product.name} className="flex items-center group">
                {/* Product name + trajectory */}
                <div className="flex-shrink-0 flex items-center gap-2" style={{ width: 160 }}>
                  <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${TRAJECTORY_STYLES[product.trajectory]?.badge || 'text-gray-700 bg-gray-100'}`}>
                    {TRAJECTORY_STYLES[product.trajectory]?.icon || '→'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--color-ink)] truncate" title={product.name}>
                      {product.name}
                    </p>
                    <p className="text-[10px] text-[var(--color-ink-faint)] font-mono">
                      {formatNairaCompact(product.avgMonthly)}/mo
                    </p>
                  </div>
                </div>

                {/* Heatmap cells */}
                <div className="flex">
                  {product.values.map((val, i) => (
                    <div
                      key={months[i]}
                      className="flex-shrink-0 flex items-center justify-center rounded cursor-default"
                      style={{
                        width: 72,
                        height: 32,
                        marginRight: i < product.values.length - 1 ? 4 : 0,
                        backgroundColor: heatColor(val, globalMin, globalMax),
                        color: textColor(val, globalMin, globalMax),
                        fontSize: 10,
                        fontFamily: 'ui-monospace, monospace',
                        fontWeight: val > 0 ? 600 : 400,
                      }}
                      title={`${product.name} — ${monthLabels[i]}: ${formatNaira(val)}`}
                    >
                      {formatNairaCompact(val) || '—'}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Color legend */}
          <div className="flex items-center gap-2 mt-3" style={{ paddingLeft: 164 }}>
            <span className="text-[10px] text-[var(--color-ink-faint)]">Low</span>
            <div
              className="h-3 rounded-sm"
              style={{
                width: 120,
                background: `linear-gradient(to right, ${heatColor(globalMin, globalMin, globalMax)}, ${heatColor(globalMax, globalMin, globalMax)})`,
              }}
            />
            <span className="text-[10px] text-[var(--color-ink-faint)]">High</span>
          </div>
        </div>
      </div>

      {/* Business Decision */}
      <div className="mt-4 rounded-lg bg-[var(--color-primary-tint)] border border-[var(--color-primary)]/20 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-primary)] mb-1">
          Business Decision
        </p>
        <p className="text-sm text-[var(--color-ink)] leading-relaxed">
          {losingMomentum && losingMomentum.length > 0
            ? `Act on declining products now: review pricing against competitors, increase shelf visibility, bundle with fast movers, or run targeted promotions. If margin is healthy, a 10–15% price cut can often reverse a decline. For products that have been declining for 3+ months with low margins, consider phasing them out to free up shelf space and working capital for growth products.`
            : gainingMomentum && gainingMomentum.length === products.length
              ? `All tracked products are growing or stable — your product mix is healthy. Double down: increase stock depth on the fastest growers, negotiate better supplier terms with volume, and consider expanding into adjacent product lines that complement your top performers.`
              : `Most products are holding steady. Focus on turning stable products into growers: test small price adjustments, improve shelf placement, or bundle stable products with your top sellers. Even a modest uptick across your stable base compounds significantly over 6–12 months.`}
        </p>
      </div>
    </div>
  );
}
