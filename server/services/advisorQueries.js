/**
 * AI Advisor — data layer.
 *
 * Every function here is a fresh, additive read against the existing
 * database/services — nothing in the existing pipeline (database.js,
 * businessHealth.js, businessHealthData.js, recommendations.js, insights.js,
 * widgetEngine.js) is modified. This file only *calls* those exports or
 * runs its own new SQL against the same DB connection.
 *
 * Every function returns plain data (numbers/strings/arrays) — no prose.
 * The advisor agent is responsible for turning this into an answer, and
 * must never state a number that didn't come from one of these functions.
 */

const { getDb, queryAnalytics } = require('./database');
const { computeHealthStats } = require('./businessHealthData');
const { scoreBusinessHealth } = require('./businessHealth');
const { generateInsights } = require('./recommendations');
const { profitByCategory, fastSlowMovers } = require('./insights');
const { evaluateFromStore } = require('./widgetEngine');

const round = (n, d = 2) => {
  if (n == null) return null;
  const m = 10 ** d;
  return Math.round(n * m) / m;
};

// ── Levenshtein distance — local copy for typo-tolerant product lookup.
// (productNormalizer.js has its own private one; not exported, and this
// file doesn't modify that pipeline file to expose it.)
function levenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Revenue / profit / growth ────────────────────────────────────────────

function getRevenueProfitSummary() {
  const a = queryAnalytics();
  return {
    totalRevenue: a.metrics.totalRevenue,
    grossProfit: a.metrics.grossProfit,
    grossMargin: a.metrics.grossMargin,
    totalQuantitySold: a.metrics.totalQuantitySold,
    transactionCount: a.metrics.recordCount,
    averageTransactionValue: a.metrics.averageTransactionValue,
    monthsOfData: a.monthlyRevenue.length,
  };
}

function getWeeklyRevenue({ weeks = 8 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.year AS year, c.week AS week,
           MIN(c.date) AS weekStart, MAX(c.date) AS weekEnd,
           SUM(f.unit_price * f.quantity) AS revenue,
           SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit,
           COUNT(*) AS transactions
    FROM fact_sales f
    JOIN dim_calendar c ON f.calendar_id = c.id
    GROUP BY c.year, c.week
    ORDER BY c.year DESC, c.week DESC
    LIMIT ?
  `).all(weeks);
  return rows.reverse().map((r) => ({
    year: r.year,
    week: r.week,
    weekStart: r.weekStart,
    weekEnd: r.weekEnd,
    revenue: round(r.revenue),
    profit: r.profit != null ? round(r.profit) : null,
    transactions: r.transactions,
  }));
}

function getGrowthTrend() {
  const a = queryAnalytics();
  const months = a.monthlyRevenue;
  if (months.length < 2) {
    return { available: false, reason: 'Fewer than 2 months of data — cannot compute a trend.' };
  }
  const rates = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].revenue;
    const curr = months[i].revenue;
    if (prev > 0) rates.push(((curr - prev) / prev) * 100);
  }
  const avgGrowth = rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
  const last = months[months.length - 1];
  const prevMonth = months[months.length - 2];
  return {
    available: true,
    monthlyRevenue: months,
    averageMonthOverMonthGrowthPct: round(avgGrowth),
    lastMonth: last,
    previousMonth: prevMonth,
    lastMonthChangePct: prevMonth.revenue > 0 ? round(((last.revenue - prevMonth.revenue) / prevMonth.revenue) * 100) : null,
    classification: avgGrowth > 2 ? 'Growing' : avgGrowth < -2 ? 'Declining' : 'Stable',
  };
}

// ── Products ──────────────────────────────────────────────────────────────

function getTopProducts({ sortBy = 'revenue', n = 10 } = {}) {
  const a = queryAnalytics();
  const key = sortBy === 'profit' ? 'profit' : 'revenue';
  return [...a.topProducts]
    .filter((p) => p[key] != null)
    .sort((x, y) => y[key] - x[key])
    .slice(0, n);
}

function getCategoryPerformance() {
  return profitByCategory();
}

function getSlowMovers({ n = 15 } = {}) {
  const items = fastSlowMovers();
  return items.filter((i) => i.classification === 'Slow').slice(0, n);
}

function getProfitLeakage({ marginThreshold = 15, n = 10 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.name, COALESCE(p.category, 'Uncategorised') AS category,
           SUM(f.unit_price * f.quantity) AS revenue,
           SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit,
           CASE WHEN SUM(f.unit_price * f.quantity) > 0
                THEN ROUND(SUM((f.unit_price - f.unit_cost) * f.quantity) / SUM(f.unit_price * f.quantity) * 100, 2)
                ELSE NULL END AS margin
    FROM fact_sales f
    JOIN dim_product p ON f.product_id = p.id
    WHERE f.unit_cost IS NOT NULL
    GROUP BY p.id
    HAVING margin IS NOT NULL AND margin < ?
    ORDER BY revenue DESC
    LIMIT ?
  `).all(marginThreshold, n);
  return rows.map((r) => ({ ...r, revenue: round(r.revenue), profit: round(r.profit) }));
}

/**
 * Fuzzy product lookup: normalized substring match first, Levenshtein
 * fallback second. Returns { match } | { candidates } | { notFound: true }.
 */
function findProduct(query) {
  const db = getDb();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { notFound: true };

  const all = db.prepare(`
    SELECT id, name, category, resolved_brand, resolved_generic
    FROM dim_product
  `).all();

  const substringHits = all.filter((p) =>
    [p.name, p.resolved_brand, p.resolved_generic].some((v) => v && String(v).toLowerCase().includes(q))
  );
  if (substringHits.length === 1) return { match: substringHits[0] };
  if (substringHits.length > 1 && substringHits.length <= 5) return { candidates: substringHits };
  if (substringHits.length > 5) return { candidates: substringHits.slice(0, 5) };

  // Fuzzy fallback
  const scored = all.map((p) => {
    const names = [p.name, p.resolved_brand, p.resolved_generic].filter(Boolean).map((v) => String(v).toLowerCase());
    const dist = Math.min(...names.map((nm) => levenshtein(q, nm.slice(0, q.length + 3))), 999);
    return { p, dist };
  }).sort((a, b) => a.dist - b.dist);

  const best = scored[0];
  if (!best || best.dist > Math.max(3, Math.floor(q.length * 0.4))) return { notFound: true };
  const close = scored.filter((s) => s.dist <= best.dist + 1).slice(0, 5);
  if (close.length === 1) return { match: close[0].p, fuzzy: true, distance: close[0].dist };
  return { candidates: close.map((c) => c.p), fuzzy: true };
}

function getProductProfile({ query } = {}) {
  const found = findProduct(query);
  if (found.notFound) return { found: false, query };
  if (found.candidates) return { found: false, ambiguous: true, candidates: found.candidates.map((c) => c.name) };

  const db = getDb();
  const product = found.match;

  const stats = db.prepare(`
    SELECT SUM(f.unit_price * f.quantity) AS revenue,
           SUM(f.quantity) AS quantity,
           SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit,
           AVG(f.unit_price) AS avgPrice,
           COUNT(*) AS transactions
    FROM fact_sales f WHERE f.product_id = ?
  `).get(product.id);

  const totalRevRow = db.prepare('SELECT SUM(unit_price * quantity) AS total FROM fact_sales').get();
  const totalRevenue = totalRevRow?.total || 0;

  const rankRow = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM (
      SELECT product_id, SUM(unit_price * quantity) AS rev FROM fact_sales GROUP BY product_id HAVING rev > (
        SELECT SUM(unit_price * quantity) FROM fact_sales WHERE product_id = ?
      )
    )
  `).get(product.id);

  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', c.date) AS month, SUM(f.unit_price * f.quantity) AS revenue, SUM(f.quantity) AS quantity
    FROM fact_sales f JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE f.product_id = ?
    GROUP BY month ORDER BY month
  `).all(product.id);

  if (!stats || !stats.revenue) {
    return { found: true, product: product.name, category: product.category, noSalesRecorded: true };
  }

  return {
    found: true,
    product: product.name,
    category: product.category,
    genericName: product.resolved_generic || null,
    revenue: round(stats.revenue),
    quantitySold: round(stats.quantity),
    profit: stats.profit != null ? round(stats.profit) : null,
    margin: stats.revenue > 0 && stats.profit != null ? round((stats.profit / stats.revenue) * 100) : null,
    averagePrice: round(stats.avgPrice),
    transactions: stats.transactions,
    shareOfTotalRevenuePct: totalRevenue > 0 ? round((stats.revenue / totalRevenue) * 100) : null,
    revenueRank: rankRow?.rank || null,
    monthlyTrend: monthly.map((m) => ({ month: m.month, revenue: round(m.revenue), quantity: round(m.quantity) })),
  };
}

/**
 * Constant-quantity price simulation. Conservative baseline: assumes
 * quantity sold is unaffected by the price change, and says so.
 * Opportunistically reports real historical price/quantity variation for
 * the same product if the data has any, instead of inventing elasticity.
 */
function simulatePriceChange({ query, priceChangePct } = {}) {
  const profile = getProductProfile({ query });
  if (!profile.found) return profile;
  if (profile.noSalesRecorded) return profile;

  const currentPrice = profile.averagePrice;
  const currentQty = profile.quantitySold;
  const newPrice = round(currentPrice * (1 + priceChangePct / 100));
  const projectedProductRevenue = round(newPrice * currentQty);
  const revenueDelta = round(projectedProductRevenue - profile.revenue);

  const totalRevRow = getDb().prepare('SELECT SUM(unit_price * quantity) AS total FROM fact_sales').get();
  const totalRevenue = totalRevRow?.total || 0;
  const overallImpactPct = totalRevenue > 0 ? round((revenueDelta / totalRevenue) * 100) : null;

  // Look for real historical price variation on this product (not invented elasticity)
  const db = getDb();
  const priceHistory = db.prepare(`
    SELECT strftime('%Y-%m', c.date) AS month, AVG(f.unit_price) AS avgPrice, SUM(f.quantity) AS qty
    FROM fact_sales f JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE f.product_id = (SELECT id FROM dim_product WHERE name = ?)
    GROUP BY month ORDER BY month
  `).all(profile.product);

  let historicalElasticitySignal = null;
  const distinctPrices = new Set(priceHistory.map((r) => round(r.avgPrice, 1)));
  if (distinctPrices.size >= 2) {
    const first = priceHistory[0];
    const last = priceHistory[priceHistory.length - 1];
    if (first.avgPrice > 0 && first.qty > 0) {
      const priceChangeSeen = ((last.avgPrice - first.avgPrice) / first.avgPrice) * 100;
      const qtyChangeSeen = ((last.qty - first.qty) / first.qty) * 100;
      if (Math.abs(priceChangeSeen) > 1) {
        historicalElasticitySignal = {
          note: `Between ${first.month} and ${last.month}, this product's price moved ${round(priceChangeSeen)}% and quantity sold moved ${round(qtyChangeSeen)}%.`,
          priceChangeSeenPct: round(priceChangeSeen),
          quantityChangeSeenPct: round(qtyChangeSeen),
        };
      }
    }
  }

  return {
    found: true,
    product: profile.product,
    assumption: 'This projection holds quantity sold constant — it does not model how customers might respond to the price change.',
    currentPrice: round(currentPrice),
    newPrice,
    currentProductRevenue: profile.revenue,
    projectedProductRevenue,
    productRevenueDelta: revenueDelta,
    currentTotalBusinessRevenue: round(totalRevenue),
    overallRevenueImpactPct: overallImpactPct,
    historicalElasticitySignal,
  };
}

// ── Customers ────────────────────────────────────────────────────────────

function getTopCustomers({ n = 10 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.name, c.type,
           SUM(f.unit_price * f.quantity) AS totalSpend,
           COUNT(*) AS transactions
    FROM fact_sales f
    JOIN dim_customer c ON f.customer_id = c.id
    WHERE c.id != 1
    GROUP BY c.id
    ORDER BY totalSpend DESC
    LIMIT ?
  `).all(n);
  if (rows.length === 0) {
    return { available: false, reason: 'No named-customer data in this dataset (sales are attributed to walk-in only).' };
  }
  return { available: true, customers: rows.map((r) => ({ ...r, totalSpend: round(r.totalSpend) })) };
}

function getFrequentlyBoughtTogether({ product, n = 10 } = {}) {
  const db = getDb();
  let productId = null;
  if (product) {
    const found = findProduct(product);
    if (found.notFound) return { available: false, reason: `No product matching "${product}".` };
    if (found.candidates) return { available: false, ambiguous: true, candidates: found.candidates.map((c) => c.name) };
    productId = found.match.id;
  }

  const multiLineInvoices = db.prepare(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT invoice_ref FROM fact_sales
      WHERE invoice_ref IS NOT NULL AND invoice_ref != ''
      GROUP BY invoice_ref HAVING COUNT(*) > 1
    )
  `).get().cnt;

  if (multiLineInvoices < 3) {
    return { available: false, reason: 'Not enough multi-item invoices in this dataset to detect real product pairings.' };
  }

  const pairs = db.prepare(`
    SELECT p1.name AS productA, p2.name AS productB, COUNT(*) AS timesTogether
    FROM fact_sales f1
    JOIN fact_sales f2 ON f1.invoice_ref = f2.invoice_ref AND f1.product_id < f2.product_id
    JOIN dim_product p1 ON f1.product_id = p1.id
    JOIN dim_product p2 ON f2.product_id = p2.id
    WHERE f1.invoice_ref IS NOT NULL AND f1.invoice_ref != ''
      ${productId ? 'AND (f1.product_id = ? OR f2.product_id = ?)' : ''}
    GROUP BY p1.id, p2.id
    ORDER BY timesTogether DESC
    LIMIT ?
  `).all(...(productId ? [productId, productId, n] : [n]));

  return { available: true, pairs };
}

// ── Inventory (prefers real widget data, falls back to a labeled estimate) ─

function getWidgetResult(dashboardKey, widgetId) {
  try {
    const manifest = evaluateFromStore();
    const w = manifest.dashboards?.[dashboardKey]?.available?.find((x) => x.id === widgetId);
    if (!w || w.result?.error) return null;
    return w.result;
  } catch (_) {
    return null;
  }
}

function getLowStock() {
  const real = getWidgetResult('inventory', 'low-stock-alert');
  if (real) return { estimated: false, ...real };

  const { inventoryStats } = computeHealthStats();
  if (!inventoryStats) return { available: false, reason: 'No inventory data available.' };
  return {
    estimated: true,
    note: 'No stock-level data uploaded — this is a sales-velocity estimate, not a real stock count.',
    lowStockCount: inventoryStats.lowStockCount,
    totalProducts: inventoryStats.totalProducts,
  };
}

function getOverstock() {
  const { inventoryStats } = computeHealthStats();
  if (!inventoryStats) return { available: false, reason: 'No inventory data available.' };

  // computeHealthStats() only returns overstockCount/Pct, not the product
  // list — recompute the same slow-mover-based list independently here
  // (new code; businessHealthData.js is not modified).
  const db = getDb();
  const totalMonths = inventoryStats.totalMonths || 1;
  const rows = db.prepare(`
    SELECT p.name, COALESCE(SUM(f.quantity), 0) AS unitsSold,
           ROUND(COALESCE(SUM(f.quantity), 0) * 1.0 / ?, 2) AS unitsPerMonth
    FROM dim_product p
    LEFT JOIN fact_sales f ON f.product_id = p.id
    GROUP BY p.id
    HAVING unitsSold > 0
    ORDER BY unitsPerMonth ASC
  `).all(totalMonths);

  const velocities = rows.map((r) => r.unitsPerMonth).sort((a, b) => a - b);
  const slowThreshold = velocities.length > 0 ? velocities[Math.floor(velocities.length * 0.25)] : 0;
  const overstocked = rows.filter((r) => r.unitsPerMonth <= slowThreshold);

  return {
    estimated: true,
    note: 'No stock-on-hand data uploaded — these are the slowest-moving products by sales velocity, a proxy for overstock risk.',
    overstockCount: inventoryStats.overstockCount,
    overstockPct: inventoryStats.overstockPct,
    products: overstocked.slice(0, 15).map((r) => ({ name: r.name, unitsPerMonth: r.unitsPerMonth })),
  };
}

function getExpirySummary() {
  const realRisk = getWidgetResult('expiry', 'expiry-risk') || getWidgetResult('inventory', 'expiry-risk');
  const realTimeline = getWidgetResult('expiry', 'expiry-timeline') || getWidgetResult('inventory', 'expiry-timeline');
  if (realRisk || realTimeline) {
    return { estimated: false, risk: realRisk, timeline: realTimeline };
  }
  return { available: false, reason: 'No expiry-date data uploaded for this dataset.' };
}

// ── Business health / priorities / risks / "why" ────────────────────────

/**
 * Rebuilds the same business-health bundle as GET /api/business-health,
 * as independent code (not by calling or modifying that route/handler).
 */
function getBusinessHealthBundle() {
  const db = getDb();
  const analytics = queryAnalytics();
  const { inventoryStats, customerStats } = computeHealthStats();
  const a = analytics.metrics || {};

  const monthlyTxs = db.prepare(`
    SELECT strftime('%Y-%m', c.date) AS month, COUNT(*) AS transactions
    FROM fact_sales f JOIN dim_calendar c ON f.calendar_id = c.id
    GROUP BY strftime('%Y-%m', c.date) ORDER BY month
  `).all();
  const txMap = {};
  monthlyTxs.forEach((r) => { txMap[r.month] = r.transactions; });
  const months = (analytics.monthlyProfit || analytics.monthlyRevenue || []).map((m) => ({
    month: m.month, revenue: m.revenue || 0, transactions: txMap[m.month] || 0, profit: m.profit ?? null,
  }));

  const totalDistinct = db.prepare('SELECT COUNT(DISTINCT product_id) AS cnt FROM fact_sales').get().cnt;
  const topProducts = (analytics.topProducts || []).map((p) => ({ name: p.name, revenue: p.revenue, margin: p.margin }));

  const allProductRevs = db.prepare('SELECT SUM(unit_price * quantity) AS revenue FROM fact_sales GROUP BY product_id ORDER BY revenue DESC').all();
  const totalRev = allProductRevs.reduce((s, r) => s + (r.revenue || 0), 0);
  const top1 = totalRev > 0 && allProductRevs.length > 0 ? (allProductRevs[0].revenue / totalRev) * 100 : 0;

  const totalFacts = db.prepare('SELECT COUNT(*) AS cnt FROM fact_sales').get().cnt;
  const productsWithSales = db.prepare('SELECT COUNT(DISTINCT product_id) AS cnt FROM fact_sales').get().cnt;
  const totalProducts = db.prepare('SELECT COUNT(*) AS cnt FROM dim_product').get().cnt;

  const metrics = {
    overview: {
      totalRevenue: a.totalRevenue || 0,
      totalQuantitySold: a.totalQuantitySold || 0,
      transactionCount: a.recordCount || 0,
      averageTransactionValue: a.averageTransactionValue || 0,
      averageSellingPrice: a.averageSellingPrice || 0,
      grossProfit: a.grossProfit,
      grossMargin: a.grossMargin,
      hasCostData: a.grossProfit != null,
    },
    trends: { months, monthCount: months.length },
    products: {
      totalDistinctProducts: totalDistinct,
      revenueConcentration: { top1: Math.round(top1) },
      allProducts: topProducts,
    },
    health: {
      dataCompleteness: { productName: 100, quantity: 100, revenue: 100, date: 100 },
      qualityDistribution: { excellent: totalFacts, good: 0, fair: 0, poor: 0 },
      pipelineStages: { uploadedRows: totalFacts, structurallyValidRows: totalFacts },
      productRecognition: {
        recognizedCount: productsWithSales,
        unknownCount: Math.max(0, totalProducts - productsWithSales),
        recognitionRate: totalProducts > 0 ? (productsWithSales / totalProducts) * 100 : 100,
      },
    },
  };

  const opts = {};
  if (inventoryStats) opts.inventoryStats = inventoryStats;
  if (customerStats) opts.customerStats = customerStats;

  const healthResult = scoreBusinessHealth(metrics, opts);
  const insights = generateInsights(healthResult, metrics, opts);
  return { health: healthResult, insights, topPriorities: insights.slice(0, 3) };
}

function getBusinessHealth() {
  const { health } = getBusinessHealthBundle();
  return health;
}

function getTopPriorities({ n = 5 } = {}) {
  const { insights } = getBusinessHealthBundle();
  return insights.slice(0, n);
}

function getRevenueTrendDrivers() {
  const { insights } = getBusinessHealthBundle();
  const driverInsights = insights.filter((i) => i.metric === 'Revenue Growth' || i.pillar === 'Sales Performance');
  if (driverInsights.length === 0) {
    return { available: false, reason: 'No significant revenue swings detected in the current data.' };
  }
  return { available: true, insights: driverInsights };
}

module.exports = {
  getRevenueProfitSummary,
  getWeeklyRevenue,
  getGrowthTrend,
  getTopProducts,
  getCategoryPerformance,
  getSlowMovers,
  getProfitLeakage,
  getProductProfile,
  simulatePriceChange,
  getTopCustomers,
  getFrequentlyBoughtTogether,
  getLowStock,
  getOverstock,
  getExpirySummary,
  getBusinessHealth,
  getTopPriorities,
  getRevenueTrendDrivers,
};
