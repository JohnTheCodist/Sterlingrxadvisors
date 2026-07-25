import { useMemo } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ComposedChart,
} from 'recharts';
import InfoBadge from './InfoBadge';

const DONUT_COLORS = [
  'var(--color-primary)', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6', '#d1d5db',
];

function formatNaira(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNairaCompact(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return '₦' + (n / 1_000).toFixed(1) + 'k';
  return '₦' + Number(n).toFixed(0);
}

const DonutTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold text-[var(--color-ink)]">{d.name}</p>
      <p className="font-mono text-sm font-bold" style={{ color: d.color }}>
        {formatNaira(d.value)}
      </p>
      <p className="text-[10px] text-[var(--color-ink-faint)]">{d.share}% of total</p>
    </div>
  );
};

const ParetoTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold text-[var(--color-ink)] mb-0.5">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="font-mono text-xs font-bold" style={{ color: p.color }}>
          {p.name}: {p.name === 'Cumulative %' ? `${p.value}%` : formatNaira(p.value)}
        </p>
      ))}
    </div>
  );
};

export default function SalesConcentrationWidget({ widget }) {
  const w = widget;
  const result = w.result || {};

  if (result?.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 mb-4">
        <p className="text-sm font-medium text-amber-700">Sales Concentration Risk</p>
        <p className="text-xs text-amber-600 mt-1">{result.error}</p>
      </div>
    );
  }

  const {
    paretoData,
    donutData,
    totalRevenue,
    hhi,
    cr3,
    cr5,
    top1Share,
    riskLevel,
    productCount,
    insight,
  } = result;

  const riskColors = {
    High: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', badge: 'bg-red-100 text-red-700' },
    Moderate: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-700' },
    Low: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', badge: 'bg-emerald-100 text-emerald-700' },
  };
  const rc = riskColors[riskLevel] || riskColors.Moderate;

  // Build Pareto bar data (truncate product names)
  const paretoChartData = useMemo(() => {
    if (!paretoData) return [];
    return paretoData.slice(0, 15).map((p) => ({
      product: p.product.length > 14 ? p.product.slice(0, 13) + '…' : p.product,
      fullName: p.product,
      revenue: p.revenue,
      share: p.share,
      cumulative: p.cumulative,
    }));
  }, [paretoData]);

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {/* Title & Insight */}
      <div className="mb-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">
            {insight?.title || 'Sales Concentration Risk'}
          </h3>
          <InfoBadge description={w.description} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)] leading-relaxed">
          {insight?.subtitle}
        </p>
      </div>

      {/* Risk banner */}
      <div className={`mb-4 rounded-lg border ${rc.border} ${rc.bg} p-3`}>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${rc.badge}`}>
            {riskLevel} RISK
          </span>
          <div className="flex items-center gap-4 text-xs">
            <span className="font-mono text-[var(--color-ink)]">
              <span className="text-[var(--color-ink-faint)]">HHI: </span>
              <span className="font-semibold">{hhi}</span>
            </span>
            <span className="font-mono text-[var(--color-ink)]">
              <span className="text-[var(--color-ink-faint)]">CR3: </span>
              <span className="font-semibold">{cr3}%</span>
            </span>
            <span className="font-mono text-[var(--color-ink)]">
              <span className="text-[var(--color-ink-faint)]">CR5: </span>
              <span className="font-semibold">{cr5}%</span>
            </span>
            <span className="font-mono text-[var(--color-ink)]">
              <span className="text-[var(--color-ink-faint)]">Top 1: </span>
              <span className="font-semibold">{top1Share}%</span>
            </span>
          </div>
        </div>
      </div>

      {/* Risk KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Total Products</p>
          <p className="text-sm font-bold text-[var(--color-ink)]">{productCount}</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Top 3 Share</p>
          <p className={`text-sm font-bold ${cr3 >= 50 ? 'text-red-600' : cr3 >= 35 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {cr3}%
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Top 5 Share</p>
          <p className={`text-sm font-bold ${cr5 >= 70 ? 'text-red-600' : cr5 >= 50 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {cr5}%
          </p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">HHI Score</p>
          <p className={`text-sm font-bold ${hhi >= 2500 ? 'text-red-600' : hhi >= 1500 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {hhi}
          </p>
        </div>
      </div>

      {/* Dual Charts: Donut + Pareto */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2">
        {/* Donut */}
        <div>
          <p className="text-xs font-semibold text-[var(--color-ink-faint)] uppercase tracking-wider mb-2 text-center">
            Revenue Distribution
          </p>
          <div className="h-64">
            {donutData && donutData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                  >
                    {donutData.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<DonutTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)] text-center pt-20">No donut data.</p>
            )}
          </div>
        </div>

        {/* Pareto Bar + Cumulative Line */}
        <div>
          <p className="text-xs font-semibold text-[var(--color-ink-faint)] uppercase tracking-wider mb-2 text-center">
            Pareto Chart — Cumulative Revenue
          </p>
          <div className="h-64">
            {paretoChartData && paretoChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={paretoChartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                  <XAxis
                    dataKey="product"
                    tick={{ fontSize: 9, fill: 'var(--color-ink-faint)' }}
                    angle={-35}
                    textAnchor="end"
                    interval={0}
                    height={60}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }}
                    tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    domain={[0, 100]}
                    tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }}
                    tickFormatter={(v) => v + '%'}
                  />
                  <Tooltip content={<ParetoTooltip />} />
                  <Bar
                    yAxisId="left"
                    dataKey="revenue"
                    name="Revenue"
                    fill="var(--color-primary)"
                    fillOpacity={0.7}
                    radius={[2, 2, 0, 0]}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cumulative"
                    name="Cumulative %"
                    stroke="#ef4444"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#ef4444', strokeWidth: 0 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)] text-center pt-20">No Pareto data.</p>
            )}
          </div>
        </div>
      </div>

      {/* Top 10 detail table */}
      {paretoData && paretoData.length > 0 && (
        <div className="mt-4 pt-4 border-t border-[var(--color-line)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">
            Top Products by Revenue Share
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs text-[var(--color-ink-faint)]">
                  <th className="py-2 pr-4 font-semibold w-8">#</th>
                  <th className="py-2 pr-4 font-semibold">Product</th>
                  <th className="py-2 pr-4 font-semibold text-right">Revenue</th>
                  <th className="py-2 pr-4 font-semibold text-right">Share</th>
                  <th className="py-2 font-semibold text-right">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {paretoData.slice(0, 10).map((p, i) => (
                  <tr key={p.product} className="border-b border-[var(--color-line)]/50">
                    <td className="py-1.5 pr-4 font-mono text-xs text-[var(--color-ink-faint)]">{i + 1}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs text-[var(--color-ink)]">{p.product}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs text-right font-semibold">{formatNaira(p.revenue)}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs text-right">{p.share}%</td>
                    <td className="py-1.5 font-mono text-xs text-right text-[var(--color-ink-soft)]">{p.cumulative}%</td>
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
          {riskLevel === 'High'
            ? `Your business is dangerously concentrated. A supplier issue, regulatory change, or competitor price cut on your top product could wipe out ${cr3}% of revenue. Immediately: (1) invest marketing budget in growing products ranked 4-10, (2) explore complementary product lines, (3) negotiate volume-protection clauses with your top-3 suppliers. Target reducing CR3 below 50% within 2 quarters.`
            : riskLevel === 'Moderate'
              ? `Revenue is somewhat concentrated, but manageable. To reduce risk further: allocate 10-15% of procurement budget to growing mid-tier products, test 1-2 new product categories per quarter, and set a target to keep no single product above 20% of total revenue. Small improvements in diversification compound over time.`
              : `Your product portfolio is well balanced — no single product or small group dominates revenue. Maintain this discipline: track HHI quarterly, keep CR3 under 50%, and resist the temptation to over-index on your current best-seller. Growth should come from expanding the whole portfolio, not just the top performer.`}
        </p>
      </div>
    </div>
  );
}
