// metrics.js — Single source of truth for ALL derived dashboard metrics.
// Every panel, card, widget, and insight text that needs a derived number
// calls the functions in this module. This guarantees consistency across
// the dashboard and prevents the class of bugs where two panels compute
// the same metric from different inputs.
//
// All functions are pure: they take API data objects and return numbers.
// The caller decides how to format/display them.

/**
 * Pick the most accurate total-revenue value from all available sources.
 *
 * Priority (highest to lowest):
 *  1. overview.totalRevenue  — server-authoritative, single aggregation point
 *  2. sum of tracked months   — usable even when overview isn't available
 *  3. widget-level revenue    — last resort
 *
 * Returns a stable number (never NaN, never undefined).
 */
export function pickTotalRevenue({ overview, trends, monthlyRevenue, widgetTotal } = {}) {
  const fromOverview = overview?.totalRevenue;
  const fromMonths = monthlyRevenue?.reduce((s, m) => s + (m.revenue || 0), 0);
  const fromTrends = trends?.totalRevenue;
  const fromWidget = widgetTotal;

  if (fromOverview != null && fromOverview > 0) return fromOverview;
  if (fromMonths != null && fromMonths > 0) return fromMonths;
  if (fromTrends != null && fromTrends > 0) return fromTrends;
  return fromWidget || 0;
}

/**
 * Average transaction value: total revenue divided by transaction count.
 */
export function avgTransactionValue({ totalRevenue, transactionCount }) {
  if (!transactionCount || !totalRevenue) return null;
  return totalRevenue / transactionCount;
}

/**
 * Top-N revenue concentration as a percentage of total revenue.
 * E.g. top3Pct({ products, totalRevenue }) returns 71 (not 0.71).
 */
export function topConcentration({ products, totalRevenue, n = 3 }) {
  if (!products?.length || !totalRevenue) return null;
  const topNRevenue = products.slice(0, n).reduce((s, p) => s + (p.revenue || 0), 0);
  return Math.round((topNRevenue / totalRevenue) * 100);
}

/**
 * Detect the gap between the canonical total revenue and the sum of
 * time-series chart data.
 *
 * Positive: chart sum is below KPI total — rows with unparseable dates
 *           were dropped from the monthly breakdown ("unattributed").
 * Negative: chart sum exceeds KPI total — the overview has adjustments
 *           like returns / voids that the monthly chart does not reflect.
 *
 * Returns { gap, chartSum, direction } where direction is '+' or '-'.
 */
export function revenueGap({ totalRevenue, monthlyRevenue }) {
  if (!monthlyRevenue?.length) return { gap: 0, chartSum: 0, direction: null };
  const chartSum = monthlyRevenue.reduce((s, m) => s + (m.revenue || 0), 0);
  const rawGap = totalRevenue - chartSum;
  const absGap = Math.abs(rawGap);
  // ignore sub-naira floating noise (< 1 naira)
  if (absGap < 1) return { gap: 0, chartSum, direction: null };
  return {
    gap: absGap,
    chartSum,
    direction: rawGap > 0 ? '+' : '-',
  };
}

/**
 * Augment monthly revenue array with an "Unknown" bucket for the gap,
 * so chart totals always reconcile with KPI totals.
 */
export function monthlyRevenueWithGap({ totalRevenue, monthlyRevenue }) {
  if (!monthlyRevenue?.length) return monthlyRevenue || [];
  const { gap, direction } = revenueGap({ totalRevenue, monthlyRevenue });
  // Only add an Unknown bar for positive gaps (chart < KPI — missing rows)
  if (!gap || direction !== '+') return monthlyRevenue;
  return [...monthlyRevenue, { month: 'Unknown', revenue: gap, isUnknown: true }];
}

// --------------- Validation / cross-check helpers ---------------

/**
 * Log warnings when independent sources disagree by more than a threshold.
 * Call this once at dashboard load to surface data-quality issues.
 */
export function validateMetricConsistency({ overview, trends, monthlyRevenue, products, topProducts } = {}) {
  const canonical = pickTotalRevenue({ overview, trends, monthlyRevenue });

  if (trends?.totalRevenue && canonical > 0) {
    const diff = Math.abs(canonical - trends.totalRevenue) / canonical;
    if (diff > 0.001) {
      console.warn(
        `[metrics] totalRevenue mismatch: overview=${canonical} vs trends=${trends.totalRevenue} (${(diff * 100).toFixed(1)}% off)`
      );
    }
  }

  if (monthlyRevenue?.length) {
    const { gap, chartSum, direction } = revenueGap({ totalRevenue: canonical, monthlyRevenue });
    if (gap > 0 && canonical > 0) {
      const pct = ((gap / canonical) * 100).toFixed(1);
      if (direction === '+') {
        console.warn(
          `[metrics] Monthly chart sum (${chartSum}) is ${pct}% below KPI total (${canonical}) — ${gap} unattributed (unparseable dates?)`
        );
      } else {
        console.warn(
          `[metrics] KPI total (${canonical}) is ${pct}% below monthly chart sum (${chartSum}) — net adjustments (returns/voids?)`
        );
      }
    }
  }

  // Check top-N concentration from products vs server-reported value
  if (products?.revenueConcentration?.top3 && topProducts?.length >= 3 && canonical > 0) {
    const computed = topConcentration({ products: topProducts, totalRevenue: canonical, n: 3 });
    const server = Number(products.revenueConcentration.top3);
    if (Math.abs(computed - server) > 1) {
      console.warn(
        `[metrics] top3 concentration: client-derived=${computed}% vs server-reported=${server}%`
      );
    }
  }

  return true;
}
