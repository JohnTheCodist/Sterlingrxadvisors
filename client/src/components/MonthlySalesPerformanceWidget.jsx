import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceDot } from 'recharts';
import InfoBadge from './InfoBadge';
import { makeDateFormatter } from '../utils/dateFormat';
import { revenueGap } from '../utils/metrics';

const GRANULARITY_LABELS = { month: 'Month', week: 'Week', day: 'Day' };

function MonthlySalesPerformanceWidget({ widget, totalRevenue }) {
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

  const {
    trend,
    title,
    subtitle,
    businessInterpretation,
    decisionSupport,
    chartType
  } = result;

  // Prepare chart data — active drill level if present, else the primary series
  const activeLevelData = levels && drillLevels[activeLevel] ? drillLevels[activeLevel] : null;
  const chartData = activeLevelData || result.series?.[0]?.data || [];
  const { gap: unknownRevenue, direction: gapDir } = revenueGap({ totalRevenue, monthlyRevenue: chartData });
  const hasUnknown = unknownRevenue > 1 && gapDir === '+' && chartData.length > 0;
  const chartDataWithUnknown = hasUnknown
    ? [...chartData, { name: 'Unknown', revenue: unknownRevenue, isUnknown: true }]
    : chartData;
  const unknownIndex = hasUnknown ? chartDataWithUnknown.length - 1 : -1;
  const { tickFormatter: formatMonthDate } = makeDateFormatter(chartData, 'name');

  // Derive highest/lowest/average from whichever level is active so the
  // summary cards always match what's charted, not just the server's
  // primary-level defaults.
  const highestMonth = chartData.reduce((best, d) => (!best || d.revenue > best.revenue ? d : best), null) || { name: '—', revenue: 0 };
  const lowestMonth = chartData.reduce((worst, d) => (!worst || d.revenue < worst.revenue ? d : worst), null) || { name: '—', revenue: 0 };
  const averageMonthlyRevenue = chartData.length > 0
    ? Math.round(chartData.reduce((s, d) => s + (d.revenue || 0), 0) / chartData.length)
    : 0;
  const periodNoun = activeLevel === 'week' ? 'weeks' : activeLevel === 'day' ? 'days' : 'months';
  const periodLabelCap = activeLevel === 'week' ? 'Weekly' : activeLevel === 'day' ? 'Daily' : 'Monthly';

  // Find indices
  const highestIndex = chartData.findIndex(d => d.revenue === highestMonth.revenue);
  const lowestIndex = chartData.findIndex(d => d.revenue === lowestMonth.revenue);

  // Dot colors
  const highlightDot = '#10b981'; // emerald
  const lowDot = '#ef4444'; // red
  const mutedDot = '#9ca3af'; // gray
  const mutedStroke = '#e5e7eb';

  // Format currency
  const formatCurrency = (val) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(val);

  // Trend color
  const trendColor = trend === 'Growing' ? 'text-emerald-600' : trend === 'Declining' ? 'text-red-600' : 'text-amber-600';
  const trendBg = trend === 'Growing' ? 'bg-emerald-100' : trend === 'Declining' ? 'bg-red-100' : 'bg-amber-100';

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {/* Title & Subtitle */}
      <div className="mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <h3 className="text-base font-semibold text-[var(--color-ink)] mb-1">{w.title}</h3>
            <InfoBadge description={w.description} />
          </div>
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
        </div>
        <p className="text-xs text-[var(--color-ink-faint)]">{subtitle}</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {/* Highest period */}
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Highest {GRANULARITY_LABELS[activeLevel] || 'Month'}</p>
          <p className="text-sm font-bold text-[var(--color-ink)]">{highestMonth.name}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">{formatCurrency(highestMonth.revenue)}</p>
        </div>

        {/* Lowest period */}
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Lowest {GRANULARITY_LABELS[activeLevel] || 'Month'}</p>
          <p className="text-sm font-bold text-[var(--color-ink)]">{lowestMonth.name}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">{formatCurrency(lowestMonth.revenue)}</p>
        </div>

        {/* Average */}
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Average {periodLabelCap}</p>
          <p className="text-sm font-bold text-[var(--color-ink)]">{formatCurrency(averageMonthlyRevenue)}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">{chartData.length} {periodNoun}</p>
        </div>

        {/* Trend */}
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">Current Trend</p>
          <div className={`flex h-8 w-8 items-center justify-center rounded-full ${trendBg}`}>
            <span className={`text-sm font-bold ${trendColor}`}>
              {trend === 'Growing' ? '↑' : trend === 'Declining' ? '↓' : '—'}
            </span>
          </div>
          <p className={`text-xs font-semibold mt-2 ${trendColor}`}>{trend}</p>
        </div>
      </div>

      {/* Chart */}
      <div className="mb-4">
        <div className="flex items-center justify-end mb-2">
          <button
            onClick={() => document.getElementById('explain-btn').classList.toggle('hidden')}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-primary-2)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            Explain
          </button>
        </div>

        {/* Unattributed revenue note */}
        {hasUnknown && (
          <div className="mb-3 border-l-2 border-gray-300 bg-gray-50/60 px-3 py-1.5 text-xs">
            <span className="font-semibold text-gray-600">Unattributed: </span>
            <span className="text-gray-500 font-mono">{formatCurrency(unknownRevenue)}</span>
            <span className="text-gray-400"> — {Math.round((unknownRevenue / totalRevenue) * 100)}% of total (unparseable dates)</span>
          </div>
        )}

        <div className="h-64 rounded-lg border border-[var(--color-line)] p-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartDataWithUnknown} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={mutedStroke} opacity={0.3} vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} axisLine={false} tickLine={false} tickFormatter={formatMonthDate} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} axisLine={false} tickLine={false} tickFormatter={formatCurrency} />
              <Tooltip
                cursor={{ fill: 'var(--color-bg-hover)' }}
                contentStyle={{
                  borderRadius: 8,
                  border: 'none',
                  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                }}
                formatter={(value) => [formatCurrency(value), 'Revenue']}
                labelStyle={{ fontSize: 11, fill: 'var(--color-ink)', fontWeight: 600 }}
              />
              <Bar
                dataKey="revenue"
                radius={[4, 4, 0, 0]}
                activeBar={{ fill: 'var(--color-primary)', radius: [4, 4, 0, 0] }}
              >
                {chartDataWithUnknown.map((entry, index) => {
                  if (entry.isUnknown) {
                    return <Cell key={`bar-${index}`} fill="#f3f4f6" stroke="#9ca3af" strokeWidth={1} strokeDasharray="3 2" />;
                  }
                  let fill;
                  if (highestIndex >= 0 && index === highestIndex) {
                    fill = highlightDot;
                  } else if (lowestIndex >= 0 && index === lowestIndex) {
                    fill = lowDot;
                  } else {
                    fill = mutedDot;
                  }
                  return <Cell key={`bar-${index}`} fill={fill} stroke={mutedStroke} />;
                })}
              </Bar>
              <ReferenceDot x={highestIndex} y={highestMonth.revenue} r={4} fill={highlightDot} stroke="#fff" strokeWidth={0} />
              <ReferenceDot x={lowestIndex} y={lowestMonth.revenue} r={4} fill={lowDot} stroke="#fff" strokeWidth={0} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Business Interpretation */}
      <div className="mb-4">
        <p className="text-sm font-medium text-[var(--color-ink)] mb-1">Business Interpretation</p>
        <p className="text-sm text-[var(--color-ink-soft)] leading-relaxed">{businessInterpretation}</p>
      </div>

      {/* Decision Support */}
      <div className="rounded-lg bg-[var(--color-primary-bg)] border border-[var(--color-primary)] border-l-4 border-l-[var(--color-primary)] p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Actionable Recommendation</p>
        <p className="text-sm text-[var(--color-ink)] leading-relaxed">{decisionSupport}</p>
      </div>

      {/* Explanation Modal */}
      <div id="explain-btn" className="hidden mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
        <p className="text-xs text-[var(--color-ink-faint)] mb-1">Why This Matters</p>
        <p className="text-xs text-[var(--color-ink-soft)]">
          Identify your strongest and weakest trading months to improve inventory planning and cash-flow forecasting.
          This helps you prepare for seasonal demand and allocate stock more effectively throughout the year.
        </p>
      </div>
    </div>
  );
}

export default MonthlySalesPerformanceWidget;
