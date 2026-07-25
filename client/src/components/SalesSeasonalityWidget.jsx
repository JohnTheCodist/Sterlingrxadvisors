import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ReferenceLine,
} from 'recharts';
import InfoBadge from './InfoBadge';

const YEAR_COLORS = [
  'var(--color-primary)', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
];

function formatNaira(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const SeasonalityTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-white px-4 py-3 shadow-lg">
      <p className="text-xs font-semibold text-[var(--color-ink-faint)] mb-1">{label}</p>
      {payload
        .filter((p) => p.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((p, i) => (
          <p key={i} className="font-mono text-sm font-bold" style={{ color: p.color }}>
            <span className="font-normal text-xs mr-1.5 opacity-70">{p.name}</span>
            {formatNaira(p.value)}
          </p>
        ))}
    </div>
  );
};

export default function SalesSeasonalityWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Sales Seasonality</p>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  const {
    chartData,
    categories,
    years,
    seasonalityIndex,
    peakMonth,
    troughMonth,
    patternType,
    patternSubtitle,
    peakRatio,
    overallMonthlyAvg,
    insight,
  } = result;

  const hasData = chartData && chartData.length > 0 && categories && categories.length > 0;

  // Compute average line across all years
  const avgLine = useMemo(() => {
    if (!chartData || !categories || categories.length === 0) return null;
    return chartData.map((point) => {
      let sum = 0;
      let count = 0;
      for (const year of categories) {
        const v = point[year];
        if (v > 0) { sum += v; count++; }
      }
      return { month: point.month, avg: count > 0 ? Math.round(sum / count) : 0 };
    });
  }, [chartData, categories]);

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {/* Title & Insight */}
      <div className="mb-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">
            {insight?.title || 'Sales Seasonality'}
          </h3>
          <InfoBadge description={w.description} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)] leading-relaxed">
          {insight?.subtitle || patternSubtitle}
        </p>
      </div>

      {/* Seasonality Score Cards */}
      {peakMonth && troughMonth && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Pattern</p>
            <p className={`text-sm font-bold ${
              patternType === 'Highly Seasonal' ? 'text-amber-600' :
              patternType === 'Moderately Seasonal' ? 'text-blue-600' :
              'text-emerald-600'
            }`}>{patternType}</p>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Peak Month</p>
            <p className="text-sm font-bold text-[var(--color-ink)]">{peakMonth.month}</p>
            <p className="text-xs text-[var(--color-ink-soft)]">{peakMonth.index}% of avg</p>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Trough Month</p>
            <p className="text-sm font-bold text-[var(--color-ink)]">{troughMonth.month}</p>
            <p className="text-xs text-[var(--color-ink-soft)]">{troughMonth.index}% of avg</p>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Peak/Trough Ratio</p>
            <p className="text-sm font-bold text-[var(--color-ink)]">{peakRatio}x</p>
            <p className="text-xs text-[var(--color-ink-soft)]">{years?.length || 0} years analysed</p>
          </div>
        </div>
      )}

      {/* Multi-Year Overlay Line Chart */}
      {hasData ? (
        <div className="h-80 mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }}
                tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'}
              />
              <Tooltip content={<SeasonalityTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              />
              {/* Average line (dashed) — shown when 2+ years */}
              {categories.length >= 2 && avgLine && avgLine.some(d => d.avg > 0) && (
                <Line
                  type="monotone"
                  data={avgLine}
                  dataKey="avg"
                  name="Average"
                  stroke="var(--color-ink-faint)"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  legendType="none"
                />
              )}
              {/* Individual year lines */}
              {categories.map((year, i) => (
                <Line
                  key={year}
                  type="monotone"
                  dataKey={year}
                  name={year}
                  stroke={YEAR_COLORS[i % YEAR_COLORS.length]}
                  strokeWidth={i === categories.length - 1 ? 2.5 : 1.5}
                  dot={{ r: 3, strokeWidth: 0 }}
                  activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                  connectNulls={false}
                />
              ))}
              {/* Reference line at overall monthly average */}
              {overallMonthlyAvg > 0 && (
                <ReferenceLine
                  y={overallMonthlyAvg}
                  stroke="var(--color-ink-faint)"
                  strokeDasharray="4 4"
                  strokeOpacity={0.4}
                  label={{
                    value: 'Avg',
                    position: 'right',
                    fontSize: 10,
                    fill: 'var(--color-ink-faint)',
                  }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-ink-faint)]">No seasonality data available.</p>
      )}

      {/* Seasonality Index Bars */}
      {seasonalityIndex && seasonalityIndex.length > 0 && (
        <div className="mt-4 pt-4 border-t border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-3">
            Seasonality Index — Monthly Performance vs. Average (100 = average month)
          </p>
          <div className="space-y-1.5">
            {seasonalityIndex.map((s) => (
              <div key={s.monthKey} className="flex items-center gap-2">
                <span className="w-8 text-right text-[11px] font-mono text-[var(--color-ink-faint)]">
                  {s.month}
                </span>
                <div className="flex-1 h-5 rounded-sm bg-[var(--color-bg)] relative overflow-hidden">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-sm transition-all ${
                      s.index >= 120 ? 'bg-emerald-500' :
                      s.index >= 105 ? 'bg-emerald-300' :
                      s.index >= 95 ? 'bg-[var(--color-line)]' :
                      s.index >= 80 ? 'bg-amber-300' :
                      s.index > 0 ? 'bg-red-300' : 'bg-transparent'
                    }`}
                    style={{ width: `${Math.min(s.index, 200)}%` }}
                  />
                  {/* 100% reference marker */}
                  <div
                    className="absolute inset-y-0 border-r border-dashed border-[var(--color-ink-faint)] opacity-30"
                    style={{ left: '100%' }}
                  />
                </div>
                <span className={`w-12 text-right text-[11px] font-mono font-semibold ${
                  s.index >= 110 ? 'text-emerald-600' :
                  s.index <= 90 && s.index > 0 ? 'text-red-600' :
                  'text-[var(--color-ink-soft)]'
                }`}>
                  {s.index > 0 ? `${s.index}%` : '—'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-ink-faint)]">
            Values above 100% indicate months that outperform the overall monthly average.
            The dashed vertical line is the baseline (100% = an average month).
          </p>
        </div>
      )}

      {/* Business Decision */}
      <div className="mt-4 rounded-lg bg-[var(--color-primary-tint)] border border-[var(--color-primary)]/20 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-primary)] mb-1">
          Business Decision
        </p>
        <p className="text-sm text-[var(--color-ink)] leading-relaxed">
          {patternType === 'Highly Seasonal'
            ? `Demand is highly predictable by calendar. Stock up 4–6 weeks before ${peakMonth?.month}, run promotions during ${troughMonth?.month} to smooth the curve, and align staffing rotas with seasonal peaks. Use the slower months for training, stock-taking, and supplier negotiations.`
            : patternType === 'Moderately Seasonal'
              ? `Plan inventory 3–4 weeks ahead of ${peakMonth?.month}. Consider modest promotions in ${troughMonth?.month} to level out demand. The seasonal pattern is clear enough to act on, but not extreme enough to require major capital reallocation.`
              : patternType === 'Insufficient History'
                ? 'Collect at least 12–24 months of sales data before making seasonal inventory decisions. With only a single year of data, seasonal patterns cannot be distinguished from one-off events.'
                : 'Demand is consistent month-to-month. Prioritize growing the overall revenue baseline rather than seasonal preparation. Focus your energy on customer acquisition and basket size improvement year-round.'}
        </p>
      </div>
    </div>
  );
}
