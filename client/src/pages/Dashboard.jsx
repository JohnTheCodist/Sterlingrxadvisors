import { useState, useEffect, useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, ReferenceDot, ComposedChart, ReferenceLine, Treemap,
  AreaChart, Area, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import LoadingState from '../components/LoadingState';
import GrowthRateWidget from '../components/GrowthRateWidget';
import MonthlySalesPerformanceWidget from '../components/MonthlySalesPerformanceWidget';
import { pickTotalRevenue, avgTransactionValue, topConcentration, revenueGap, monthlyRevenueWithGap as augmentMonthly, validateMetricConsistency } from '../utils/metrics';
import SalesSeasonalityWidget from '../components/SalesSeasonalityWidget';
import ProductPerformanceWidget from '../components/ProductPerformanceWidget';
import RevenueForecastWidget from '../components/RevenueForecastWidget';
import SalesConcentrationWidget from '../components/SalesConcentrationWidget';
import ProfitLeakageWidget from '../components/ProfitLeakageWidget';
import InfoBadge from '../components/InfoBadge';
import KpiCard from '../components/KpiCard';
import { makeDateFormatter } from '../utils/dateFormat';
import { formatNaira, formatNairaDec, formatNumber, formatPercent } from '../utils/format';
import DatasetSummary from '../components/overview/DatasetSummary';
import SettingsPanel from '../components/SettingsPanel';
import DynamicKpiGrid from '../components/overview/DynamicKpiGrid';
import BusinessHealthCard from '../components/overview/BusinessHealthCard';
import ExecutiveBrief from '../components/overview/ExecutiveBrief';
import TopPriorities from '../components/overview/TopPriorities';
import AlertsPanel from '../components/overview/AlertsPanel';
import AdvisorChat from '../components/overview/AdvisorChat';
import BulletChart from '../components/BulletChart.jsx';
import ExecutiveNote from '../components/ExecutiveNote.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { apiFetch } from '../lib/apiClient.js';
import ProductTour, { hasSeenTour } from '../components/ProductTour.jsx';

// Widget ids (from server/services/widgetRegistry.js) that are product-centric
// within the 'sales' dashboard category — used to give the "Products" nav tab
// a focused view without inventing a new backend category.
const PRODUCT_WIDGET_IDS = new Set([
  'top-products', 'top-revenue-products', 'top-volume-products',
  'product-revenue-concentration', 'product-mix-analysis', 'gross-profit-by-product',
  'gross-margin-analysis', 'best-worst-products', 'revenue-by-category', 'category-growth',
  'product-performance-over-time', 'sales-concentration-risk', 'profit-leakage',
]);

/**
 * The walkthrough shown once on a first visit.
 *
 * One list serves both the empty dashboard and a populated one: ProductTour
 * drops any step whose target isn't on the page, so a brand-new account (which
 * renders the empty state and has no nav or KPI cards yet) sees only the
 * upload step, while someone returning after their first upload gets the full
 * tour. Keeping one list means the two can't drift apart.
 *
 * Copy rule: say what the thing DOES, not that it exists. "Your numbers live
 * here" tells a pharmacist nothing they can't see.
 */
const TOUR_STEPS = [
  {
    selector: '[data-tour="empty-upload"]',
    title: 'Start with a spreadsheet',
    body: 'Upload a sales or stock export — Excel or CSV, straight from your till or supplier. '
      + 'We read the columns for you, so there is nothing to reformat first.',
  },
  {
    selector: '[data-tour="kpis"]',
    title: 'Your headline numbers',
    body: 'Revenue, transactions, basket size and margin for the file you last uploaded — '
      + 'not everything you have ever uploaded, so these always describe one period you can reason about.',
  },
  {
    selector: '[data-tour="health"]',
    title: 'Where the business stands',
    body: 'One score out of 100, built from five pillars. Open it to see which pillar is pulling the '
      + 'score down and exactly which number caused it.',
  },
  {
    selector: '[data-tour="nav-inventory"]',
    title: 'Stock, expiry and suppliers',
    body: 'Each section answers a different question — what is expiring, what is overstocked, which '
      + 'supplier you depend on most. Sections stay empty until you upload a file that carries those columns.',
  },
  {
    selector: '[data-tour="nav-advisor"]',
    title: 'Ask instead of hunting',
    body: 'Type a question in plain English — "what should I reorder this week?" — and it answers from '
      + 'your own uploaded numbers, showing the figures it used.',
  },
  {
    selector: '[data-tour="upload"]',
    title: 'Adding more data later',
    body: 'Every upload adds to your history. Re-uploading the same file replaces it rather than '
      + 'counting it twice, so you can safely send a corrected export.',
  },
  {
    selector: '[data-tour="export"]',
    title: 'Take it off the screen',
    body: 'Export the dashboard as a PDF report — headline figures, health score, priorities and '
      + 'top products — for a meeting, your accountant or your own records.',
  },
  {
    selector: '[data-tour="nav-settings"]',
    title: 'One setting worth checking',
    body: 'Your state drives the weather and disease signals. You set it at signup; change it here if '
      + 'you move or picked the wrong one.',
  },
];

// Sidebar nav tab -> widget-manifest dashboardKey(s) it drills into.
const NAV_DASHBOARD_KEYS = {
  performance: ['sales'],
  products: ['sales'],
  inventory: ['inventory', 'expiry'],
  customers: ['customer'],
  suppliers: ['supplier'],
};

function toRecharts(seriesArr) {
  if (!seriesArr || seriesArr.length === 0) return [];
  const s = seriesArr[0];
  return (s.data || []).map(d => ({ label: d.x || d.label || '', value: d.y || d.value || 0 }));
}

// ---- sidebar navigation icons (inline SVG) ------------------------------
const gridIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
const trendingIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>';
const revenueIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
const growthIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>';
const packageIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/></svg>';
const tagIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>';
const dollarIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
const boxIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
const clockIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const usersIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const truckIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-4.17a1 1 0 0 0-.3-.7l-1.82-1.83A1 1 0 0 0 19.16 10H15v7a1 1 0 0 0 1 1h3Z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>';
const sparklesIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';
const fileIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>';
const settingsIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
const helpIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';

const COLORS = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--destructive)', '#8b5cf6', '#06b6d4', '#f97316'];

function SeverityBadge({ severity }) {
  const map = {
    critical: { bg: 'bg-destructive/10', text: 'text-destructive', label: 'Critical' },
    warning: { bg: 'bg-warning/10', text: 'text-warning', label: 'Warning' },
    positive: { bg: 'bg-success/10', text: 'text-success', label: 'Positive' },
    info: { bg: 'bg-primary/10', text: 'text-primary', label: 'Info' },
  };
  const s = map[severity] || map.info;
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function InsightCard({ insight }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] overflow-hidden">
      <div className="px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <SeverityBadge severity={insight.severity} />
              <span className="text-[11px] font-mono text-[var(--color-ink-faint)]">
                {Math.round(insight.confidence * 100)}% confidence
              </span>
            </div>
            <h3 className="text-sm font-semibold text-[var(--color-ink)] leading-snug">
              {insight.title}
            </h3>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 rounded-lg p-1.5 text-[var(--color-ink-faint)] hover:bg-[var(--color-bg-alt)] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>

        <p className="mt-2 text-sm text-[var(--color-ink-soft)] leading-relaxed">{insight.insight}</p>

        {expanded && (
          <div className="mt-4 space-y-3 border-t border-[var(--color-line)] pt-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">So What?</p>
              <p className="text-sm text-[var(--color-ink-soft)] leading-relaxed">{insight.soWhat}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Recommendation</p>
              <p className="text-sm text-[var(--color-ink)] leading-relaxed whitespace-pre-line">{insight.recommendation}</p>
            </div>
            {insight.expectedImpact && (
              <div className="rounded-lg bg-[var(--color-primary-tint)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-primary)] mb-1">Expected Impact</p>
                <p className="text-sm text-[var(--color-ink)]">{insight.expectedImpact.description}</p>
                {insight.expectedImpact.financialEstimate && (
                  <p className="mt-1 text-sm font-semibold text-[var(--color-primary)]">{insight.expectedImpact.financialEstimate}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatFor(w) {
  if (!w) return null;
  if (w.format === 'currency') return formatNaira;
  if (w.format === 'percentage') return formatPercent;
  if (w.format === 'number') return formatNumber;
  return null;
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
      <p className="text-xs font-semibold text-[var(--color-ink-faint)]">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="font-mono text-sm font-bold" style={{ color: p.color }}>
          {payload.length > 1 && <span className="font-normal text-xs mr-1.5 opacity-70">{p.name}</span>}
          {formatNaira(p.value)}
        </p>
      ))}
    </div>
  );
};

function LineChartWidget({ widget, toRecharts }) {
  const w = widget;
  const drillLevels = w.result?.drillLevels;
  const levels = drillLevels ? Object.keys(drillLevels) : null;
  const [activeLevel, setActiveLevel] = useState(levels ? levels[0] : null);

  // Normalize drill-level data (x/y → label/value) for Recharts
  const rawLevelData = activeLevel && drillLevels ? drillLevels[activeLevel] : null;
  const levelData = rawLevelData ? rawLevelData.map(d => ({ label: d.x, value: d.y })) : null;
  const chartData = levelData || w.result?.data || toRecharts(w.result?.series);
  const hasData = chartData.length > 0;
  const annotation = w.result?.annotation;
  const insight = w.result?.insight;

  const labels = { year: 'Year', month: 'Month', week: 'Week', day: 'Day' };
  const granLabel = w.result?.displayGranularity || (levels ? levels[0] : 'month');
  const titleLabel = labels[granLabel] || granLabel;

  const { tickFormatter: formatDate } = makeDateFormatter(chartData);

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
      {insight ? (
        <>
          <div className="flex items-center gap-1.5">
            <h3 className="text-base font-semibold text-[var(--color-ink)]">{insight.title}</h3>
            {w.description && <InfoBadge description={w.description} />}
          </div>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{insight.subtitle}</p>
        </>
      ) : (
        <div className="flex items-center gap-1.5 mb-1">
          <h3 className="text-base font-semibold text-[var(--color-ink)]">{titleLabel} Revenue</h3>
          {w.description && <InfoBadge description={w.description} />}
        </div>
      )}

      {/* Drill-down toggle */}
      {levels && levels.length > 1 && (
        <div className="mt-2 mb-2 flex items-center gap-1">
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
              {labels[lvl] || lvl}
            </button>
          ))}
        </div>
      )}

      {hasData ? (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 20, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={formatDate} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={formatFor(w) || undefined} />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-primary)"
                strokeWidth={2.5}
                dot={{ r: 4, fill: 'var(--color-primary)', strokeWidth: 0 }}
                activeDot={{ r: 6, fill: 'var(--color-primary)', stroke: '#fff', strokeWidth: 2 }}
              />
              {annotation && levels && activeLevel === levels[0] && (
                <ReferenceDot
                  x={annotation.x}
                  y={annotation.y}
                  r={5}
                  fill="#f59e0b"
                  stroke="#fff"
                  strokeWidth={2}
                  label={{ value: annotation.label, position: 'top', fontSize: 11, fill: '#92400e', fontWeight: 600 }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
      )}
    </div>
  );
}

/**
 * Chart-type layout — the platform's original presentation strategy, and the
 * one the Sales dashboard has always used: widgets grouped by how they draw,
 * then rendered in a fixed order of forms (KPIs, lines, bars, tables, ...).
 *
 * Moved here verbatim out of DashboardSection. Sales still renders through
 * exactly this code, which is what keeps that dashboard byte-identical. It is
 * also what each section of a sectioned dashboard delegates to, so chart
 * rendering exists in one place rather than once per layout.
 */
function ChartTypeLayout({ widgets, totalRevenue }) {
  const valid = widgets;

  // Group widgets by chartType
  const kpiCards = valid.filter(w => w.chartType === 'kpi-card');
  const barCharts = valid.filter(w => w.chartType === 'bar');
  const hbarCharts = valid.filter(w => w.chartType === 'hbar');
  const lineCharts = valid.filter(w => w.chartType === 'line');
  const tables = valid.filter(w => w.chartType === 'table');
  const pies = valid.filter(w => w.chartType === 'pie');
  const paretos = valid.filter(w => w.chartType === 'pareto');
  const treemaps = valid.filter(w => w.chartType === 'treemap');
  const scatters = valid.filter(w => w.chartType === 'scatter');
  const stackedAreas = valid.filter(w => w.chartType === 'stacked-area');
  const bullets = valid.filter(w => w.chartType === 'bullet');
  const divergingBars = valid.filter(w => w.chartType === 'diverging-bar');
  const histograms = valid.filter(w => w.chartType === 'histogram');

  // Transform widget series format [{x, y}] to Recharts [{label, value}]
  const toRecharts = (seriesArr) => {
    if (!seriesArr || seriesArr.length === 0) return [];
    const s = seriesArr[0];
    return (s.data || []).map(d => ({ label: d.x || d.label || '', value: d.y || d.value || 0 }));
  };
  return (
    <>

      {/* Growth Rate Widget */}
      {lineCharts.some(w => w.id === 'sales-growth-rate') && (
        <GrowthRateWidget widget={lineCharts.find(w => w.id === 'sales-growth-rate')} />
      )}

      {/* KPI Cards */}
      {kpiCards.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
          {kpiCards.map(w => (
            <KpiCard
              key={w.id}
              label={w.title}
              value={w.result?.value}
              format={formatFor(w)}
              sub={w.result?.sublabel || w.result?.sub || null}
              trend={w.result?.trend}
              description={w.description}
            />
          ))}
        </div>
      )}

      {/* What the KPIs above mean, and what to do about them. Collected in
          one block rather than inside each tile: the cards are a 4-up grid of
          headline figures, and a paragraph in each would destroy the scan
          that makes a KPI row worth having. Ordered by severity so the thing
          needing action is read first. */}
      {kpiCards.some(w => w.result?.executive) && (
        <div className="mb-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h3 className="mb-1 text-base font-semibold text-[var(--color-ink)]">What this means</h3>
          <p className="text-xs text-[var(--color-ink-faint)]">Interpretation and next step for each figure above.</p>
          <div className="divide-y divide-[var(--color-line)]">
            {[...kpiCards.filter(w => w.result?.executive)]
              .sort((a, b) => {
                const rank = { high: 0, medium: 1, info: 2, low: 3 };
                return (rank[a.result.executive.severity] ?? 2) - (rank[b.result.executive.severity] ?? 2);
              })
              .map(w => (
                <div key={w.id} className="pt-1 first:pt-0">
                  <ExecutiveNote note={w.result.executive} />
                  <p className="mb-3 ml-3.5 mt-1 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{w.title}</p>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Line Charts — smooth trend with peak annotation */}
      {lineCharts.filter(w => w.id !== 'sales-growth-rate' && w.id !== 'sales-seasonality' && w.id !== 'revenue-forecast').map(w => (
        <LineChartWidget key={w.id} widget={w} toRecharts={toRecharts} />
      ))}

      {/* Bar Charts */}
      {barCharts.filter(w => w.id !== 'monthly-sales-performance').map(w => {
        const chartData = w.result?.data || toRecharts(w.result?.series);
        const hasData = chartData.length > 0;
        const { tickFormatter: formatBarDate } = makeDateFormatter(chartData);
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {w.result?.insight && (typeof w.result.insight === 'object' ? (
              <div className="mb-3 p-3 bg-muted rounded-lg border border-border">
                <h3 className="text-sm font-semibold text-[var(--color-ink)]">{w.result.insight.title}</h3>
                {w.result.insight.subtitle && (
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{w.result.insight.subtitle}</p>
                )}
              </div>
            ) : (
              <p className="mb-3 text-sm leading-relaxed text-[var(--color-ink-soft)] border-l-2 border-[var(--color-primary)]/40 pl-3">
                {w.result.insight}
              </p>
            ))}
            {hasData ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={formatBarDate} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="value" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}

      {/* Monthly Sales Performance Widget */}
      {barCharts.some(w => w.id === 'monthly-sales-performance') && (
        <MonthlySalesPerformanceWidget
          widget={barCharts.find(w => w.id === 'monthly-sales-performance')}
          totalRevenue={totalRevenue}
        />
      )}

      {/* Sales Seasonality Widget */}
      {lineCharts.some(w => w.id === 'sales-seasonality') && (
        <SalesSeasonalityWidget widget={lineCharts.find(w => w.id === 'sales-seasonality')} />
      )}

      {/* Revenue Forecast Widget */}
      {lineCharts.some(w => w.id === 'revenue-forecast') && (
        <RevenueForecastWidget widget={lineCharts.find(w => w.id === 'revenue-forecast')} />
      )}

      {/* Sales Concentration Risk Widget */}
      {pies.some(w => w.id === 'sales-concentration-risk') && (
        <SalesConcentrationWidget widget={pies.find(w => w.id === 'sales-concentration-risk')} />
      )}

      {/* Profit Leakage Widget */}
      {scatters.some(w => w.id === 'profit-leakage') && (
        <ProfitLeakageWidget widget={scatters.find(w => w.id === 'profit-leakage')} />
      )}

      {/* Product Performance Over Time Widget */}
      {tables.some(w => w.id === 'product-performance-over-time') && (
        <ProductPerformanceWidget widget={tables.find(w => w.id === 'product-performance-over-time')} />
      )}

      {/* Horizontal Bar Charts */}
      {hbarCharts.map(w => {
        const rawData = w.result?.data || toRecharts(w.result?.series);
        const chartData = [...rawData].sort((a, b) => b.value - a.value);
        const hasData = chartData.length > 0;
        const maxLabelLen = chartData.reduce((m, d) => Math.max(m, String(d.label || '').length), 0);
        const highlightCount = w.result?.highlightCount || 0;
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {w.result?.insight && (typeof w.result.insight === 'object' ? (
              <div className="mb-3 p-3 bg-muted rounded-lg border border-border">
                <h3 className="text-sm font-semibold text-[var(--color-ink)]">{w.result.insight.title}</h3>
                {w.result.insight.subtitle && (
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{w.result.insight.subtitle}</p>
                )}
              </div>
            ) : (
              <p className="mb-3 text-sm leading-relaxed text-[var(--color-ink-soft)] border-l-2 border-[var(--color-primary)]/40 pl-3">
                {w.result.insight}
              </p>
            ))}
            {hasData ? (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={w.format === 'number' ? (v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) : (v => v >= 1000000 ? '₦' + (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? '₦' + (v / 1000).toFixed(0) + 'k' : '₦' + v)} />
                    <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} width={Math.min(maxLabelLen * 7, 180)} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {chartData.map((_, i) => (
                        <Cell key={i} fill={i < highlightCount ? 'var(--color-primary)' : 'var(--color-line)'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}

      {/* Pareto Charts */}
      {paretos.map(w => {
        const chartData = w.result?.data || [];
        const hasData = chartData.length > 0;
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {w.result?.insight && (typeof w.result.insight === 'object' ? (
              <div className="mb-3 p-3 bg-muted rounded-lg border border-border">
                <h3 className="text-sm font-semibold text-[var(--color-ink)]">{w.result.insight.title}</h3>
                {w.result.insight.subtitle && (
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{w.result.insight.subtitle}</p>
                )}
              </div>
            ) : (
              <p className="mb-3 text-sm leading-relaxed text-[var(--color-ink-soft)] border-l-2 border-[var(--color-primary)]/40 pl-3">
                {w.result.insight}
              </p>
            ))}
            {hasData ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'} />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => v + '%'} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine yAxisId="right" y={80} stroke="var(--color-warning)" strokeDasharray="4 4" label={{ value: '80%', position: 'right', fontSize: 10, fill: 'var(--color-warning)' }} />
                    <Bar yAxisId="left" dataKey="value" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
                    <Line yAxisId="right" type="monotone" dataKey="cumulative" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 3, fill: 'var(--color-accent)' }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}

      {/* Bullet charts */}
      {bullets.map(w => (
        <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
          <div className="flex items-center gap-1.5 mb-3">
            <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
            {w.description && <InfoBadge description={w.description} />}
          </div>
          <BulletChart
            value={w.result?.value}
            max={w.result?.max}
            ranges={w.result?.ranges}
            sublabel={w.result?.sublabel}
            interpretation={w.result?.interpretation}
            ariaLabel={`${w.result?.label || w.title}: ${w.result?.value}%`}
          />
          <ExecutiveNote note={w.result?.executive} />
        </div>
      ))}

      {/* Diverging bars — one axis, both directions. Deficit and surplus
          against the same target read as one distribution rather than two
          unrelated lists, which is the whole point of the form. */}
      {divergingBars.map(w => {
        const chartData = [...(w.result?.data || [])].sort((a, b) => a.value - b.value);
        const maxLabelLen = chartData.reduce((m, d) => Math.max(m, String(d.label || '').length), 0);
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-3">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {chartData.length > 0 ? (
              <div style={{ height: Math.max(240, chartData.length * 26 + 60) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 24, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} />
                    <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} width={Math.min(maxLabelLen * 7, 180)} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine x={0} stroke="var(--color-ink-faint)" strokeWidth={1.5} />
                    <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={d.value < 0 ? 'var(--color-danger)' : 'var(--color-line-strong)'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}

      {/* Histograms — distribution across ordered buckets, so the bars keep
          their given order rather than being ranked by height. */}
      {histograms.map(w => {
        const chartData = w.result?.data || [];
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-3">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {chartData.length > 0 ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }} barCategoryGap="8%">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--color-ink-faint)' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} allowDecimals={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="value" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}

      {/* Treemaps */}
      {treemaps.map(w => {
        const treeData = w.result?.data || [];
        const hasData = treeData.length > 0;
        const COLORS = ['#1a73e8', '#34a853', '#ea4335', '#fbbc04', '#4285f4', '#0f9d58', '#db4437', '#ff6d01', '#46bdc6', '#7b1fa2', '#c2185b', '#00796b', '#e64a19', '#5c6bc0', '#00838f'];
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {w.result?.insight && (typeof w.result.insight === 'object' ? (
              <div className="mb-3 p-3 bg-muted rounded-lg border border-border">
                <h3 className="text-sm font-semibold text-[var(--color-ink)]">{w.result.insight.title}</h3>
                {w.result.insight.subtitle && (
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{w.result.insight.subtitle}</p>
                )}
              </div>
            ) : (
              <p className="mb-3 text-sm leading-relaxed text-[var(--color-ink-soft)] border-l-2 border-[var(--color-primary)]/40 pl-3">
                {w.result.insight}
              </p>
            ))}
            {hasData ? (
              <div>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <Treemap data={[{ name: 'Revenue', children: treeData }]} dataKey="size" stroke="var(--color-surface)" fill="var(--color-primary)">
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return (
                          <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
                            <p className="text-xs font-semibold text-[var(--color-ink)]">{d?.name}</p>
                            <p className="mt-1 text-xs text-[var(--color-ink-soft)]">₦{(d?.size || 0).toLocaleString()} <span className="text-[var(--color-primary)] font-medium">({d?.share || 0}%)</span></p>
                          </div>
                        );
                      }} />
                      {treeData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Treemap>
                  </ResponsiveContainer>
                </div>
                {/* Quick-reference summary table — makes composition obvious at a glance */}
                <div className="mt-4 grid grid-cols-5 gap-2">
                  {treeData.slice(0, 5).map((p, i) => (
                    <div key={i} className="text-center p-2 rounded-lg border border-[var(--color-line)]" style={{ borderLeftColor: COLORS[i % COLORS.length], borderLeftWidth: 3 }}>
                      <p className="text-xs text-[var(--color-ink-faint)] truncate">{p.name}</p>
                      <p className="text-sm font-semibold text-[var(--color-ink)]">{p.share}%</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}

      {/* Scatter Plots */}
      {scatters.filter(w => w.id !== 'profit-leakage').map(w => {
        const chartData = w.result?.data || [];
        const hasData = chartData.length > 0;
        if (!hasData) {
          return (
            <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              <p className="text-sm text-[var(--color-ink-faint)] mt-2">No data available for this chart.</p>
            </div>
          );
        }
        // Split data into good / watch / poor groups for coloring
        const poor = chartData.filter(d => d.margin < 20);
        const watch = chartData.filter(d => d.margin >= 20 && d.margin < 40);
        const good = chartData.filter(d => d.margin >= 40);
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {w.result?.insight && (typeof w.result.insight === 'object' ? (
              <div className="mb-3 p-3 bg-muted rounded-lg border border-border">
                <h3 className="text-sm font-semibold text-[var(--color-ink)]">{w.result.insight.title}</h3>
                {w.result.insight.subtitle && (
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{w.result.insight.subtitle}</p>
                )}
              </div>
            ) : (
              <p className="mb-3 text-sm leading-relaxed text-[var(--color-ink-soft)] border-l-2 border-[var(--color-primary)]/40 pl-3">
                {w.result.insight}
              </p>
            ))}
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                  <XAxis type="number" dataKey="index" name="Product" tick={false} />
                  <YAxis type="number" dataKey="margin" name="Margin %" domain={[0, 'auto']} tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => v + '%'} />
                  <ZAxis range={[40, 180]} />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    return (
                      <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
                        <p className="text-xs font-semibold text-[var(--color-ink)]">{d?.name}</p>
                        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">Margin: <span className="font-medium" style={{ color: d?.margin < 20 ? '#ea4335' : d?.margin < 40 ? '#fbbc04' : '#34a853' }}>{d?.margin}%</span></p>
                        <p className="text-xs text-[var(--color-ink-faint)]">Revenue: ₦{(d?.revenue || 0).toLocaleString()}</p>
                      </div>
                    );
                  }} />
                  {poor.length > 0 && <Scatter name="Poor (under 20%)" data={poor} fill="#ea4335" />}
                  {watch.length > 0 && <Scatter name="Watch (20-40%)" data={watch} fill="#fbbc04" />}
                  {good.length > 0 && <Scatter name="Good (40%+)" data={good} fill="#34a853" />}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex gap-4 justify-center text-xs text-[var(--color-ink-faint)]">
              <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ backgroundColor: '#ea4335' }}></span>Poor (&lt;20%)</span>
              <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ backgroundColor: '#fbbc04' }}></span>Watch (20-40%)</span>
              <span><span className="inline-block w-3 h-3 rounded-full mr-1" style={{ backgroundColor: '#34a853' }}></span>Good (40%+)</span>
            </div>
          </div>
        );
      })}

      {/* Tables */}
      {tables.filter(w => w.id !== 'product-performance-over-time').map(w => (
        <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-card overflow-hidden mb-4">
          <div className="px-6 py-4 border-b border-[var(--color-line)]">
            {w.result?.insight ? (
              <>
                <div className="flex items-center gap-1.5">
                  <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.result.insight.title}</h3>
                  {w.description && <InfoBadge description={w.description} />}
                </div>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{w.result.insight.subtitle}</p>
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
                {w.description && <InfoBadge description={w.description} />}
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--color-bg)] text-left">
                  {w.result?.columns?.map((col) => (
                    <th key={col} className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {w.result?.rows?.map((row, i) => (
                  <tr key={i} className="border-t border-[var(--color-line)] hover:bg-[var(--color-primary-tint)]/30">
                    {row.map((cell, j) => (
                      <td key={j} className={`px-6 py-2.5 ${j === 0 ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-ink-soft)]'}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Stacked Area Charts */}
      {stackedAreas.map(w => {
        const pivotData = w.result?.data;
        const categories = w.result?.categories || [];
        const hasData = pivotData && pivotData.length > 0 && categories.length > 0;
        const insight = w.result?.insight;
        const areaColors = ['var(--color-primary)', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'];
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            {insight ? (
              <>
                <div className="flex items-center gap-1.5">
                  <h3 className="text-base font-semibold text-[var(--color-ink)]">{insight.title}</h3>
                  {w.description && <InfoBadge description={w.description} />}
                </div>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{insight.subtitle}</p>
              </>
            ) : (
              <div className="flex items-center gap-1.5 mb-1">
                <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
                {w.description && <InfoBadge description={w.description} />}
              </div>
            )}
            {hasData ? (
              <div className="h-80 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={pivotData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'} />
                    <Tooltip content={<CustomTooltip />} />
                    {categories.map((cat, i) => (
                      <Area key={cat} type="monotone" dataKey={cat} stackId="1" stroke={areaColors[i % areaColors.length]} fill={areaColors[i % areaColors.length]} fillOpacity={0.6} strokeWidth={1.5} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No category trend data available.</p>
            )}
            {/* Category legend */}
            {hasData && categories.length > 1 && (
              <div className="mt-4 flex flex-wrap gap-3 justify-center text-xs text-[var(--color-ink-faint)]">
                {categories.map((cat, i) => (
                  <span key={cat} className="flex items-center gap-1">
                    <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: areaColors[i % areaColors.length] }} />
                    {cat}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Pie Charts */}
      {pies.filter(w => w.id !== 'sales-concentration-risk').map(w => {
        const pieData = w.result?.data || w.result?.series;
        const hasData = pieData && pieData.length > 0;
        return (
          <div key={w.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <h3 className="text-base font-semibold text-[var(--color-ink)]">{w.title}</h3>
              {w.description && <InfoBadge description={w.description} />}
            </div>
            {hasData ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} dataKey="value">
                      {pieData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No data available for this chart.</p>
            )}
            <ExecutiveNote note={w.result?.executive} />
          </div>
        );
      })}
    </>
  );
}

/**
 * The executive sections a stock-side dashboard is read in, in the order an
 * owner needs them: what the inventory is worth, what threatens it, what to
 * do about it this week, and where next quarter's money should go.
 *
 * Section membership is declared by each widget, never listed here. A new
 * metric appears in the right place by carrying `section` metadata, with no
 * change to this file.
 */
const EXECUTIVE_SECTIONS = [
  { id: 'Financial', title: 'Financial', blurb: 'Capital invested, and the profit opportunity it carries.' },
  { id: 'Risk', title: 'Risk', blurb: 'Where money is being lost, or is about to be.' },
  { id: 'Operations', title: 'Operations', blurb: 'Day-to-day purchasing and stock decisions.' },
  { id: 'Strategy', title: 'Strategy', blurb: 'Long-term inventory optimisation and investment.' },
];

/**
 * Sectioned layout — groups widgets by business meaning instead of chart
 * form, then hands each group to ChartTypeLayout to draw.
 *
 * An executive reads a stock position by question ("what is at risk?"), not
 * by shape ("show me the bar charts"), which is what the chart-type layout
 * implicitly assumes.
 */
function SectionedLayout({ widgets, totalRevenue }) {
  const bySection = new Map();
  for (const w of widgets) {
    const key = w.section || 'Other';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(w);
  }

  const known = EXECUTIVE_SECTIONS.filter(s => bySection.has(s.id));
  // A widget must never disappear because its section is new or absent, so
  // anything unrecognised still renders, after the known sections.
  const extra = [...bySection.keys()]
    .filter(k => !EXECUTIVE_SECTIONS.some(s => s.id === k))
    .map(k => ({ id: k, title: k === 'Other' ? 'Other Metrics' : k, blurb: null }));

  return (
    <>
      {[...known, ...extra].map(s => (
        <section key={s.id} className="mb-8">
          <div className="mb-4 border-b border-[var(--color-line)] pb-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-ink)]">{s.title}</h3>
            {s.blurb && <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{s.blurb}</p>}
          </div>
          <ChartTypeLayout widgets={bySection.get(s.id)} totalRevenue={totalRevenue} />
        </section>
      ))}
    </>
  );
}

/**
 * Which presentation strategy each dashboard uses. Adding a dashboard type
 * here is the whole cost of giving it its own layout — the widget engine,
 * registry and calculations are untouched by the choice.
 */
const DASHBOARD_LAYOUTS = {
  inventory: SectionedLayout,
  // Expiry and Supplier stay on the chart-type layout. Sectioning earns its
  // keep when a dashboard spans several kinds of question; these two do not
  // — every expiry widget is a Risk widget, so a "Risk" heading above them
  // labels the whole dashboard twice and says nothing the title has not.
  // They keep their `section` metadata, so moving them here is all it takes
  // if either grows into more than one question.
};

const layoutFor = (dashboardKey) => DASHBOARD_LAYOUTS[dashboardKey] || ChartTypeLayout;

/**
 * Dashboard router. Owns everything common to every dashboard — the title,
 * the valid/errored split — and delegates the arrangement of the widgets
 * themselves to whichever layout that dashboard type declares.
 */
function DashboardSection({ dashboardKey, data, totalRevenue, idFilter, titleOverride }) {
  if (!data || !data.available || data.available.length === 0) return null;

  const available = idFilter ? data.available.filter(w => idFilter.has(w.id)) : data.available;
  if (available.length === 0) return null;

  const labels = { sales: 'Sales', inventory: 'Inventory', expiry: 'Expiry', supplier: 'Supplier', customer: 'Customer' };
  const title = titleOverride || labels[dashboardKey] || dashboardKey;

  // Filter widgets that have valid results (not errored)
  const valid = available.filter(w => !w.result?.error);
  const errored = available.filter(w => w.result?.error);

  const Layout = layoutFor(dashboardKey);

  return (
    <div className="mb-10">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-7 w-1 rounded-full bg-[var(--color-primary)]" />
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
      </div>

      <Layout widgets={valid} totalRevenue={totalRevenue} />

      {/* Errored widgets — shown as unavailable */}
      {errored.length > 0 && (
        <div className="border-l-2 border-amber-400 bg-amber-50/60 px-4 py-3 mb-4">
          <p className="text-sm font-medium text-warning mb-2">Some widgets are unavailable</p>
          <div className="flex flex-wrap gap-2">
            {errored.map(w => (
              <span key={w.id} className="inline-flex items-center gap-1 border border-amber-200 bg-card px-3 py-1 text-xs text-warning">
                {w.title} — data unavailable
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const location = useLocation();
  const state = location.state || {};
  const { user, organization, signOut } = useAuth();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [widgetManifest, setWidgetManifest] = useState(state.widgetManifest || null);
  // Declared above the early "no data" return below so hook order never
  // changes across renders (was previously below it — violated Rules of
  // Hooks and crashed with React error #310 when transitioning from the
  // empty state to a loaded state within the same mounted instance).
  const [bizHealth, setBizHealth] = useState(state.bizHealth || null);
  const [bizHealthLoading, setBizHealthLoading] = useState(!state.bizHealth);

  const loadAllWidgets = async () => {
    try {
      const res = await apiFetch('/api/widgets', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
      const data = await res.json();
      setWidgetManifest(data);
    } catch (_) {}
  };

  // Accept both metrics (Phase 5) and analytics (legacy)
  const metrics = state.metrics;
  const analysis = state.analysis;

  // Arriving from an upload carries the whole analysis in navigation state.
  // Arriving any other way — a refresh, a bookmark, the sidebar link — does
  // not, and navigation state does not survive any of those. The dashboard
  // used to show its empty "no data" screen in that case, as though nothing
  // had ever been uploaded, so the only way back to your own numbers was to
  // upload the file again. Everything needed is already persisted, so fetch
  // it instead.
  const [analytics, setAnalytics] = useState(state.analytics || null);
  const arrivedWithAnalysis = !!(state.metrics || state.analytics || state.widgetManifest);
  const [restoring, setRestoring] = useState(!arrivedWithAnalysis);

  useEffect(() => {
    if (arrivedWithAnalysis) {
      // Fresh from an upload — only the widget manifest may be missing.
      if (!widgetManifest) loadAllWidgets();
      return;
    }

    let cancelled = false;
    (async () => {
      // Both are independent reads; requesting them in parallel keeps a cold
      // dashboard to one round trip's worth of waiting rather than two.
      const [analyticsRes] = await Promise.allSettled([
        apiFetch('/api/analytics').then((r) => (r.ok ? r.json() : null)),
        loadAllWidgets(),
      ]);
      if (cancelled) return;
      if (analyticsRes.status === 'fulfilled' && analyticsRes.value) {
        setAnalytics(analyticsRes.value);
      }
      setRestoring(false);
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Business Health (Phase 6) — prefer session data from upload, fall back to API
  useEffect(() => {
    if (state.bizHealth) {
      setBizHealthLoading(false);
      return;
    }
    let cancelled = false;
    apiFetch('/api/business-health')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && data.health) setBizHealth(data);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setBizHealthLoading(false); });
    return () => { cancelled = true; };
  }, [state.bizHealth]);

  // No data — computed as a flag (not an early return) so every hook below
  // still runs on every render. A conditional `return` here would change the
  // hook count between "no data" and "loaded" renders of the same mounted
  // instance and crash with React error #310 (Rules of Hooks violation) —
  // this happened for real: clicking "Load All Data" from the empty state
  // used to white-screen the page.
  // `restoring` keeps the empty state from flashing while the saved analysis
  // is still in flight — otherwise every cold load blinks "no data yet" at
  // someone who has uploaded plenty.
  const showNoData = !restoring && !widgetManifest && !metrics && (!analytics || !analytics.metrics);

  // Extract data from whichever source is available
  const o = metrics?.overview || analytics?.metrics || {};
  const p = metrics?.products;
  const t = metrics?.trends;
  const pay = metrics?.payments;
  const health = metrics?.health;
  const insights = analysis?.insights || [];

  // Dataset capability flags — reuse the classifier's own output when present
  // (analysis.capabilities), else derive from non-empty widget categories.
  // Same signal the classifier already uses for recommended_dashboards —
  // no new detection logic.
  const dashboards = widgetManifest?.dashboards || {};
  const capabilities = analysis?.capabilities || {
    sales: (dashboards.sales?.available?.length || 0) > 0,
    inventory: (dashboards.inventory?.available?.length || 0) > 0,
    expiry: (dashboards.expiry?.available?.length || 0) > 0,
    supplier: (dashboards.supplier?.available?.length || 0) > 0,
    customer: (dashboards.customer?.available?.length || 0) > 0,
  };

  // ---- Analysis context handed to the AI Advisor -------------------------
  //
  // The Advisor used to answer by re-querying the database itself, which is a
  // second analytics path — so it could report a different revenue than the
  // number on screen, and the owner had no way to tell which to believe.
  // This snapshots what the dashboard is ACTUALLY displaying (the analytics
  // engine's own precomputed widget results) and hands it over as the
  // authoritative figures. The Advisor interprets these; it no longer
  // recomputes them.
  const analysisContext = useMemo(() => {
    const kpis = [];
    for (const [dashboardKey, data] of Object.entries(dashboards)) {
      for (const w of data?.available || []) {
        if (w.chartType !== 'kpi-card' || w.result?.error) continue;
        kpis.push({
          id: w.id,
          label: w.title,
          value: w.result?.value,
          format: formatFor(w),
          sublabel: w.result?.sublabel || w.result?.sub || null,
          dashboard: dashboardKey,
        });
      }
    }
    if (kpis.length === 0 && !bizHealth?.health) return null;
    return {
      kpis,
      businessHealth: bizHealth?.health
        ? { score: bizHealth.health.overallScore, rating: bizHealth.health.rating }
        : null,
      capabilities,
      // Every dataset the pharmacy has uploaded is included in these figures
      // — the dashboard has no date/branch/category filter controls yet, so
      // there is no narrower selection to report. When those land, add them
      // here and the Advisor will scope to them without further changes.
      scope: 'All uploaded datasets combined (no filters applied).',
    };
  }, [dashboards, bizHealth, capabilities]);

  // The 'sales' dashboardKey holds both trend/KPI widgets and product-ranking
  // widgets — split it client-side for the Performance vs Products nav tabs
  // (no backend category exists for this split; PRODUCT_WIDGET_IDS reuses the
  // ids widgetRegistry.js already assigns).
  const performanceIdFilter = new Set(
    (dashboards.sales?.available || []).map((w) => w.id).filter((id) => !PRODUCT_WIDGET_IDS.has(id))
  );
  const monthlyRevenueWidget = dashboards.sales?.available?.find((w) => w.id === 'monthly-revenue' && !w.result?.error) || null;

  // Legacy fallback data
  const monthlyRevenue = t?.months || analytics?.monthlyRevenue || [];
  const topProductsLegacy = analytics?.topProducts || [];
  const topProducts = p?.top10 || topProductsLegacy;
  const hasMonthly = monthlyRevenue.length > 1;

  // Mom growth from last month
  const lastMom = t?.months && t.months.length >= 2
    ? t.months[t.months.length - 1]?.momGrowth
    : null;

  // ── All derived metrics from centralized module — single source of truth ──
  const totalRevenue = pickTotalRevenue({ overview: o, trends: t, monthlyRevenue });
  const avgTxnValue = avgTransactionValue({ totalRevenue, transactionCount: o.transactionCount });
  const top3Pct = topConcentration({ products: topProducts, totalRevenue, n: 3 });
  const { gap, chartSum: monthlySum, direction: gapDir } = revenueGap({ totalRevenue, monthlyRevenue });
  const hasRevenueGap = gap > 0 && monthlyRevenue.length > 0;
  const monthlyRevenueWithGap = augmentMonthly({ totalRevenue, monthlyRevenue });

  // Cross-check server values vs client-derived — logs warnings on mismatch
  useEffect(() => {
    validateMetricConsistency({ overview: o, trends: t, monthlyRevenue, products: p, topProducts });
  }, [o?.totalRevenue, t?.totalRevenue, monthlyRevenue.length, topProducts?.length]);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // The report is drawn server-side with vector primitives (pdfkit) from the
  // same current-upload-scoped data the dashboard itself displays — see
  // server/services/reports/dashboardPdfReport.js. This replaced a
  // html2canvas + jsPDF screenshot of the live DOM, which produced blurry
  // text, cut charts in half at arbitrary page breaks, and needed a
  // computed-style-inlining hack because html2canvas cannot parse the
  // oklch() colors Tailwind v4 generates.
  const exportToPDF = async () => {
    setExporting(true);
    setExportError('');

    try {
      const res = await apiFetch('/api/export/dashboard-pdf');
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Export failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'rxnaija-dashboard-report.pdf';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('PDF export failed:', err);
      setExportError(err.message || 'Could not generate the PDF.');
    } finally {
      setExporting(false);
    }
  };

  const navItems = [
    { id: 'overview',    label: 'Overview',    icon: gridIcon },
    { id: 'performance', label: 'Performance', icon: trendingIcon },
    { id: 'products',    label: 'Products',    icon: packageIcon },
    { id: 'inventory',   label: 'Inventory',   icon: boxIcon },
    { id: 'customers',   label: 'Customers',   icon: usersIcon },
    { id: 'suppliers',   label: 'Suppliers',   icon: truckIcon },
    { id: 'advisor',     label: 'AI Advisor',  icon: sparklesIcon },
    { id: 'reports',     label: 'Reports',     icon: fileIcon },
  ];

  const bottomNavItems = [
    { id: 'settings', label: 'Settings', icon: settingsIcon },
    { id: 'help',      label: 'Help',     icon: helpIcon },
  ];

  const [activeNav, setActiveNav] = useState('overview');

  // The walkthrough. Keyed on the user id so a shared computer doesn't hide
  // the tour from the next person to sign in.
  const tourKey = user?.id || organization?.organizationId || 'anon';
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    // Deferred a frame past the first paint: the tour measures real elements,
    // and on the very first render the sections it points at have not been
    // laid out yet.
    if (restoring || hasSeenTour(tourKey)) return undefined;
    const t = setTimeout(() => setTourOpen(true), 400);
    return () => clearTimeout(t);
  }, [restoring, tourKey]);

  // Safe to branch here (unlike before): every hook in this component has
  // already been called above, in the same order, on every render.
  // Restoring a saved analysis. Distinct from the empty state on purpose:
  // "nothing here yet" and "fetching what you already have" call for different
  // actions from the reader, and showing the first while doing the second is
  // what made a populated dashboard look wiped.
  if (restoring) {
    return (
      <div className="min-h-screen flex bg-[var(--color-bg)]">
        {/* Rail placeholder now matches the real rail's surface. It used to
            paint bg-[var(--foreground)] — a black column held for the whole
            fetch, then swapped to a light one the instant data landed. */}
        <div className="hidden lg:block w-64 shrink-0 bg-[var(--muted)] border-r border-[var(--color-line)]" />
        <div className="flex-1 lg:ml-64">
          <div className="mx-auto flex max-w-[var(--max-width)] flex-col items-center px-7 py-24">
            {/* Same component the auth guard renders, so the chart carries
                straight through from sign-in without restarting. */}
            <LoadingState sub="Rebuilding your dashboard from your most recent upload." />
          </div>
        </div>
      </div>
    );
  }

  if (showNoData) {
    return (
      <div className="min-h-screen flex bg-[var(--color-bg)]">
        {/* Same rail surface as the real rail and the restore state — all
            three placeholders have to agree, or the column changes colour
            as the page moves between them. */}
        <div className="hidden lg:block w-64 shrink-0 bg-[var(--muted)] border-r border-[var(--color-line)]" />
        <div className="flex-1 lg:ml-64">
          <div className="mx-auto max-w-[var(--max-width)] px-7 py-24 text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
                <path d="M22 12A10 10 0 0 0 12 2v10z" />
              </svg>
            </div>
            <h1 className="text-2xl font-semibold text-[var(--color-ink)]">No data to analyze</h1>
            <p className="mt-3 text-[var(--color-ink-soft)]">Upload your sales spreadsheet to generate AI-powered insights.</p>
            <div className="mt-6 flex items-center justify-center gap-4">
              <Link
                to="/upload"
                data-tour="empty-upload"
                className="inline-flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-6 py-3 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-card)] transition hover:bg-[var(--color-primary-dark)]"
              >
                Go to Upload
              </Link>
              <button
                onClick={loadAllWidgets}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] px-6 py-3 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
              >
                Load All Data
              </button>
            </div>
          </div>
        </div>

        {/* Mounted here too: a brand-new account renders this branch, and it
            is the one moment a walkthrough is worth the most. Steps whose
            targets don't exist on this screen drop out on their own. */}
        {tourOpen && (
          <ProductTour steps={TOUR_STEPS} userKey={tourKey} onFinish={() => setTourOpen(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-[var(--color-bg)]">

      {/* ---- Dark fixed sidebar ------------------------------------------- */}
      {/* Surface and ink come from .dashboard-sidebar's own token block in
          index.css — the rail sits one elevation step below the page rather
          than opposite it, so no bg-[var(--foreground)] slab here. */}
      <aside className={`dashboard-sidebar fixed left-0 top-0 z-50 h-screen w-64 flex flex-col border-r border-[var(--color-line)] transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
        {/* Brand */}
        <div className="flex items-center gap-3 px-5 pt-6 pb-4 border-b border-[var(--color-line)]">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)] text-[11px] font-bold font-mono text-primary-foreground">Rx</div>
          <div>
            <p className="text-sm font-semibold text-[var(--sidebar-ink-bright)]">RxNaija</p>
            <p className="text-[10px] text-[var(--sidebar-ink-dim)] font-mono tracking-wide">Analytics</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <button
                key={item.id}
                data-tour={`nav-${item.id}`}
                onClick={() => setActiveNav(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeNav === item.id
                    ? 'bg-[var(--sidebar-active-bg)] text-[var(--sidebar-ink-bright)] font-semibold'
                    : 'text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-ink-hover)]'
                }`}
              >
                <span className="w-4 h-4 shrink-0" dangerouslySetInnerHTML={{ __html: item.icon }} />
                {item.label}
              </button>
            ))}
          </div>

          {/* Divider */}
          <div className="my-3 mx-3 border-t border-[var(--color-line)]" />

          <div className="space-y-0.5">
            {bottomNavItems.map((item) => (
              <button
                key={item.id}
                data-tour={`nav-${item.id}`}
                /* Help had no content branch at all — clicking it selected a
                   tab that rendered nothing. It replays the walkthrough now,
                   which also gives the tour a way back once dismissed. */
                onClick={() => {
                  if (item.id === 'help') {
                    setActiveNav('overview');
                    setTourOpen(true);
                    return;
                  }
                  setActiveNav(item.id);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeNav === item.id
                    ? 'bg-[var(--sidebar-active-bg)] text-[var(--sidebar-ink-bright)] font-semibold'
                    : 'text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-hover-bg)] hover:text-[var(--sidebar-ink-hover)]'
                }`}
              >
                <span className="w-4 h-4 shrink-0" dangerouslySetInnerHTML={{ __html: item.icon }} />
                {item.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Bottom: user area */}
        <div className="px-4 py-4 border-t border-[var(--color-line)]">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-bold text-primary-foreground">
              {(user?.email || '?')[0].toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[var(--sidebar-ink-hover)] truncate">{organization?.name || user?.email || 'Loading…'}</p>
              <p className="text-[10px] text-[var(--sidebar-ink-dim)] capitalize">{organization?.role || user?.email || ''}</p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="text-[10px] font-medium text-[var(--sidebar-ink-dim)] hover:text-[var(--sidebar-ink-hover)] shrink-0"
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* ---- Sidebar overlay for mobile ---------------------------------- */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* ---- Main content ------------------------------------------------- */}
      <div className="flex-1 lg:ml-64">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex items-center gap-4 px-5 py-3 bg-[var(--background)]/90 backdrop-blur border-b border-[var(--border)] lg:hidden">
          <button onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-lg border border-[var(--border)] text-[var(--muted-foreground)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
          </button>
          <span className="text-sm font-semibold text-[var(--foreground)]">RxNaija Analytics</span>
        </div>

        <div className="mx-auto max-w-[var(--max-width)] px-7 py-10">

        {/* Header */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h1>Decision Intelligence</h1>
            {analysis && (
              <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                Analysis by {analysis.modelUsed} • Generated {new Date(analysis.generatedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/upload"
              data-tour="upload"
              className="inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
            >
              Upload New Data
            </Link>
            <button
              onClick={loadAllWidgets}
              className="inline-flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-5 py-2 text-xs font-semibold text-primary-foreground shadow transition hover:bg-[var(--color-primary-dark)]"
            >
              Load All Data
            </button>
            <button
              onClick={exportToPDF}
              data-tour="export"
              disabled={exporting}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground shadow transition hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {exporting ? (
                <>
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Exporting...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  Export PDF
                </>
              )}
            </button>
          </div>
        </div>
        {exportError && (
          <p className="-mt-6 mb-6 text-sm text-[var(--color-danger)]">{exportError}</p>
        )}

        {/* ================================================================ */}
        {/*   Overview — condensed executive summary                         */}
        {/* ================================================================ */}
        {activeNav === 'overview' && (
          <>
            <DatasetSummary fileName={analysis?.fileName} generatedAt={analysis?.generatedAt} capabilities={capabilities} />
            {widgetManifest && (
              <div data-tour="kpis">
                <DynamicKpiGrid widgetManifest={widgetManifest} capabilities={capabilities} />
              </div>
            )}
            <div data-tour="health">
              <BusinessHealthCard bizHealth={bizHealth} />
            </div>
            {bizHealthLoading && !bizHealth && (
              <div className="mb-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-center">
                <p className="text-xs text-[var(--color-ink-faint)]">Computing business health score...</p>
              </div>
            )}
            {bizHealth?.insights?.length > 0 && (
              <ExecutiveBrief insights={bizHealth.insights} topPriorities={bizHealth.topPriorities} />
            )}
            {bizHealth?.topPriorities?.length > 0 && (
              <TopPriorities topPriorities={bizHealth.topPriorities} />
            )}
            {capabilities.sales && monthlyRevenueWidget && (
              <LineChartWidget widget={monthlyRevenueWidget} toRecharts={toRecharts} />
            )}
            <AlertsPanel concerns={bizHealth?.health?.concerns} top3Pct={top3Pct} dataHealth={health} />
          </>
        )}

        {/* ================================================================ */}
        {/*   Per-tab drill-down — widget-driven                              */}
        {/* ================================================================ */}
        {activeNav !== 'overview' && activeNav !== 'advisor' && activeNav !== 'reports' && widgetManifest &&
          (NAV_DASHBOARD_KEYS[activeNav] || []).map((key) => (
            <DashboardSection
              key={key}
              dashboardKey={key}
              data={dashboards[key]}
              totalRevenue={totalRevenue}
              idFilter={activeNav === 'products' ? PRODUCT_WIDGET_IDS : activeNav === 'performance' ? performanceIdFilter : undefined}
              titleOverride={activeNav === 'products' ? 'Products' : activeNav === 'performance' ? 'Performance' : undefined}
            />
          ))
        }

        {/* AI Advisor — conversational chat, grounded in the same data/recommendation engine */}
        {activeNav === 'advisor' && <AdvisorChat analysisContext={analysisContext} />}

        {/* Legacy hardcoded sections — used only when no widget manifest exists */}
        {activeNav === 'overview' && !widgetManifest && (
          <>
            {/* KPI Cards (Legacy) */}
            <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <KpiCard label="Total Revenue" value={totalRevenue} format={formatNaira} trend={lastMom} />
              <KpiCard
                label="Gross Profit"
                value={o.grossProfit}
                format={formatNaira}
                sub={o.grossMargin != null ? `${o.grossMargin}% margin` : undefined}
              />
              <KpiCard label="Transactions" value={o.transactionCount} format={formatNumber}
                sub={avgTxnValue != null ? `Avg ${formatNaira(avgTxnValue)}` : undefined} />
              <KpiCard label="Products Sold" value={o.totalQuantitySold} format={formatNumber}
                sub={o.averageSellingPrice != null ? `Avg ${formatNaira(o.averageSellingPrice)}/unit` : undefined} />
              <KpiCard label="Distinct Products" value={p?.totalDistinctProducts} format={formatNumber}
                sub={top3Pct != null ? `Top 3: ${top3Pct}% of rev` : undefined} />
            </div>

            {/* AI Insights Section */}
            {insights.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 text-purple-600">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--color-ink)]">AI-Powered Insights</h2>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {analysis?.modelUsed === 'rule-based'
                        ? 'Rule-based analysis. Add LLM_API_KEY for AI-powered analysis.'
                        : `Powered by ${analysis?.modelUsed}`}
                    </p>
                  </div>
                </div>

                {analysis?.executiveSummary && (
                  <p className="mb-4 text-sm text-[var(--color-ink-soft)] leading-relaxed">{analysis.executiveSummary}</p>
                )}

                {/* Revenue reconciliation */}
                {hasRevenueGap && (
                  <div className="mb-4 border-l-2 border-purple-300 bg-purple-50/40 px-3 py-2 text-xs">
                    <p className="text-purple-800 font-medium mb-0.5">Note on numbers</p>
                    <p className="text-purple-700">
                      The KPI cards use the canonical total revenue of {formatNaira(totalRevenue)}.
                      AI insight text above may reference a different aggregation
                      {gapDir === '-' ? ` (the monthly chart sums to ${formatNaira(monthlySum)}, which exceeds the KPI total by ${formatNaira(gap)} — likely because the overview nets out returns or voided transactions).` : ` (the monthly chart sums to ${formatNaira(monthlySum)}, ₦${gap.toLocaleString()} below the KPI total).`}
                    </p>
                  </div>
                )}

                <div className="space-y-3">
                  {insights.map((insight, i) => (
                    <InsightCard key={i} insight={insight} />
                  ))}
                </div>
              </div>
            )}

            {/* Charts Row */}
            <div className="mb-8 grid gap-6 lg:grid-cols-2">
              {/* Revenue Trend */}
              <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
                <h3 className="mb-1 text-base font-semibold text-[var(--color-ink)]">
                  {hasMonthly ? 'Monthly Revenue' : 'Revenue Overview'}
                </h3>
                <p className="mb-4 text-xs text-[var(--color-ink-faint)]">
                  {hasMonthly
                    ? `${monthlyRevenue.length} months of data${gapDir === '+' ? ` + ₦${gap.toLocaleString()} unattributed` : gapDir === '-' ? ` (KPI ₦${gap.toLocaleString()} below chart sum)` : ''}`
                    : 'Single-period summary'}
                </p>
                {gapDir === '+' && (
                  <div className="mb-3 border-l-2 border-gray-300 bg-gray-50/60 px-3 py-1.5 text-xs">
                    <span className="font-semibold text-gray-600">Chart reconciliation: </span>
                    <span className="text-gray-500">{formatNaira(gap)}</span>
                    <span className="text-gray-400"> unattributed — rows with unparseable dates dropped from time series</span>
                    <br />
                    <span className="text-gray-400">Chart sum: {formatNaira(monthlySum)} + KPI total: {formatNaira(totalRevenue)}</span>
                  </div>
                )}
                {gapDir === '-' && (
                  <div className="mb-3 border-l-2 border-amber-400 bg-amber-50/60 px-3 py-1.5 text-xs">
                    <span className="font-semibold text-warning">KPI adjustment: </span>
                    <span className="text-warning">overview total is {formatNaira(gap)} below monthly chart sum</span>
                    <br />
                    <span className="text-gray-400">Chart sum: {formatNaira(monthlySum)} — KPI total: {formatNaira(totalRevenue)} (likely excludes returns/voids)</span>
                  </div>
                )}
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    {hasMonthly ? (
                      <LineChart data={monthlyRevenueWithGap} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                        <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'} />
                        <Tooltip content={<CustomTooltip />} />
                        <Line type="monotone" dataKey="revenue" stroke="var(--color-primary)" strokeWidth={2.5}
                          dot={(props) => {
                            const { cx, cy, payload } = props;
                            if (payload.isUnknown) {
                              return <circle cx={cx} cy={cy} r={5} fill="#f3f4f6" stroke="#9ca3af" strokeWidth={2} strokeDasharray="3 2" />;
                            }
                            return <circle cx={cx} cy={cy} r={3} fill="var(--color-surface)" stroke="var(--color-primary)" strokeWidth={2.5} />;
                          }}
                          activeDot={{ r: 5 }} />
                      </LineChart>
                    ) : (
                      <BarChart data={[{ name: 'Total', revenue: totalRevenue }]} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-faint)' }} tickFormatter={(v) => '₦' + (v / 1000).toFixed(0) + 'k'} />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="revenue" fill="var(--color-primary)" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Payment Mix */}
              {pay?.methods && pay.methods.length > 0 && (
                <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
                  <h3 className="mb-1 text-base font-semibold text-[var(--color-ink)]">Payment Mix</h3>
                  <p className="mb-4 text-xs text-[var(--color-ink-faint)]">
                    {pay.totalWithPaymentMethod} transactions with payment data
                  </p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pay.methods} dataKey="count" nameKey="method" cx="50%" cy="50%"
                          outerRadius={90} innerRadius={50} paddingAngle={2}>
                          {pay.methods.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload;
                            return (
                              <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
                                <p className="text-xs font-semibold text-[var(--color-ink)]">{d.method}</p>
                                <p className="font-mono text-sm">{d.count} txns ({d.share}%)</p>
                                <p className="font-mono text-xs text-[var(--color-ink-faint)]">{formatNaira(d.revenue)}</p>
                              </div>
                            );
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  {pay.cashVsDigital && (
                    <div className="mt-3 flex gap-4 text-xs">
                      <span className="text-[var(--color-ink-faint)]">Cash: <strong>{pay.cashVsDigital.cashShare}%</strong></span>
                      <span className="text-[var(--color-ink-faint)]">Digital: <strong>{pay.cashVsDigital.digitalShare}%</strong></span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Product Rankings */}
            <div className="mb-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] overflow-hidden">
              <div className="px-6 py-5">
                <h3 className="text-base font-semibold text-[var(--color-ink)]">Top Products</h3>
                {top3Pct != null && (
                  <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                    Top 3 products = {top3Pct}% of revenue
                    {top3Pct > 30 && (
                      <span className="ml-2 text-warning font-semibold">— Concentration risk</span>
                    )}
                  </p>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-t border-[var(--color-line)] bg-[var(--color-bg-alt)]">
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">#</th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Product</th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] text-right">Revenue</th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] text-right">Share</th>
                      <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] text-right">Qty</th>
                      {topProducts.some((pr) => pr.margin != null) && (
                        <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] text-right">Margin</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {topProducts.slice(0, 15).map((pr, i) => (
                      <tr key={pr.name} className="border-t border-[var(--color-line)] hover:bg-[var(--color-bg-alt)] transition-colors">
                        <td className="px-5 py-3 font-mono text-xs text-[var(--color-ink-faint)]">{i + 1}</td>
                        <td className="px-5 py-3 text-sm font-medium text-[var(--color-ink)] max-w-[220px] truncate" title={pr.name}>{pr.name}</td>
                        <td className="px-5 py-3 font-mono text-sm font-semibold text-[var(--color-ink)] text-right">{formatNaira(pr.revenue)}</td>
                        <td className="px-5 py-3 font-mono text-xs text-[var(--color-ink-soft)] text-right">{formatPercent(pr.revenueShare)}</td>
                        <td className="px-5 py-3 font-mono text-xs text-[var(--color-ink-soft)] text-right">{formatNumber(pr.quantity)}</td>
                        {topProducts.some((p) => p.margin != null) && (
                          <td className={`px-5 py-3 font-mono text-xs font-semibold text-right ${pr.margin != null && pr.margin < 15 ? 'text-red-600' : pr.margin != null && pr.margin > 35 ? 'text-emerald-600' : 'text-[var(--color-ink-soft)]'}`}>
                            {formatPercent(pr.margin)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* Non-overview tabs with no widget manifest yet (legacy flow, edge case) */}
        {activeNav !== 'overview' && activeNav !== 'advisor' && activeNav !== 'reports' && activeNav !== 'settings' && !widgetManifest && (
          <p className="text-sm text-[var(--color-ink-faint)]">
            Detailed drill-downs need the full widget data. Switch to Overview and click "Load All Data", then come back.
          </p>
        )}

        {/* ================================================================ */}
        {/*   Settings — pharmacy profile (state, for weather insights)       */}
        {/* ================================================================ */}
        {activeNav === 'settings' && <SettingsPanel />}

        {/* ================================================================ */}
        {/*   Reports — data health / pipeline diagnostics + export           */}
        {/* ================================================================ */}
        {activeNav === 'reports' && !health && (
          <p className="text-sm text-[var(--color-ink-faint)]">
            Data health diagnostics are available after analyzing a file through the Upload flow.
          </p>
        )}
        {activeNav === 'reports' && health && (
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-5 w-1 rounded-full bg-slate-400" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">Data Health & Pipeline</h2>
            </div>

            {/* Pipeline Stages — Step-wise */}
            {health.pipelineStages && (
              <div className="mb-5">
                <p className="text-xs font-semibold text-[var(--color-ink-soft)] uppercase tracking-wide mb-3">Pipeline Stages</p>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-600">
                      Uploaded <span className="font-mono text-slate-800 ml-1">{formatNumber(health.pipelineStages.uploadedRows)}</span>
                    </span>
                    <span className="text-[var(--color-ink-faint)] text-xs">→</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-[11px] font-semibold text-blue-600">
                      Parsed <span className="font-mono text-blue-800 ml-1">{formatNumber(health.pipelineStages.parsedRows)}</span>
                    </span>
                    <span className="text-[var(--color-ink-faint)] text-xs">→</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1.5 text-[11px] font-semibold text-violet-600">
                      Structurally Valid <span className="font-mono text-violet-800 ml-1">{formatNumber(health.pipelineStages.structurallyValidRows)}</span>
                    </span>
                    <span className="text-[var(--color-ink-faint)] text-xs">→</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold ${health.pipelineStages.businessValidRows < health.pipelineStages.structurallyValidRows ? 'bg-amber-50 text-warning' : 'bg-success/10 text-success'}`}>
                      Business Valid <span className="font-mono ml-1">{formatNumber(health.pipelineStages.businessValidRows)}</span>
                    </span>
                    <span className="text-[var(--color-ink-faint)] text-xs">→</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold ${health.pipelineStages.rowsUsedForAnalytics < health.pipelineStages.uploadedRows ? 'bg-amber-50 text-warning' : 'bg-success/10 text-success'}`}>
                      Used <span className="font-mono ml-1">{formatNumber(health.pipelineStages.rowsUsedForAnalytics)}</span>
                    </span>
                  </div>
                  {health.pipelineStages.rowsExcluded > 0 && (
                    <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600">
                        {formatNumber(health.pipelineStages.rowsExcluded)} excluded
                      </span>
                      {health.pipelineStages.duplicatesRemoved > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-warning">
                          {formatNumber(health.pipelineStages.duplicatesRemoved)} duplicates
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Structural vs Business Issues */}
            <div className="mb-5 grid gap-4 sm:grid-cols-2">
              {health.structuralIssues && Object.keys(health.structuralIssues).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Structural Issues ({health.structuralTotal || 0})</p>
                  <div className="space-y-1">
                    {Object.entries(health.structuralIssues || {}).slice(0, 5).map(([cat, count]) => (
                      <div key={cat} className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">{cat}</span>
                        <span className="font-mono text-red-600">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {health.derivedBusinessIssues && health.derivedBusinessIssues.total > 0 && (
                <div>
                  <p className="text-xs font-semibold text-warning uppercase tracking-wide mb-2">Business Issues ({health.derivedBusinessIssues.total})</p>
                  <div className="space-y-1">
                    {health.derivedBusinessIssues.revenueExcluded > 0 && (
                      <div className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">Revenue Metrics</span>
                        <span className="font-mono text-warning">{health.derivedBusinessIssues.revenueExcluded}</span>
                      </div>
                    )}
                    {health.derivedBusinessIssues.quantityExcluded > 0 && (
                      <div className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">Quantity Metrics</span>
                        <span className="font-mono text-warning">{health.derivedBusinessIssues.quantityExcluded}</span>
                      </div>
                    )}
                    {health.derivedBusinessIssues.trendsExcluded > 0 && (
                      <div className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">Trends</span>
                        <span className="font-mono text-warning">{health.derivedBusinessIssues.trendsExcluded}</span>
                      </div>
                    )}
                    {health.derivedBusinessIssues.productExcluded > 0 && (
                      <div className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">Product Breakdown</span>
                        <span className="font-mono text-warning">{health.derivedBusinessIssues.productExcluded}</span>
                      </div>
                    )}
                    {health.derivedBusinessIssues.profitExcluded > 0 && (
                      <div className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">Profitability</span>
                        <span className="font-mono text-warning">{health.derivedBusinessIssues.profitExcluded}</span>
                      </div>
                    )}
                    {health.derivedBusinessIssues.paymentExcluded > 0 && (
                      <div className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">Payment Breakdown</span>
                        <span className="font-mono text-warning">{health.derivedBusinessIssues.paymentExcluded}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {(!health.derivedBusinessIssues || health.derivedBusinessIssues.total === 0) && Object.keys(health.businessIssues || {}).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-warning uppercase tracking-wide mb-2">Business Issues ({health.businessTotal || 0})</p>
                  <div className="space-y-1">
                    {Object.entries(health.businessIssues || {}).slice(0, 5).map(([cat, count]) => (
                      <div key={cat} className="flex justify-between text-[11px]">
                        <span className="text-[var(--color-ink-faint)]">{cat}</span>
                        <span className="font-mono text-warning">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Metrics */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-[var(--color-ink-faint)]">Records</p>
                <p className="font-mono text-sm font-semibold">{formatNumber(health.totalRecords)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-ink-faint)]">Product Recognition</p>
                <p className={`font-mono text-sm font-semibold ${health.productRecognition?.recognitionRate < 80 ? 'text-warning' : 'text-emerald-600'}`}>
                  {formatPercent(health.productRecognition?.recognitionRate)}
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-ink-faint)]">Quality Score</p>
                <p className={`font-mono text-sm font-semibold ${health.overallCompleteness < 80 ? 'text-warning' : 'text-emerald-600'}`}>
                  {formatPercent(health.overallCompleteness)}
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-ink-faint)]">Structural + Business</p>
                <p className={'font-mono text-sm font-semibold ' + ((health.structuralTotal || 0) + (health.businessTotal || 0) > 0 ? 'text-warning' : 'text-emerald-600')}>
                  {(health.structuralTotal || 0) + (health.businessTotal || 0)} issues
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-5">
              <div className="text-xs text-[var(--color-ink-faint)]">
                Product: <span className="font-semibold text-[var(--color-ink)]">{formatPercent(health.dataCompleteness?.productName)}</span>
              </div>
              <div className="text-xs text-[var(--color-ink-faint)]">
                Qty: <span className="font-semibold text-[var(--color-ink)]">{formatPercent(health.dataCompleteness?.quantity)}</span>
              </div>
              <div className="text-xs text-[var(--color-ink-faint)]">
                Revenue: <span className="font-semibold text-[var(--color-ink)]">{formatPercent(health.dataCompleteness?.revenue)}</span>
              </div>
              <div className="text-xs text-[var(--color-ink-faint)]">
                Date: <span className="font-semibold text-[var(--color-ink)]">{formatPercent(health.dataCompleteness?.date)}</span>
              </div>
              <div className="text-xs text-[var(--color-ink-faint)]">
                Cost: <span className="font-semibold text-[var(--color-ink)]">{formatPercent(health.dataCompleteness?.costPrice)}</span>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>

      {tourOpen && (
        <ProductTour steps={TOUR_STEPS} userKey={tourKey} onFinish={() => setTourOpen(false)} />
      )}
    </div>
  );
}
