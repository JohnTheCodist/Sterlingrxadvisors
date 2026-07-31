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

const { getSql, assertOrgId } = require('./db');

// ────────────────────────────────────────────
// 1. Gross Profit by Category
// ────────────────────────────────────────────

// A handful of cost-tagged rows within a category shouldn't produce a
// confident-looking margin for that category — same threshold and
// reasoning as analytics.js::profitLeakage and db.js::queryAnalytics.
const MIN_CATEGORY_COST_COVERAGE_PCT = 20;

async function profitByCategory(organizationId, { datasetId } = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  let where = db`s.organization_id = ${organizationId}`;
  if (datasetId) where = db`${where} and s.dataset_id = ${datasetId}`;
  const rows = await db`
    select
      coalesce(p.category, 'Uncategorised') as category,
      count(distinct p.id) as "productCount",
      count(*)::int as "rowCount",
      sum(s.unit_price * s.quantity) as revenue,
      sum(s.quantity) as "unitsSold",
      count(*) filter (where s.unit_cost is not null)::int as "rowsWithCost",
      coalesce(sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null), 0) as "revenueWithCost",
      sum(s.unit_cost * s.quantity) filter (where s.unit_cost is not null) as cost,
      sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null) as profit,
      case when sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null) > 0
           then round((sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null)
             / sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null) * 100)::numeric, 1)
           else null end as "marginPct"
    from sale s
    join product p on s.product_id = p.id
    where ${where}
    group by p.category
    order by revenue desc
  `;

  // Numerator (profit) and denominator (marginPct's revenue base) are both
  // already restricted to cost-known rows above — a plain profit/revenue
  // division would silently deflate the figure by dividing known profit by
  // ALL revenue (including cost-unknown rows). But even that cost-known
  // subset can be too small to trust: a category with cost data on 2 of 100
  // rows would still report a specific-looking margin for those 2 rows
  // alone. Gate on coverage before exposing cost/profit/marginPct at all.
  return rows.map((r) => {
    const revenue = Number(r.revenue) || 0;
    const rowCount = Number(r.rowCount) || 0;
    const rowsWithCost = Number(r.rowsWithCost) || 0;
    const revenueWithCost = Number(r.revenueWithCost) || 0;
    const rowsPct = rowCount > 0 ? Math.round((rowsWithCost / rowCount) * 1000) / 10 : 0;
    const revenuePct = revenue > 0 ? Math.round((revenueWithCost / revenue) * 1000) / 10 : 0;
    const hasReliableCostCoverage = rowsPct >= MIN_CATEGORY_COST_COVERAGE_PCT && revenuePct >= MIN_CATEGORY_COST_COVERAGE_PCT;
    return {
      category: r.category,
      productCount: Number(r.productCount),
      revenue,
      unitsSold: Number(r.unitsSold),
      cost: hasReliableCostCoverage && r.cost != null ? Number(r.cost) : null,
      profit: hasReliableCostCoverage && r.profit != null ? Number(r.profit) : null,
      marginPct: hasReliableCostCoverage && r.marginPct != null ? Number(r.marginPct) : null,
      costCoverage: { hasReliableCostCoverage, rowsWithCost, rowCount, revenuePct, rowsPct },
    };
  }).sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
}

// ────────────────────────────────────────────
// 2. ABC Analysis (Pareto)
//    A = top ~20% of products by revenue (cumulative ≥ 80%)
//    B = next ~30%
//    C = remainder
// ────────────────────────────────────────────

async function abcAnalysis(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();

  const products = await db`
    select
      p.id,
      p.name,
      coalesce(p.category, 'Uncategorised') as category,
      sum(s.unit_price * s.quantity) as revenue,
      count(*)::int as "rowCount",
      count(*) filter (where s.unit_cost is not null)::int as "rowsWithCost",
      coalesce(sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null), 0) as "revenueWithCost",
      sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null) as profit,
      sum(s.quantity) as "unitsSold"
    from sale s
    join product p on s.product_id = p.id
    where s.organization_id = ${organizationId}
    group by p.id, p.name, p.category
    order by revenue desc
  `;

  if (products.length === 0) return [];

  // Resolve each product's profit to a number or to null — never to 0. `profit`
  // only sums cost-known rows, so a product with no cost price at all used to
  // be coerced to 0 and became indistinguishable from one genuinely selling at
  // cost. ABC classification is driven by revenue and is unaffected by this.
  const resolved = products.map((p) => {
    const revenue = Number(p.revenue) || 0;
    const rowCount = Number(p.rowCount) || 0;
    const rowsWithCost = Number(p.rowsWithCost) || 0;
    const revenueWithCost = Number(p.revenueWithCost) || 0;
    const rowsPct = rowCount > 0 ? Math.round((rowsWithCost / rowCount) * 1000) / 10 : 0;
    const revenuePct = revenue > 0 ? Math.round((revenueWithCost / revenue) * 1000) / 10 : 0;
    const reliable = rowsPct >= MIN_CATEGORY_COST_COVERAGE_PCT && revenuePct >= MIN_CATEGORY_COST_COVERAGE_PCT;
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      revenue,
      profit: reliable && p.profit != null ? Number(p.profit) : null,
      unitsSold: Number(p.unitsSold),
      costCoverage: { hasReliableCostCoverage: reliable, rowsWithCost, rowCount, revenuePct, rowsPct },
    };
  });

  const totalRevenue = resolved.reduce((s, p) => s + p.revenue, 0);
  // Profit shares are shares of KNOWN profit — products without cost data are
  // excluded from the base rather than counted as contributing zero.
  const totalProfit = resolved.reduce((s, p) => s + (p.profit ?? 0), 0);

  let cumRev = 0;
  let cumProfit = 0;

  return resolved.map((p) => {
    cumRev += p.revenue;
    if (p.profit != null) cumProfit += p.profit;
    const cumRevPct = totalRevenue > 0 ? (cumRev / totalRevenue) * 100 : 0;
    const cumProfitPct = totalProfit > 0 ? (cumProfit / totalProfit) * 100 : 0;

    let abcClass = 'C';
    if (cumRevPct <= 80) abcClass = 'A';
    else if (cumRevPct <= 95) abcClass = 'B';

    return {
      ...p,
      revenuePct: totalRevenue > 0 ? Math.round((p.revenue / totalRevenue) * 10000) / 100 : 0,
      profitPct: p.profit != null && totalProfit > 0 ? Math.round((p.profit / totalProfit) * 10000) / 100 : null,
      cumulativeRevenuePct: Math.round(cumRevPct * 100) / 100,
      cumulativeProfitPct: Math.round(cumProfitPct * 100) / 100,
      abcClass,
    };
  });
}

/**
 * ABC summary: count and revenue share per class.
 */
async function abcSummary(organizationId) {
  const items = await abcAnalysis(organizationId);
  const summary = {
    A: { count: 0, revenue: 0, profit: 0, productsWithCost: 0 },
    B: { count: 0, revenue: 0, profit: 0, productsWithCost: 0 },
    C: { count: 0, revenue: 0, profit: 0, productsWithCost: 0 },
  };
  for (const p of items) {
    summary[p.abcClass].count++;
    summary[p.abcClass].revenue += p.revenue;
    if (p.profit != null) {
      summary[p.abcClass].profit += p.profit;
      summary[p.abcClass].productsWithCost++;
    }
  }
  const totalRev = summary.A.revenue + summary.B.revenue + summary.C.revenue;
  for (const cls of ['A', 'B', 'C']) {
    summary[cls].revenueShare = totalRev > 0
      ? Math.round((summary[cls].revenue / totalRev) * 10000) / 100
      : 0;
    // A class whose products all lack cost data has no profit to report —
    // saying 0 would read as "these products earn nothing."
    if (summary[cls].productsWithCost === 0) summary[cls].profit = null;
  }
  return summary;
}

// ────────────────────────────────────────────
// 3. Inventory Turnover
//    Turnover = COGS / Average Inventory
//    Average Inventory = (ListPrice + StandardCost) / 2
//    (Simplified from available data; in production this uses stock levels)
// ────────────────────────────────────────────

async function inventoryTurnover(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    with sales as (
      select
        s.product_id,
        sum(s.quantity) as "unitsSold",
        sum(s.unit_cost * s.quantity) as cogs,
        sum(s.unit_price * s.quantity) as revenue
      from sale s
      where s.organization_id = ${organizationId}
      group by s.product_id
    )
    select
      p.name,
      coalesce(p.category, 'Uncategorised') as category,
      sales."unitsSold",
      sales.cogs,
      sales.revenue,
      coalesce(p.standard_cost, p.list_price, 0) as "unitCost",
      case when p.standard_cost > 0
           then round((sales."unitsSold" / (p.standard_cost + 1))::numeric, 2)
           else 0
      end as "turnoverRatio"
    from sales
    join product p on sales.product_id = p.id
    order by sales."unitsSold" desc
  `;
  return rows.map((r) => ({
    ...r,
    unitsSold: Number(r.unitsSold),
    cogs: r.cogs != null ? Number(r.cogs) : null,
    revenue: r.revenue != null ? Number(r.revenue) : null,
    unitCost: Number(r.unitCost),
    turnoverRatio: Number(r.turnoverRatio),
  }));
}

// ────────────────────────────────────────────
// 4. Fast vs. Slow Movers
//    Classifies products by sales velocity (units sold per unique sale day)
// ────────────────────────────────────────────

async function fastSlowMovers(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const raw = await db`
    with product_sales as (
      select
        s.product_id,
        sum(s.quantity) as "totalUnitsSold",
        sum(s.unit_price * s.quantity) as "totalRevenue",
        count(distinct s.sale_date) as "activeDays"
      from sale s
      where s.organization_id = ${organizationId}
      group by s.product_id
    )
    select
      p.name,
      coalesce(p.category, 'Uncategorised') as category,
      ps."totalUnitsSold",
      ps."totalRevenue",
      ps."activeDays",
      round((ps."totalUnitsSold" / nullif(ps."activeDays", 0))::numeric, 2) as velocity,
      ps."totalUnitsSold" / nullif(ps."activeDays", 0) as "rawVelocity"
    from product_sales ps
    join product p on ps.product_id = p.id
    order by "rawVelocity" desc
  `;

  const rows = raw.map((r) => ({
    ...r,
    totalUnitsSold: Number(r.totalUnitsSold),
    totalRevenue: Number(r.totalRevenue),
    activeDays: Number(r.activeDays),
    velocity: r.velocity != null ? Number(r.velocity) : null,
    rawVelocity: r.rawVelocity != null ? Number(r.rawVelocity) : 0,
  }));

  if (rows.length === 0) return [];

  const velocities = rows.map((r) => r.rawVelocity).sort((a, b) => a - b);
  const p70 = velocities[Math.floor(velocities.length * 0.7)];
  const p30 = velocities[Math.floor(velocities.length * 0.3)];

  return rows.map((r) => ({
    ...r,
    classification: r.rawVelocity >= p70 ? 'Fast' : r.rawVelocity >= p30 ? 'Medium' : 'Slow',
  }));
}

/**
 * Summary counts for fast / medium / slow.
 */
async function fastSlowSummary(organizationId) {
  const items = await fastSlowMovers(organizationId);
  const summary = { Fast: 0, Medium: 0, Slow: 0 };
  for (const item of items) {
    summary[item.classification]++;
  }
  return summary;
}

// ────────────────────────────────────────────
// 5. Expiry / Discontinuation Summary
//    Products marked is_discontinued or approaching discontinued_date
// ────────────────────────────────────────────

async function expirySummary(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();

  const products = await db`
    select
      id, name, category, launch_date as "LaunchDate",
      is_discontinued as "IsDiscontinued", discontinued_date as "DiscontinuedDate"
    from product
    where organization_id = ${organizationId}
    order by
      case when is_discontinued = 'Yes' then 0 else 1 end,
      discontinued_date asc
  `;

  const now = new Date();
  const ninetyDaysFromNow = new Date(now.getTime() + 90 * 86400000);
  const todayStr = now.toISOString().substring(0, 10);
  const ninetyStr = ninetyDaysFromNow.toISOString().substring(0, 10);

  return products.map((p) => {
    let status = 'Active';
    let riskLevel = 'none';
    const discontinuedDateStr = p.DiscontinuedDate ? new Date(p.DiscontinuedDate).toISOString().substring(0, 10) : null;

    if (p.IsDiscontinued === 'Yes' && discontinuedDateStr) {
      if (discontinuedDateStr <= todayStr) {
        status = 'Discontinued';
        riskLevel = 'high';
      } else if (discontinuedDateStr <= ninetyStr) {
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

async function fullInsights(organizationId) {
  const [
    profitByCategoryResult,
    abcSummaryResult,
    abcItems,
    inventoryTurnoverResult,
    fastSlowSummaryResult,
    fastSlowMoversResult,
    expirySummaryResult,
  ] = await Promise.all([
    profitByCategory(organizationId),
    abcSummary(organizationId),
    abcAnalysis(organizationId),
    inventoryTurnover(organizationId),
    fastSlowSummary(organizationId),
    fastSlowMovers(organizationId),
    expirySummary(organizationId),
  ]);

  return {
    profitByCategory: profitByCategoryResult,
    abcSummary: abcSummaryResult,
    abcTopA: abcItems.filter((p) => p.abcClass === 'A').slice(0, 20),
    inventoryTurnover: inventoryTurnoverResult.slice(0, 20),
    fastSlowSummary: fastSlowSummaryResult,
    fastSlowMovers: fastSlowMoversResult.slice(0, 20),
    expirySummary: expirySummaryResult,
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
