import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import InfoBadge from './InfoBadge';

function formatNaira(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNairaK(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return '₦' + (n / 1_000).toFixed(1) + 'k';
  return '₦' + n;
}

const ForecastTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const actual = payload.find(p => p.dataKey === 'revenue' && p.value != null);
  const forecast = payload.find(p => p.dataKey === 'forecastRevenue' && p.value != null);
  const upper = payload.find(p => p.dataKey === 'forecastUpper');
  const lower = payload.find(p => p.dataKey === 'forecastLower');

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-white px-4 py-3 shadow-lg">
      <p className="text-xs font-semibold text-[var(--color-ink-faint)] mb-1">{label}</p>
      {actual && (
        <p className="font-mono text-sm font-bold text-[var(--color-primary)]">
          Actual {formatNaira(actual.value)}
        </p>
      )}
      {forecast && (
        <>
          <p className="font-mono text-sm font-bold text-[#f59e0b]">
            Forecast {formatNaira(forecast.value)}
          </p>
          {upper && lower && (
            <p className="text-[10px] text-[var(--color-ink-faint)] font-mono mt-0.5">
              Range: {formatNaira(lower.value)} – {formatNaira(upper.value)}
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default function RevenueForecastWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Revenue Forecast</p>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  const {
    chartData,
    forecast,
    avgMonthly,
    lastMonthRevenue,
    nextMonthForecast,
    pctChange,
    direction,
    rSquared,
    rmse,
    monthsOfData,
    insight,
  } = result;

  const hasForecast = forecast && forecast.length > 0 && nextMonthForecast > 0;
  const pctAbs = Math.abs(pctChange || 0);
  const pctColor = direction === 'grow' ? 'text-emerald-600' : 'text-red-600';

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {/* Title & Insight */}
      <div className="mb-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">
            {insight?.title || 'Revenue Forecast'}
          </h3>
          <InfoBadge description={w.description} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)] leading-relaxed">
          {insight?.subtitle}
        </p>
      </div>

      {/* R² confidence warning */}
      {rSquared != null && rSquared < 50 && (
        <div className="mb-4 border-l-2 border-amber-500 bg-amber-50/60 px-4 py-2">
          <p className="text-xs">
            <span className="font-bold text-amber-800">Low confidence forecast</span>
            <span className="text-amber-700"> — R² = {rSquared}% (use only as a rough guide)</span>
          </p>
        </div>
      )}

      {/* Forecast KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Next Month</p>
          <p className="text-sm font-bold font-mono text-[var(--color-ink)]">
            {hasForecast ? formatNaira(nextMonthForecast) : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Change</p>
          <p className={`text-sm font-bold font-mono ${pctColor}`}>
            {hasForecast ? `${direction === 'grow' ? '+' : ''}${pctChange}%` : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Monthly Avg</p>
          <p className="text-sm font-bold font-mono text-[var(--color-ink)]">
            {avgMonthly ? formatNaira(avgMonthly) : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Fit (R²)</p>
          <p className={`text-sm font-bold font-mono ${
            rSquared >= 70 ? 'text-emerald-600' :
            rSquared >= 40 ? 'text-amber-600' : 'text-red-600'
          }`}>
            {rSquared != null ? `${rSquared}%` : '—'}
          </p>
        </div>
      </div>

      {/* Forecast Chart */}
      {chartData && chartData.length > 0 ? (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }}
                interval={chartData.length > 24 ? Math.floor(chartData.length / 12) : 0}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }}
                tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'}
              />
              <Tooltip content={<ForecastTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />

              {/* Confidence band (shaded area) */}
              <Area
                type="monotone"
                dataKey="forecastUpper"
                stroke="none"
                fill="#f59e0b"
                fillOpacity={0.08}
                name="Upper bound"
                legendType="none"
              />
              <Area
                type="monotone"
                dataKey="forecastLower"
                stroke="none"
                fill="#f59e0b"
                fillOpacity={0.08}
                name="Lower bound"
                legendType="none"
              />

              {/* Historical revenue line */}
              <Line
                type="monotone"
                dataKey="revenue"
                name="Actual Revenue"
                stroke="var(--color-primary)"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--color-primary)', strokeWidth: 0 }}
                connectNulls={false}
              />

              {/* Forecast line (dashed, amber) */}
              <Line
                type="monotone"
                dataKey="forecastRevenue"
                name="Forecast"
                stroke="#f59e0b"
                strokeWidth={2.5}
                strokeDasharray="6 3"
                dot={{ r: 4, fill: '#f59e0b', stroke: '#fff', strokeWidth: 2 }}
                connectNulls={false}
              />

              {/* Divider line between historical and forecast */}
              {chartData.filter(d => !d.isForecast).length > 0 && (
                <ReferenceLine
                  x={chartData.filter(d => !d.isForecast).length - 1 + 0.5}
                  stroke="var(--color-ink-faint)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.3}
                  label={{
                    value: 'Today',
                    position: 'top',
                    fontSize: 10,
                    fill: 'var(--color-ink-faint)',
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-ink-faint)]">No forecast data available.</p>
      )}

      {/* Forecast detail table */}
      {hasForecast && (
        <div className="mt-4 pt-4 border-t border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">
            {forecast.length}-Month Projection
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs text-[var(--color-ink-faint)]">
                  <th className="py-2 pr-4 font-semibold">Month</th>
                  <th className="py-2 pr-4 font-semibold text-right">Forecast</th>
                  <th className="py-2 pr-4 font-semibold text-right">Low (80%)</th>
                  <th className="py-2 pr-4 font-semibold text-right">High (80%)</th>
                  <th className="py-2 font-semibold text-right">Range</th>
                </tr>
              </thead>
              <tbody>
                {forecast.map((f) => (
                  <tr key={f.month} className="border-b border-[var(--color-line)]/50">
                    <td className="py-2 pr-4 font-mono text-xs">{f.month}</td>
                    <td className="py-2 pr-4 font-mono text-right font-bold">{formatNaira(f.predicted)}</td>
                    <td className="py-2 pr-4 font-mono text-right text-[var(--color-ink-soft)]">{formatNaira(f.lower)}</td>
                    <td className="py-2 pr-4 font-mono text-right text-[var(--color-ink-soft)]">{formatNaira(f.upper)}</td>
                    <td className="py-2 font-mono text-right text-[var(--color-ink-soft)] text-xs">±{formatNaira(f.band)}</td>
                  </tr>
                ))}
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
          {hasForecast
            ? `Based on ${monthsOfData} months of history ${rSquared >= 70 ? 'with strong predictability' : rSquared >= 40 ? 'with moderate predictability' : 'with significant variability'}, next month's revenue is projected at ${formatNaira(nextMonthForecast)}. For purchasing: budget inventory at 70–80% of this forecast to stay conservative, and keep ${formatNaira(Math.round(rmse * 1.5))} in cash reserves to cover the 80% downside scenario. If revenue ${direction === 'grow' ? 'grows as projected' : 'declines'}, ${direction === 'grow' ? `reorder lead times should shorten to avoid stockouts on fast-moving items.` : `delay large restocks, negotiate extended payment terms with suppliers, and focus promotions on your top 5 revenue-driving products.`}`
            : `With fewer than 3 months of sales history, forecasting is unreliable. Focus on building a 6–12 month data baseline first. In the meantime, use the monthly average (₦${formatNaira(avgMonthly)}) from available data as a conservative purchasing guide.`}
        </p>
      </div>
    </div>
  );
}
