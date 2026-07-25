import { useMemo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ZAxis, ReferenceLine, Cell, Legend,
} from 'recharts';
import InfoBadge from './InfoBadge';

function formatNaira(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const SEVERITY_STYLES = {
  Critical: { fill: '#dc2626', stroke: '#991b1b', label: 'Critical' },
  High:     { fill: '#ea580c', stroke: '#c2410c', label: 'High' },
  Medium:   { fill: '#f59e0b', stroke: '#d97706', label: 'Medium' },
  Healthy:  { fill: '#10b981', stroke: '#059669', label: 'Healthy' },
};

const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const sev = SEVERITY_STYLES[d.severity] || SEVERITY_STYLES.Healthy;
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-white px-4 py-3 shadow-lg">
      <p className="text-xs font-semibold text-[var(--color-ink)]">{d.name}</p>
      <div className="mt-1.5 space-y-0.5">
        <p className="text-xs text-[var(--color-ink-soft)]">
          Revenue: <span className="font-mono font-bold text-[var(--color-ink)]">{formatNaira(d.revenue)}</span>
        </p>
        <p className="text-xs">
          Margin: <span className="font-mono font-bold" style={{ color: sev.fill }}>{d.margin?.toFixed(1)}%</span>
        </p>
        <p className="text-xs text-[var(--color-ink-soft)]">
          Gross Profit: <span className="font-mono">{formatNaira(d.grossProfit)}</span>
        </p>
        <p className="text-xs text-[var(--color-ink-soft)]">
          Qty: <span className="font-mono">{Number(d.quantity).toLocaleString('en-NG')}</span>
        </p>
      </div>
      <span
        className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
        style={{ backgroundColor: sev.fill }}
      >
        {sev.label}
      </span>
    </div>
  );
};

export default function ProfitLeakageWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  // Empty state: cost unavailable
  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-semibold text-amber-700">Where Is Profit Leaking?</p>
          <InfoBadge description={w.description} />
        </div>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  const {
    summary,
    chartData,
    products,
    insights,
    businessInterpretation,
    recommendedAction,
    expectedImpact,
    confidence,
    targetMargin,
    totalRevenue,
    totalGrossProfit,
    productsBelowCost,
    highRevLowMargin,
  } = result;

  // Split scatter data by severity for coloring
  const criticalPoints = useMemo(() => chartData?.filter(d => d.severity === 'Critical') || [], [chartData]);
  const highPoints = useMemo(() => chartData?.filter(d => d.severity === 'High') || [], [chartData]);
  const mediumPoints = useMemo(() => chartData?.filter(d => d.severity === 'Medium') || [], [chartData]);
  const healthyPoints = useMemo(() => chartData?.filter(d => d.severity === 'Healthy') || [], [chartData]);

  // Compute dynamic bubble size range based on revenue spread
  const maxRev = useMemo(() => {
    if (!chartData || chartData.length === 0) return 1;
    return Math.max(...chartData.map(d => d.revenue));
  }, [chartData]);

  // Compute theoretical max for X-axis domain to leave room
  const xMax = useMemo(() => maxRev * 1.15, [maxRev]);

  // Quadrant reference: revenue median for horizontal divider
  const revMedian = useMemo(() => {
    if (!chartData || chartData.length < 2) return 0;
    const sorted = [...chartData].sort((a, b) => a.revenue - b.revenue);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1].revenue + sorted[mid].revenue) / 2
      : sorted[mid].revenue;
  }, [chartData]);

  // Product table: leakage products (non-Healthy)
  const leakageProducts = useMemo(() => {
    if (!products) return [];
    return products
      .filter(p => p.severity !== 'Healthy' && p.hasCost)
      .sort((a, b) => {
        const order = { Critical: 0, High: 1, Medium: 2 };
        return (order[a.severity] ?? 99) - (order[b.severity] ?? 99);
      });
  }, [products]);

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {/* Title & Subtitle */}
      <div className="mb-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">
            Where Is Profit Leaking?
          </h3>
          <InfoBadge description={w.description} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)] leading-relaxed">
          Identify products generating sales but failing to generate healthy profits.
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">
            Products Below {targetMargin}% Margin
          </p>
          <p className={`text-sm font-bold ${(summary?.productsBelowTarget || 0) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
            {summary?.productsBelowTarget ?? '—'}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">
            Estimated Annual Profit Opportunity
          </p>
          <p className="text-sm font-bold font-mono text-emerald-600">
            {summary?.estimatedOpportunity > 0 ? formatNaira(summary.estimatedOpportunity) : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">
            Average Gross Margin
          </p>
          <p className={`text-sm font-bold font-mono ${
            (summary?.averageMargin || 0) >= targetMargin ? 'text-emerald-600' :
            (summary?.averageMargin || 0) >= (targetMargin * 0.6) ? 'text-amber-600' : 'text-red-600'
          }`}>
            {summary?.averageMargin != null ? `${summary.averageMargin}%` : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">
            Highest Leakage Product
          </p>
          <p className="text-sm font-bold text-[var(--color-ink)] truncate" title={summary?.highestLeakageProduct}>
            {summary?.highestLeakageProduct || 'None'}
          </p>
        </div>
      </div>

      {/* Deterministic Insights */}
      {insights && insights.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">Evidence-Based Insights</p>
          <ul className="space-y-1.5">
            {insights.map((insight, i) => (
              <li key={i} className="flex gap-2 text-sm text-[var(--color-ink)] leading-relaxed">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-primary)]" />
                {insight}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Critical alert for below-cost products */}
      {productsBelowCost && productsBelowCost.length > 0 && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3">
          <p className="text-xs font-bold text-red-700 uppercase tracking-wider mb-1">
            Critical: Products Sold Below Cost
          </p>
          <div className="flex flex-wrap gap-2">
            {productsBelowCost.map(p => (
              <span key={p.product} className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                {p.product}
                <span className="font-mono opacity-70">({formatNaira(Math.abs(p.grossProfit))} loss)</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Scatter Plot: Revenue vs Margin %} */}
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">
        Revenue vs Gross Margin — Profit Leakage Map
      </p>
      <div className="h-96 relative">
        {chartData && chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />

              {/* X axis: Revenue */}
              <XAxis
                type="number"
                dataKey="revenue"
                name="Revenue"
                domain={[0, xMax]}
                tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }}
                tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'}
                label={{ value: 'Revenue →', position: 'bottom', offset: -5, fontSize: 11, fill: 'var(--color-ink-faint)' }}
              />

              {/* Y axis: Gross Margin % */}
              <YAxis
                type="number"
                dataKey="margin"
                name="Margin %"
                domain={[-10, 'auto']}
                tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }}
                tickFormatter={(v) => v + '%'}
                label={{ value: 'Gross Margin % →', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: 'var(--color-ink-faint)' }}
              />

              {/* Bubble size proportional to gross profit */}
              <ZAxis
                type="number"
                dataKey="grossProfit"
                range={[30, Math.min(800, Math.max(60, maxRev / 200))]}
                name="Gross Profit"
              />

              <Tooltip content={<ScatterTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />

              {/* Target margin reference line */}
              <ReferenceLine
                y={targetMargin}
                stroke="#f59e0b"
                strokeDasharray="6 3"
                strokeOpacity={0.6}
                label={{
                  value: `Target ${targetMargin}%`,
                  position: 'right',
                  fontSize: 10,
                  fill: '#f59e0b',
                }}
              />

              {/* Revenue median divider (quadrant separator) */}
              {revMedian > 0 && (
                <ReferenceLine
                  x={revMedian}
                  stroke="var(--color-ink-faint)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.2}
                />
              )}

              {/* Critical — sold below cost (red) */}
              {criticalPoints.length > 0 && (
                <Scatter name="Critical (Below Cost)" data={criticalPoints} fill={SEVERITY_STYLES.Critical.fill}>
                  {criticalPoints.map((_, i) => (
                    <Cell key={`c-${i}`} fill={SEVERITY_STYLES.Critical.fill} stroke={SEVERITY_STYLES.Critical.stroke} strokeWidth={1} />
                  ))}
                </Scatter>
              )}

              {/* High — high revenue, low margin (orange) */}
              {highPoints.length > 0 && (
                <Scatter name="High Leakage" data={highPoints} fill={SEVERITY_STYLES.High.fill}>
                  {highPoints.map((_, i) => (
                    <Cell key={`h-${i}`} fill={SEVERITY_STYLES.High.fill} stroke={SEVERITY_STYLES.High.stroke} strokeWidth={1} />
                  ))}
                </Scatter>
              )}

              {/* Medium — low contribution (amber) */}
              {mediumPoints.length > 0 && (
                <Scatter name="Medium Concern" data={mediumPoints} fill={SEVERITY_STYLES.Medium.fill}>
                  {mediumPoints.map((_, i) => (
                    <Cell key={`m-${i}`} fill={SEVERITY_STYLES.Medium.fill} stroke={SEVERITY_STYLES.Medium.stroke} strokeWidth={1} />
                  ))}
                </Scatter>
              )}

              {/* Healthy (green) */}
              {healthyPoints.length > 0 && (
                <Scatter name="Healthy" data={healthyPoints} fill={SEVERITY_STYLES.Healthy.fill}>
                  {healthyPoints.map((_, i) => (
                    <Cell key={`g-${i}`} fill={SEVERITY_STYLES.Healthy.fill} stroke={SEVERITY_STYLES.Healthy.stroke} strokeWidth={1} />
                  ))}
                </Scatter>
              )}
            </ScatterChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-[var(--color-ink-faint)] absolute inset-0 flex items-center justify-center">
            No chart data available — cost data is required for margin analysis.
          </p>
        )}
      </div>

      {/* Quadrant legend */}
      <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-[var(--color-ink-faint)]">
        <div className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm bg-emerald-200 border border-emerald-400" />
          Top-Right: Best Performers (High Revenue, High Margin)
        </div>
        <div className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm bg-red-200 border border-red-400" />
          Bottom-Right: Highest Leakage (High Revenue, Low Margin)
        </div>
        <div className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm bg-blue-200 border border-blue-400" />
          Top-Left: Niche Opportunities (Low Revenue, High Margin)
        </div>
        <div className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-sm bg-gray-100 border border-gray-300" />
          Bottom-Left: Lowest Priority (Low Revenue, Low Margin)
        </div>
      </div>

      {/* Business Interpretation + Action + Impact */}
      <div className="mt-4 space-y-3">
        {/* Business Interpretation */}
        <div className="rounded-lg bg-orange-50 border border-orange-200 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-orange-700 mb-1">
            Business Interpretation
          </p>
          <p className="text-sm text-[var(--color-ink)] leading-relaxed">
            {businessInterpretation}
          </p>
        </div>

        {/* Recommended Action */}
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-700 mb-1">
            Recommended Action
          </p>
          <p className="text-sm text-[var(--color-ink)] leading-relaxed">
            {recommendedAction}
          </p>
        </div>

        {/* Expected Impact */}
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700 mb-1">
            Expected Business Impact
          </p>
          <p className="text-sm text-[var(--color-ink)] leading-relaxed">
            {expectedImpact}
          </p>
        </div>
      </div>

      {/* Leakage Product Detail Table */}
      {leakageProducts.length > 0 && (
        <div className="mt-4 pt-4 border-t border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">
            Products Requiring Attention
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs text-[var(--color-ink-faint)]">
                  <th className="py-2 pr-3 font-semibold">Product</th>
                  <th className="py-2 pr-3 font-semibold text-right">Severity</th>
                  <th className="py-2 pr-3 font-semibold text-right">Revenue</th>
                  <th className="py-2 pr-3 font-semibold text-right">Margin</th>
                  <th className="py-2 pr-3 font-semibold text-right">Gross Profit</th>
                  <th className="py-2 pr-3 font-semibold text-right">Qty</th>
                  <th className="py-2 font-semibold">Rules Triggered</th>
                </tr>
              </thead>
              <tbody>
                {leakageProducts.map((p) => {
                  const sev = SEVERITY_STYLES[p.severity] || SEVERITY_STYLES.Healthy;
                  return (
                    <tr key={p.product} className="border-b border-[var(--color-line)]/50">
                      <td className="py-1.5 pr-3 font-mono text-xs text-[var(--color-ink)]">{p.product}</td>
                      <td className="py-1.5 pr-3 text-right">
                        <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: sev.fill }}>
                          {p.severity}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-right">{formatNaira(p.revenue)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-right font-semibold" style={{ color: sev.fill }}>
                        {p.grossMargin != null ? `${p.grossMargin}%` : '—'}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-right">{formatNaira(p.grossProfit)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-right">{Number(p.quantity).toLocaleString('en-NG')}</td>
                      <td className="py-1.5 font-mono text-[10px] text-[var(--color-ink-soft)]">
                        {p.rules?.join(' · ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Business Decision */}
      <div className="mt-4 rounded-lg bg-[var(--color-primary-tint)] border border-[var(--color-primary)]/20 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-primary)] mb-1">
          Business Decision
        </p>
        <p className="text-sm text-[var(--color-ink)] leading-relaxed">
          {productsBelowCost && productsBelowCost.length > 0
            ? `Stop the bleeding on products sold below cost immediately — every unit sold at a loss directly erodes cash flow. Verify cost data accuracy, then either correct pricing or discontinue. For high-revenue, low-margin products (${highRevLowMargin?.length || 0} flagged), a ${targetMargin - (summary?.averageMargin || 0)} percentage-point margin improvement through small price adjustments or cost renegotiation would generate approximately ${formatNaira(summary?.estimatedOpportunity || 0)} in additional profit.`
            : (summary?.productsBelowTarget || 0) > 0
              ? `${summary?.productsBelowTarget} products are below your ${targetMargin}% margin target. The highest-impact move: review the top ${Math.min(3, highRevLowMargin?.length || 0)} revenue products below target first — they account for the largest share of the ₦${Math.round(summary?.estimatedOpportunity || 0).toLocaleString('en-NG')} opportunity. Even a modest 3–5% price increase on these products would meaningfully improve gross profit.`
              : 'All products are performing at or above target margin. Maintain pricing discipline, review quarterly, and re-invest profit from high-margin products into growing the product range.'}
        </p>
      </div>
    </div>
  );
}
