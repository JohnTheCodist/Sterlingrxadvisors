/**
 * McKinsey-quality analytics insights.
 *
 * Five analytical views built from the star schema:
 *   1. Gross Profit by Category
 *   2. ABC Analysis (Pareto — top products by revenue/profit contribution)
 *   3. Inventory Turnover
 *   4. Fast vs. Slow Movers
 *   5. Expiry / Discontinuation Summary
 */

function getDb() {
  return require('./database').getDb();
}

// ────────────────────────────────────────────
// 1. Gross Profit by Category
// ────────────────────────────────────────────

function profitByCategory() {
  const db = getDb();
  return db.prepare(`
    SELECT
      COALESCE(p.category, 'Uncategorised') AS category,
      COUNT(DISTINCT p.id)                   AS productCount,
      SUM(f.unit_price * f.quantity)         AS revenue,
      SUM(f.unit_cost * f.quantity)          AS cost,
      SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit,
      CASE WHEN SUM(f.unit_price * f.quantity) > 0
           THEN ROUND(SUM((f.unit_price - f.unit_cost) * f.quantity)
                      / SUM(f.unit_price * f.quantity) * 100, 1)
           ELSE 0 END                         AS marginPct,
      SUM(f.quantity)                         AS unitsSold
    FROM fact_sales f
    JOIN dim_product p ON f.product_id = p.id
    GROUP BY p.category
    ORDER BY profit DESC
  `).all();
}

// ────────────────────────────────────────────
// 2. ABC Analysis (Pareto)
//    A = top ~20% of products by revenue (cumulative ≥ 80%)
//    B = next ~30%
//    C = remainder
// ────────────────────────────────────────────

function abcAnalysis() {
  const db = getDb();

  // Get all products with their revenue
  const products = db.prepare(`
    SELECT
      p.id,
      p.name,
      COALESCE(p.category, 'Uncategorised') AS category,
      SUM(f.unit_price * f.quantity)         AS revenue,
      SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit,
      SUM(f.quantity)                         AS unitsSold
    FROM fact_sales f
    JOIN dim_product p ON f.product_id = p.id
    GROUP BY p.id
    ORDER BY revenue DESC
  `).all();

  if (products.length === 0) return [];

  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalProfit = products.reduce((s, p) => s + (p.profit || 0), 0);

  let cumRev = 0;
  let cumProfit = 0;

  return products.map((p) => {
    cumRev += p.revenue;
    cumProfit += (p.profit || 0);
    const cumRevPct = totalRevenue > 0 ? cumRev / totalRevenue * 100 : 0;
    const cumProfitPct = totalProfit > 0 ? cumProfit / totalProfit * 100 : 0;

    let abcClass = 'C';
    if (cumRevPct <= 80) abcClass = 'A';
    else if (cumRevPct <= 95) abcClass = 'B';

    return {
      ...p,
      revenuePct: totalRevenue > 0 ? Math.round(p.revenue / totalRevenue * 10000) / 100 : 0,
      profitPct: totalProfit > 0 ? Math.round((p.profit || 0) / totalProfit * 10000) / 100 : 0,
      cumulativeRevenuePct: Math.round(cumRevPct * 100) / 100,
      cumulativeProfitPct: Math.round(cumProfitPct * 100) / 100,
      abcClass,
    };
  });
}

/**
 * ABC summary: count and revenue share per class.
 */
function abcSummary() {
  const items = abcAnalysis();
  const summary = { A: { count: 0, revenue: 0, profit: 0 },
                    B: { count: 0, revenue: 0, profit: 0 },
                    C: { count: 0, revenue: 0, profit: 0 } };
  for (const p of items) {
    summary[p.abcClass].count++;
    summary[p.abcClass].revenue += p.revenue;
    summary[p.abcClass].profit += (p.profit || 0);
  }
  const totalRev = summary.A.revenue + summary.B.revenue + summary.C.revenue;
  for (const cls of ['A', 'B', 'C']) {
    summary[cls].revenueShare = totalRev > 0
      ? Math.round(summary[cls].revenue / totalRev * 10000) / 100
      : 0;
  }
  return summary;
}

// ────────────────────────────────────────────
// 3. Inventory Turnover
//    Turnover = COGS / Average Inventory
//    Average Inventory = (ListPriceEUR + StandardCostEUR) / 2
//    (Simplified from available data; in production this uses stock levels)
// ────────────────────────────────────────────

function inventoryTurnover() {
  const db = getDb();
  return db.prepare(`
    WITH sales AS (
      SELECT
        f.product_id,
        SUM(f.quantity)                        AS unitsSold,
        SUM(f.unit_cost * f.quantity)          AS cogs,
        SUM(f.unit_price * f.quantity)         AS revenue
      FROM fact_sales f
      GROUP BY f.product_id
    )
    SELECT
      p.name,
      COALESCE(p.category, 'Uncategorised') AS category,
      s.unitsSold,
      s.cogs,
      s.revenue,
      COALESCE(p.StandardCostEUR, p.ListPriceEUR, 0) AS unitCost,
      -- Avg inventory: use standard cost as proxy
      -- Turnover ratio: units sold per period / estimated average stock
      CASE WHEN p.StandardCostEUR > 0
           THEN ROUND(s.unitsSold * 1.0 / (p.StandardCostEUR + 1), 2)
           ELSE 0
      END AS turnoverRatio
    FROM sales s
    JOIN dim_product p ON s.product_id = p.id
    ORDER BY s.unitsSold DESC
  `).all();
}

// ────────────────────────────────────────────
// 4. Fast vs. Slow Movers
//    Classifies products by sales velocity (units sold per unique calendar day)
// ────────────────────────────────────────────

function fastSlowMovers() {
  const db = getDb();
  const rows = db.prepare(`
    WITH product_sales AS (
      SELECT
        f.product_id,
        SUM(f.quantity)                     AS totalUnitsSold,
        SUM(f.unit_price * f.quantity)      AS totalRevenue,
        COUNT(DISTINCT f.calendar_id)       AS activeDays
      FROM fact_sales f
      GROUP BY f.product_id
    )
    SELECT
      p.name,
      COALESCE(p.category, 'Uncategorised') AS category,
      ps.totalUnitsSold,
      ps.totalRevenue,
      ps.activeDays,
      ROUND(ps.totalUnitsSold * 1.0 / NULLIF(ps.activeDays, 0), 2) AS velocity,
      ps.totalUnitsSold * 1.0 / NULLIF(ps.activeDays, 0)           AS rawVelocity
    FROM product_sales ps
    JOIN dim_product p ON ps.product_id = p.id
    ORDER BY rawVelocity DESC
  `).all();

  if (rows.length === 0) return [];

  // Classification thresholds (percentile-based)
  const velocities = rows.map(r => r.rawVelocity).sort((a, b) => a - b);
  const p70 = velocities[Math.floor(velocities.length * 0.7)];
  const p30 = velocities[Math.floor(velocities.length * 0.3)];

  return rows.map(r => ({
    ...r,
    classification: r.rawVelocity >= p70 ? 'Fast' :
                    r.rawVelocity >= p30 ? 'Medium' : 'Slow',
  }));
}

/**
 * Summary counts for fast / medium / slow.
 */
function fastSlowSummary() {
  const items = fastSlowMovers();
  const summary = { Fast: 0, Medium: 0, Slow: 0 };
  for (const item of items) {
    summary[item.classification]++;
  }
  return summary;
}

// ────────────────────────────────────────────
// 5. Expiry / Discontinuation Summary
//    Products marked IsDiscontinued or approaching DiscontinuedDate
// ────────────────────────────────────────────

function expirySummary() {
  const db = getDb();

  // Get all products with their discontinuation status
  const products = db.prepare(`
    SELECT
      id, name, category, LaunchDate, IsDiscontinued, DiscontinuedDate
    FROM dim_product
    ORDER BY
      CASE WHEN IsDiscontinued = 'Yes' THEN 0 ELSE 1 END,
      DiscontinuedDate ASC
  `).all();

  const now = new Date();
  const ninetyDaysFromNow = new Date(now.getTime() + 90 * 86400000);
  const todayStr = now.toISOString().substring(0, 10);
  const ninetyStr = ninetyDaysFromNow.toISOString().substring(0, 10);

  return products.map(p => {
    let status = 'Active';
    let riskLevel = 'none';

    if (p.IsDiscontinued === 'Yes' && p.DiscontinuedDate) {
      if (p.DiscontinuedDate <= todayStr) {
        status = 'Discontinued';
        riskLevel = 'high';
      } else if (p.DiscontinuedDate <= ninetyStr) {
        status = 'Discontinuing Soon';
        riskLevel = 'medium';
      } else {
        status = 'Discontinued (future)';
        riskLevel = 'low';
      }
    } else if (p.IsDiscontinued === 'Yes') {
      status = 'Discontinued';
      riskLevel = 'high';
    }

    return { ...p, status, riskLevel };
  });
}

// ────────────────────────────────────────────
// Combined report
// ────────────────────────────────────────────

function fullInsights() {
  return {
    profitByCategory: profitByCategory(),
    abcSummary: abcSummary(),
    abcTopA: abcAnalysis().filter(p => p.abcClass === 'A').slice(0, 20),
    inventoryTurnover: inventoryTurnover().slice(0, 20),
    fastSlowSummary: fastSlowSummary(),
    fastSlowMovers: fastSlowMovers().slice(0, 20),
    expirySummary: expirySummary(),
  };
}

module.exports = {
  profitByCategory,
  abcAnalysis,
  abcSummary,
  inventoryTurnover,
  fastSlowMovers,
  fastSlowSummary,
  expirySummary,
  fullInsights,
};
