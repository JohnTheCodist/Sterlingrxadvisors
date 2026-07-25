/**
 * Metrics Engine — Single Source of Truth for all pharmacy KPIs.
 *
 * Phase 5: Every number is computed once, verified, and exposed as structured
 * data. The AI analysis agent depends on this layer for all calculations.
 *
 * Principles:
 *   1. One computation per metric — no duplicates, no drift
 *   2. Every metric includes its formula for independent verification
 *   3. Pure functions — no side effects, no I/O
 *   4. All monetary values in the source currency (typically NGN)
 *
 * Metric categories:
 *   - overview     — Total revenue, profit, margin, transaction count
 *   - products     — Rankings, concentration, growth, margin analysis
 *   - trends       — Monthly revenue/profit, MoM growth
 *   - payments     — Payment method distribution, digital vs cash
 *   - categories   — Therapeutic category breakdown
 *   - health       — Data quality, product recognition rate
 */

// ---- helpers -----------------------------------------------------------

const num = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Check whether a record is excluded from a specific analytics metric.
 * Consumes the validation layer's `excludedMetrics` per-record set.
 *
 * Mapping:
 *   revenue_metrics   → total revenue, avg transaction value
 *   quantity_metrics  → quantity sold, avg price per unit
 *   trends            → monthly trends, MoM growth
 *   product_breakdown → top products, category breakdown
 *   profitability     → profit, margin, cost analysis
 *   payment_breakdown → payment method distribution
 *   consistency_check → general warning, record still usable
 */
function isExcludedFrom(rec, metric) {
  const excluded = rec._quality?.excludedMetrics || rec.excludedMetrics || [];
  if (!Array.isArray(excluded)) return false;
  return excluded.includes(metric);
}

const productOf = (rec) => rec.product_name || rec.product || 'Unknown';
const priceOf = (rec) => rec.selling_price != null ? rec.selling_price : rec.price;
const costOf = (rec) => rec.cost_price != null ? rec.cost_price : rec.cost;

/**
 * Returns the TOTAL cost for a record.
 * When rec._cost_is_total is true, cost_price is already the per-row total
 * (determined by the normalizer's cost-mode detection). Otherwise cost is
 * treated as per-unit and multiplied by quantity.
 */
function totalCostOf(rec) {
  const unitCost = costOf(rec);
  if (unitCost <= 0) return 0;
  if (rec._cost_is_total === true) return unitCost;
  return unitCost * num(rec.quantity);
}

const revenueOf = (rec) => {
  if (rec.revenue != null) return num(rec.revenue);
  return num(priceOf(rec)) * num(rec.quantity);
};

function round(n) {
  return Math.round(n * 100) / 100;
}

function parseMonth(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}/.test(s)) return s.substring(0, 7);
  return null;
}

// ---- overview metrics --------------------------------------------------

function computeOverview(records) {
  let totalRevenue = 0;
  let totalCost = 0;
  let explicitProfit = 0;
  let hasExplicitProfit = false;
  let totalQty = 0;
  let transactionCount = 0;
  let hasAnyCost = false;

  for (const rec of records) {
    const revExcluded = isExcludedFrom(rec, 'revenue_metrics');
    const qtyExcluded = isExcludedFrom(rec, 'quantity_metrics');
    const profitExcluded = isExcludedFrom(rec, 'profitability');

    const rev = revExcluded ? 0 : revenueOf(rec);
    const qty = qtyExcluded ? 0 : num(rec.quantity);
    const tCost = profitExcluded ? 0 : totalCostOf(rec);

    if (rev > 0) transactionCount++;
    totalRevenue += rev;
    totalQty += qty;
    if (tCost > 0) {
      totalCost += tCost;
      hasAnyCost = true;
    }
    // Accumulate explicit profit field if present (takes priority over computed profit)
    if (rec.profit != null && !profitExcluded) {
      explicitProfit += num(rec.profit);
      hasExplicitProfit = true;
    }
  }

  const computedProfit = hasAnyCost ? totalRevenue - totalCost : null;
  const grossProfit = hasExplicitProfit ? round(explicitProfit) : (computedProfit !== null ? round(computedProfit) : null);
  const grossMargin = grossProfit !== null && totalRevenue > 0
    ? round((grossProfit / totalRevenue) * 100)
    : null;
  const avgTransactionValue = transactionCount > 0
    ? round(totalRevenue / transactionCount)
    : 0;
  const avgSellingPrice = totalQty > 0
    ? round(totalRevenue / totalQty)
    : 0;

  return {
    totalRevenue: round(totalRevenue),
    totalQuantitySold: round(totalQty),
    transactionCount,
    averageTransactionValue: avgTransactionValue,
    averageSellingPrice: avgSellingPrice,
    grossProfit: grossProfit !== null ? round(grossProfit) : null,
    grossMargin,
    hasCostData: hasAnyCost,
    formulas: {
      totalRevenue: 'SUM(revenue) for all records',
      grossProfit: 'totalRevenue - SUM(cost_price * quantity)',
      grossMargin: '(grossProfit / totalRevenue) * 100',
      averageTransactionValue: 'totalRevenue / transactionCount',
    },
  };
}

// ---- product metrics ---------------------------------------------------

function computeProductMetrics(records) {
  const productMap = {};

  for (const rec of records) {
    const name = productOf(rec) ? String(productOf(rec)).trim() : 'Unknown';
    if (!name) continue;

    const revExcluded = isExcludedFrom(rec, 'revenue_metrics');
    const qtyExcluded = isExcludedFrom(rec, 'quantity_metrics');
    const profitExcluded = isExcludedFrom(rec, 'profitability');
    const productExcluded = isExcludedFrom(rec, 'product_breakdown');

    if (productExcluded) continue; // unknown products → skip from breakdown

    const rev = revExcluded ? 0 : revenueOf(rec);
    const qty = qtyExcluded ? 0 : num(rec.quantity);
    const tCost = profitExcluded ? 0 : totalCostOf(rec);

    if (!productMap[name]) {
      productMap[name] = { revenue: 0, quantity: 0, cost: 0, transactions: 0, hasCost: false, months: new Set() };
    }
    productMap[name].revenue += rev;
    productMap[name].quantity += qty;
    productMap[name].transactions++;
    if (tCost > 0) { productMap[name].cost += tCost; productMap[name].hasCost = true; }
    const month = parseMonth(rec.transaction_date);
    if (month) productMap[name].months.add(month);
  }

  const products = Object.entries(productMap).map(([name, data]) => {
    const profit = data.hasCost ? data.revenue - data.cost : null;
    const margin = data.hasCost && data.revenue > 0
      ? round((profit / data.revenue) * 100)
      : null;
    return {
      name,
      revenue: round(data.revenue),
      quantity: round(data.quantity),
      transactions: data.transactions,
      profit: profit !== null ? round(profit) : null,
      margin,
      revenueShare: 0, // filled below
      monthlyAvg: data.months.size > 0
        ? round(data.revenue / data.months.size)
        : round(data.revenue),
    };
  });

  // Sort by revenue descending
  products.sort((a, b) => b.revenue - a.revenue);

  // Compute revenue share
  const totalRev = products.reduce((s, p) => s + p.revenue, 0);
  for (const p of products) {
    p.revenueShare = totalRev > 0 ? round((p.revenue / totalRev) * 100) : 0;
  }

  // Classifications
  const top10 = products.slice(0, 10);
  const bottom10 = products.slice(-10).reverse();
  const profitable = products.filter((p) => p.profit !== null && p.profit > 0);
  const lossMaking = products.filter((p) => p.profit !== null && p.profit < 0);
  const highestMargin = [...products]
    .filter((p) => p.margin !== null)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 5);
  const lowestMargin = [...products]
    .filter((p) => p.margin !== null)
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 5);

  return {
    totalDistinctProducts: products.length,
    top10,
    bottom10,
    profitable: { count: profitable.length, totalProfit: round(profitable.reduce((s, p) => s + p.profit, 0)) },
    lossMaking: { count: lossMaking.length, products: lossMaking },
    highestMargin,
    lowestMargin,
    revenueConcentration: {
      top1: top10[0] ? top10[0].revenueShare : 0,
      top3: top10.slice(0, 3).reduce((s, p) => s + p.revenueShare, 0),
      top5: top10.slice(0, 5).reduce((s, p) => s + p.revenueShare, 0),
    },
    allProducts: products,
    formulas: {
      revenueShare: '(product.revenue / totalRevenue) * 100',
      margin: '((revenue - cost) / revenue) * 100',
    },
  };
}

// ---- monthly trends ----------------------------------------------------

function computeMonthlyTrends(records) {
  const monthMap = {};

  for (const rec of records) {
    if (isExcludedFrom(rec, 'trends')) continue;
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;

    const revExcluded = isExcludedFrom(rec, 'revenue_metrics');
    const qtyExcluded = isExcludedFrom(rec, 'quantity_metrics');
    const profitExcluded = isExcludedFrom(rec, 'profitability');

    const rev = revExcluded ? 0 : revenueOf(rec);
    const qty = qtyExcluded ? 0 : num(rec.quantity);
    const tCost = profitExcluded ? 0 : totalCostOf(rec);

    if (!monthMap[month]) {
      monthMap[month] = { revenue: 0, quantity: 0, cost: 0, transactions: 0, hasCost: false };
    }
    monthMap[month].revenue += rev;
    monthMap[month].quantity += qty;
    monthMap[month].transactions++;
    if (tCost > 0) { monthMap[month].cost += tCost; monthMap[month].hasCost = true; }
  }

  const months = Object.entries(monthMap)
    .map(([month, data]) => {
      const profit = data.hasCost ? data.revenue - data.cost : null;
      return {
        month,
        revenue: round(data.revenue),
        quantity: round(data.quantity),
        transactions: data.transactions,
        profit: profit !== null ? round(profit) : null,
        margin: data.hasCost && data.revenue > 0
          ? round(((data.revenue - data.cost) / data.revenue) * 100)
          : null,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  // Compute MoM growth
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].revenue;
    const curr = months[i].revenue;
    months[i].momGrowth = prev > 0
      ? round(((curr - prev) / prev) * 100)
      : null;
  }

  return {
    months,
    monthCount: months.length,
    trend: months.length >= 2
      ? _trendDirection(months.map((m) => m.revenue))
      : 'insufficient_data',
    highestMonth: months.length > 0
      ? months.reduce((a, b) => a.revenue > b.revenue ? a : b)
      : null,
    lowestMonth: months.length > 0
      ? months.reduce((a, b) => a.revenue < b.revenue ? a : b)
      : null,
    formulas: {
      momGrowth: '((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100',
    },
  };
}

function _trendDirection(values) {
  if (values.length < 2) return 'insufficient_data';
  const first = values[0];
  const last = values[values.length - 1];
  const change = ((last - first) / (first || 1)) * 100;
  if (change > 10) return 'strong_growth';
  if (change > 3) return 'moderate_growth';
  if (change > -3) return 'stable';
  if (change > -10) return 'moderate_decline';
  return 'significant_decline';
}

// ---- payment metrics ---------------------------------------------------

function computePaymentMetrics(records) {
  const paymentMap = {};
  let totalWithPayment = 0;

  for (const rec of records) {
    if (isExcludedFrom(rec, 'payment_breakdown')) continue;
    const method = rec.payment_method ? String(rec.payment_method).trim() : null;
    if (!method) continue;

    const revExcluded = isExcludedFrom(rec, 'revenue_metrics');
    const rev = revExcluded ? 0 : revenueOf(rec);
    if (!paymentMap[method]) { paymentMap[method] = { revenue: 0, count: 0 }; }
    paymentMap[method].revenue += rev;
    paymentMap[method].count++;
    totalWithPayment++;
  }

  const methods = Object.entries(paymentMap).map(([method, data]) => ({
    method,
    revenue: round(data.revenue),
    count: data.count,
    share: totalWithPayment > 0 ? round((data.count / totalWithPayment) * 100) : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  const digitalMethods = ['Transfer', 'POS', 'Card', 'Online'];
  const cashTotal = methods.find((m) => m.method === 'Cash');
  const digitalTotal = methods
    .filter((m) => digitalMethods.some((d) => m.method.toLowerCase().includes(d.toLowerCase())))
    .reduce((s, m) => s + m.count, 0);

  return {
    methods,
    methodCount: methods.length,
    cashVsDigital: {
      cash: cashTotal ? cashTotal.count : 0,
      digital: digitalTotal,
      cashShare: totalWithPayment > 0 ? round(((cashTotal ? cashTotal.count : 0) / totalWithPayment) * 100) : 0,
      digitalShare: totalWithPayment > 0 ? round((digitalTotal / totalWithPayment) * 100) : 0,
    },
    totalWithPaymentMethod: totalWithPayment,
    formulas: {
      share: '(method.count / totalWithPaymentMethod) * 100',
    },
  };
}

// ---- category metrics --------------------------------------------------

function computeCategoryMetrics(records) {
  const categoryMap = {};

  for (const rec of records) {
    if (isExcludedFrom(rec, 'product_breakdown')) continue;
    const category = rec._productCategory || 'Uncategorized';
    const revExcluded = isExcludedFrom(rec, 'revenue_metrics');
    const qtyExcluded = isExcludedFrom(rec, 'quantity_metrics');
    const profitExcluded = isExcludedFrom(rec, 'profitability');

    const rev = revExcluded ? 0 : revenueOf(rec);
    const qty = qtyExcluded ? 0 : num(rec.quantity);
    const tCost = profitExcluded ? 0 : totalCostOf(rec);

    if (!categoryMap[category]) {
      categoryMap[category] = { revenue: 0, quantity: 0, cost: 0, count: 0, products: new Set(), hasCost: false };
    }
    categoryMap[category].revenue += rev;
    categoryMap[category].quantity += qty;
    categoryMap[category].count++;
    categoryMap[category].products.add(productOf(rec));
    if (tCost > 0) { categoryMap[category].cost += tCost; categoryMap[category].hasCost = true; }
  }

  const totalRev = Object.values(categoryMap).reduce((s, c) => s + c.revenue, 0);

  const categories = Object.entries(categoryMap).map(([name, data]) => {
    const profit = data.hasCost ? data.revenue - data.cost : null;
    return {
      name,
      revenue: round(data.revenue),
      quantity: round(data.quantity),
      productCount: data.products.size,
      transactionCount: data.count,
      revenueShare: totalRev > 0 ? round((data.revenue / totalRev) * 100) : 0,
      profit: profit !== null ? round(profit) : null,
      margin: data.hasCost && data.revenue > 0
        ? round(((data.revenue - data.cost) / data.revenue) * 100)
        : null,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return {
    categories,
    mostProfitableCategory: categories.filter((c) => c.profit !== null).sort((a, b) => (b.profit || 0) - (a.profit || 0))[0] || null,
    largestCategory: categories[0] || null,
  };
}

// ---- data health metrics -----------------------------------------------

function computeHealthMetrics(records, productNormalizationStats, cleaningReportSummary, qualityReport, pipelineStats) {
  const totalRows = records.length;

  // Product recognition
  const productRecognition = productNormalizationStats || { recognized: 0, unknown: 0, uniqueCanonicalDrugs: 0 };

  // Data completeness — only count records NOT excluded from that metric
  let rowsWithProduct = 0;
  let rowsWithQuantity = 0;
  let rowsWithRevenue = 0;
  let rowsWithDate = 0;
  let rowsWithCost = 0;

  // Derived business issue counts from actual record metadata
  let businessExcludedRevenue = 0;
  let businessExcludedQuantity = 0;
  let businessExcludedTrends = 0;
  let businessExcludedProduct = 0;
  let businessExcludedProfit = 0;
  let businessExcludedPayment = 0;
  let recordsWithWarnings = 0;

  for (const rec of records) {
    if (productOf(rec) && productOf(rec) !== 'Unknown' && !isExcludedFrom(rec, 'product_breakdown')) rowsWithProduct++;
    if (num(rec.quantity) > 0 && !isExcludedFrom(rec, 'quantity_metrics')) rowsWithQuantity++;
    if (revenueOf(rec) > 0 && !isExcludedFrom(rec, 'revenue_metrics')) rowsWithRevenue++;
    if (rec.transaction_date && String(rec.transaction_date).trim() !== '' && !isExcludedFrom(rec, 'trends')) rowsWithDate++;
    if (costOf(rec) > 0 && !isExcludedFrom(rec, 'profitability')) rowsWithCost++;

    // Count per-metric exclusions
    if (isExcludedFrom(rec, 'revenue_metrics') || isExcludedFrom(rec, 'revenue_warning')) businessExcludedRevenue++;
    if (isExcludedFrom(rec, 'quantity_metrics') || isExcludedFrom(rec, 'quantity_warning')) businessExcludedQuantity++;
    if (isExcludedFrom(rec, 'trends') || isExcludedFrom(rec, 'trends_warning')) businessExcludedTrends++;
    if (isExcludedFrom(rec, 'product_breakdown')) businessExcludedProduct++;
    if (isExcludedFrom(rec, 'profitability') || isExcludedFrom(rec, 'profitability_warning')) businessExcludedProfit++;
    if (isExcludedFrom(rec, 'payment_breakdown')) businessExcludedPayment++;

    const hasAnyWarning = (rec._quality?.excludedMetrics || []).length > 0;
    if (hasAnyWarning) recordsWithWarnings++;
  }

  const completeness = {
    productName: totalRows > 0 ? round((rowsWithProduct / totalRows) * 100) : 0,
    quantity: totalRows > 0 ? round((rowsWithQuantity / totalRows) * 100) : 0,
    revenue: totalRows > 0 ? round((rowsWithRevenue / totalRows) * 100) : 0,
    date: totalRows > 0 ? round((rowsWithDate / totalRows) * 100) : 0,
    costPrice: totalRows > 0 ? round((rowsWithCost / totalRows) * 100) : 0,
  };

  // Pipeline stage counts with structural + business breakdown
  const stages = {
    uploadedRows: qualityReport?.rowsUploaded || pipelineStats?.inputRows || totalRows,
    parsedRows: qualityReport?.rowsParsed || pipelineStats?.outputRows || totalRows,
    structurallyValidRows: qualityReport?.rowsStructurallyValid || qualityReport?.structuralValid || totalRows,
    businessValidRows: qualityReport?.rowsBusinessValid || qualityReport?.businessValid || totalRows,
    rowsUsedForAnalytics: qualityReport?.rowsUsedForAnalytics || totalRows,
    rowsExcluded: qualityReport?.rowsExcluded || 0,
    duplicatesRemoved: qualityReport?.duplicatesRemoved || pipelineStats?.duplicatesRemoved || 0,
    emptyRowsRemoved: pipelineStats?.emptyRemoved || 0,
  };

  // Quality distribution
  const qualityDist = qualityReport?.qualityDistribution || { excellent: totalRows, good: 0, fair: 0, poor: 0 };

  // Field-level quality
  const fieldQuality = qualityReport?.fieldQuality || {};

  // Split issue summaries from two-phase validation
  const structuralIssues = qualityReport?.structuralIssues || {};
  const businessIssues = qualityReport?.businessIssues || {};
  const structuralTotal = qualityReport?.structuralTotal || 0;
  const businessTotal = qualityReport?.businessTotal || 0;

  // Business rule violations (legacy)
  const businessRuleViolations = qualityReport?.businessRuleIssues
    ? Object.entries(qualityReport.businessRuleIssues).map(([rule, count]) => ({ rule, count }))
    : [];

  return {
    totalRecords: totalRows,
    pipelineStages: stages,
    qualityDistribution: qualityDist,
    productRecognition: {
      recognizedCount: productRecognition.recognized,
      unknownCount: productRecognition.unknown,
      recognitionRate: (productRecognition.recognized + productRecognition.unknown) > 0
        ? round((productRecognition.recognized / (productRecognition.recognized + productRecognition.unknown)) * 100)
        : 0,
      uniqueCanonicalDrugs: productRecognition.uniqueCanonicalDrugs || 0,
    },
    dataCompleteness: completeness,
    fieldQuality,
    structuralIssues,
    businessIssues,
    structuralTotal,
    businessTotal,
    derivedBusinessIssues: {
      revenueExcluded: businessExcludedRevenue,
      quantityExcluded: businessExcludedQuantity,
      trendsExcluded: businessExcludedTrends,
      productExcluded: businessExcludedProduct,
      profitExcluded: businessExcludedProfit,
      paymentExcluded: businessExcludedPayment,
      total: businessExcludedRevenue + businessExcludedQuantity + businessExcludedTrends + businessExcludedProduct + businessExcludedProfit + businessExcludedPayment,
      recordsWithWarnings,
    },
    businessRuleViolations,
    overallCompleteness: round(
      (completeness.productName + completeness.quantity + completeness.revenue +
       completeness.transaction_date + (completeness.costPrice || 0)) /
      (completeness.costPrice > 0 ? 5 : 4)
    ),
    cleaningIssues: cleaningReportSummary ? cleaningReportSummary.totalIssues || 0 : 0,
  };
}

// ---- main API ----------------------------------------------------------

/**
 * Compute all metrics from normalized records.
 *
 * @param {object[]} records — normalized records from the pipeline
 * @param {object} [meta] — metadata from pipeline (productNormalizationStats, cleaningReport)
 * @returns {object} — complete metrics document
 */
function computeAllMetrics(records, meta = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      overview: { totalRevenue: 0, totalQuantitySold: 0, transactionCount: 0, hasCostData: false },
      products: { totalDistinctProducts: 0, top10: [], bottom10: [] },
      trends: { months: [], monthCount: 0, trend: 'no_data' },
      payments: { methods: [], methodCount: 0 },
      categories: { categories: [] },
      health: { totalRecords: 0 },
      computedAt: new Date().toISOString(),
    };
  }

  const overview = computeOverview(records);
  const products = computeProductMetrics(records);
  const trends = computeMonthlyTrends(records);
  const payments = computePaymentMetrics(records);
  const categories = computeCategoryMetrics(records);
  const health = computeHealthMetrics(
    records,
    meta.productNormalizationStats,
    meta.cleaningReportSummary,
    meta.qualityReport,
    meta.cleaningStats,
  );

  return {
    overview,
    products,
    trends,
    payments,
    categories,
    health,
    computedAt: new Date().toISOString(),
    recordCount: records.length,
  };
}

module.exports = {
  computeAllMetrics,
  computeOverview,
  computeProductMetrics,
  computeMonthlyTrends,
  computePaymentMetrics,
  computeCategoryMetrics,
  computeHealthMetrics,
};
