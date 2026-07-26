/**
 * Analytics engine — works exclusively with normalized data.
 *
 * Phase 2: Uses canonical field names: product_name, quantity, revenue, cost_price, selling_price, date.
 * Backward compatible with legacy fields: product, price, cost.
 */

function num(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function parseMonth(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}/.test(s)) return s.substring(0, 7);
  return null;
}

// Backward-compatible field accessors
const productOf = (rec) => rec.canonical_product || rec.product_name || rec.product;
const priceOf = (rec) => rec.selling_price != null ? rec.selling_price : rec.price;
const costOf = (rec) => rec.cost_price != null ? rec.cost_price : rec.cost;

/**
 * Returns the TOTAL cost for a record.
 * When rec._cost_is_total is true, cost_price is already the per-row total
 * (determined by the normalizer's cost-mode detection). Otherwise cost is
 * treated as per-unit and multiplied by quantity.
 */
function totalCostOf(rec) {
  const unitCost = num(costOf(rec));
  if (unitCost <= 0) return 0;
  if (rec._cost_is_total === true) return unitCost;
  return unitCost * num(rec.quantity);
}

const revenueOf = (rec) => {
  if (rec.revenue != null) return num(rec.revenue);
  return num(priceOf(rec)) * num(rec.quantity);
};

// ---- key metrics -------------------------------------------------------

function calculateMetrics(normalizedRecords) {
  if (!normalizedRecords || normalizedRecords.length === 0) {
    return {
      totalRevenue: 0, totalQuantitySold: 0, averageSellingPrice: 0,
      grossProfit: null, grossMargin: null, averageTransactionValue: 0,
      totalCost: 0, recordCount: 0, transactionCount: 0,
    };
  }

  let totalRevenue = 0;
  let totalCost = 0;
  let totalQty = 0;
  let hasCost = false;
  let transactionCount = 0;

  for (const rec of normalizedRecords) {
    const rev = num(revenueOf(rec));
    const qty = num(rec.quantity);
    const tCost = totalCostOf(rec);

    totalRevenue += rev;

    // Sentinel guard: skip quantities that are obviously corrupted (>10 000 units
    // in a single transaction is unrealistic for a pharmacy and indicates a
    // placeholder value like 99999).
    if (qty <= 10000) totalQty += qty;

    if (tCost > 0) {
      totalCost += tCost;
      hasCost = true;
    }

    if (rev > 0) transactionCount++;
  }

  const avgSellingPrice = totalQty > 0 ? totalRevenue / totalQty : 0;
  const grossProfit = hasCost ? totalRevenue - totalCost : null;
  const grossMargin = hasCost && totalRevenue > 0
    ? ((totalRevenue - totalCost) / totalRevenue) * 100
    : null;
  const avgTxnValue = transactionCount > 0 ? totalRevenue / transactionCount : 0;

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalQuantitySold: Math.round(totalQty * 100) / 100,
    averageSellingPrice: Math.round(avgSellingPrice * 100) / 100,
    grossProfit: grossProfit !== null ? Math.round(grossProfit * 100) / 100 : null,
    grossMargin: grossMargin !== null ? Math.round(grossMargin * 100) / 100 : null,
    averageTransactionValue: Math.round(avgTxnValue * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    recordCount: normalizedRecords.length,
    transactionCount,
  };
}

// ---- monthly breakdown -------------------------------------------------

function monthlyRevenue(normalizedRecords) {
  const monthMap = {};

  for (const rec of normalizedRecords) {
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;
    const rev = num(revenueOf(rec));
    monthMap[month] = (monthMap[month] || 0) + rev;
  }

  return Object.entries(monthMap)
    .map(([month, revenue]) => ({ month, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ---- weekly breakdown --------------------------------------------------

function parseWeek(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  // Accept ISO date strings (YYYY-MM-DD) and compute ISO week
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d.getTime())) return null;
  // ISO week number
  const start = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d - start) / 86400000);
  const week = Math.ceil((days + start.getDay() + 1) / 7);
  return `${m[1]}-W${String(week).padStart(2, '0')}`;
}

function weeklyRevenue(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const week = parseWeek(rec.transaction_date);
    if (!week) continue;
    const rev = num(revenueOf(rec));
    map[week] = (map[week] || 0) + rev;
  }
  return Object.entries(map)
    .map(([week, revenue]) => ({ week, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

// ---- daily breakdown ---------------------------------------------------

function dailyRevenue(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const day = parseMonth(rec.transaction_date) ? String(rec.transaction_date).trim().substring(0, 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const rev = num(revenueOf(rec));
    map[day] = (map[day] || 0) + rev;
  }
  return Object.entries(map)
    .map(([day, revenue]) => ({ day, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ---- top products ------------------------------------------------------

function topProducts(normalizedRecords, limit = 10) {
  const productMap = {};

  for (const rec of normalizedRecords) {
    const name = productOf(rec) ? String(productOf(rec)).trim() : 'Unknown';
    if (!name) continue;

    const rev = num(revenueOf(rec));
    const qty = num(rec.quantity);

    if (!productMap[name]) {
      productMap[name] = { revenue: 0, quantity: 0, cost: 0, hasCost: false };
    }
    productMap[name].revenue += rev;
    productMap[name].quantity += qty;

    const tCost = totalCostOf(rec);
    if (tCost > 0) {
      productMap[name].cost += tCost;
      productMap[name].hasCost = true;
    }
  }

  return Object.entries(productMap)
    .map(([name, data]) => ({
      name,
      revenue: Math.round(data.revenue * 100) / 100,
      quantity: Math.round(data.quantity * 100) / 100,
      profit: data.hasCost
        ? Math.round((data.revenue - data.cost) * 100) / 100
        : null,
      margin: data.hasCost && data.revenue > 0
        ? Math.round(((data.revenue - data.cost) / data.revenue) * 10000) / 100
        : null,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

// ---- monthly profit breakdown ------------------------------------------

function monthlyProfit(normalizedRecords) {
  const monthMap = {};

  for (const rec of normalizedRecords) {
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;

    const rev = num(revenueOf(rec));
    const cost = totalCostOf(rec);

    if (!monthMap[month]) {
      monthMap[month] = { revenue: 0, cost: 0, hasCost: false };
    }
    monthMap[month].revenue += rev;
    if (cost > 0) {
      monthMap[month].cost += cost;
      monthMap[month].hasCost = true;
    }
  }

  return Object.entries(monthMap)
    .map(([month, data]) => ({
      month,
      revenue: Math.round(data.revenue * 100) / 100,
      cost: data.hasCost ? Math.round(data.cost * 100) / 100 : null,
      profit: data.hasCost
        ? Math.round((data.revenue - data.cost) * 100) / 100
        : null,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ---- summary report ----------------------------------------------------

function analyze(normalizedRecords) {
  if (!Array.isArray(normalizedRecords) || normalizedRecords.length === 0) {
    return {
      metrics: { totalRevenue: 0, totalQuantitySold: 0, averageSellingPrice: 0, recordCount: 0 },
      monthlyRevenue: [],
      topProducts: [],
      monthlyProfit: [],
    };
  }

  return {
    metrics: calculateMetrics(normalizedRecords),
    monthlyRevenue: monthlyRevenue(normalizedRecords),
    monthlyProfit: monthlyProfit(normalizedRecords),
    topProducts: topProducts(normalizedRecords),
  };
}

// ---- yearly breakdown ---------------------------------------------------

function parseYear(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  const m = /^(\d{4})/.exec(s);
  return m ? m[1] : null;
}

function yearlyRevenue(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const year = parseYear(rec.transaction_date);
    if (!year) continue;
    const rev = num(revenueOf(rec));
    map[year] = (map[year] || 0) + rev;
  }
  return Object.entries(map)
    .map(([year, revenue]) => ({ year, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => a.year.localeCompare(b.year));
}

// ---- time granularity detection ----------------------------------------

/**
 * Inspect the date range of the dataset and determine which time
 * aggregation levels (day, week, month, year) are meaningful.
 *
 * Rationale: a 5-day dataset should only show daily charts;
 * a multi-year dataset should unlock yearly aggregation.
 *
 * @returns {{ day: boolean, week: boolean, month: boolean, year: boolean, spanDays: number }}
 */
function detectTimeGranularity(records) {
  let minDate = null;
  let maxDate = null;

  for (const rec of records) {
    const raw = rec.transaction_date;
    if (raw == null || raw === '') continue;
    const s = String(raw).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) continue;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d.getTime())) continue;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }

  if (!minDate || !maxDate) {
    return { day: false, week: false, month: false, year: false, spanDays: 0 };
  }

  const spanDays = Math.max(1, Math.ceil((maxDate - minDate) / 86400000) + 1);

  return {
    day:    true,                    // daily always available when dates exist
    week:   spanDays >= 14,           // at least 2 weeks
    month:  spanDays >= 60,           // at least ~2 months
    year:   spanDays >= 365,          // at least ~1 year
    spanDays,
  };
}

module.exports = { analyze, calculateMetrics, monthlyRevenue, weeklyRevenue, dailyRevenue, yearlyRevenue, detectTimeGranularity, topProducts, monthlyProfit, weeklyProfit, dailyProfit, revenueByCategory, monthlyQuantity, weeklyQuantity, dailyQuantity, monthlyTransactionCount, weeklyTransactionCount, dailyTransactionCount, salesSeasonality, productPerformanceOverTime, revenueForecast, salesConcentrationRisk, profitLeakage };

// ---- transaction counts by period --------------------------------------

function monthlyTransactionCount(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;
    map[month] = (map[month] || 0) + 1;
  }
  return Object.entries(map)
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function weeklyTransactionCount(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const week = parseWeek(rec.transaction_date);
    if (!week) continue;
    map[week] = (map[week] || 0) + 1;
  }
  return Object.entries(map)
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

function dailyTransactionCount(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const day = parseMonth(rec.transaction_date) ? String(rec.transaction_date).trim().substring(0, 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    map[day] = (map[day] || 0) + 1;
  }
  return Object.entries(map)
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ---- monthly quantity trend -------------------------------------------

function monthlyQuantity(normalizedRecords) {
  const monthMap = {};

  for (const rec of normalizedRecords) {
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;
    const qty = num(rec.quantity);
    if (qty <= 0) continue;
    monthMap[month] = (monthMap[month] || 0) + qty;
  }

  return Object.entries(monthMap)
    .map(([month, quantity]) => ({ month, quantity: Math.round(quantity) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ---- weekly / daily quantity trend -------------------------------------

function weeklyQuantity(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const week = parseWeek(rec.transaction_date);
    if (!week) continue;
    const qty = num(rec.quantity);
    if (qty <= 0) continue;
    map[week] = (map[week] || 0) + qty;
  }
  return Object.entries(map)
    .map(([week, quantity]) => ({ week, quantity: Math.round(quantity) }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

function dailyQuantity(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const day = parseMonth(rec.transaction_date) ? String(rec.transaction_date).trim().substring(0, 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const qty = num(rec.quantity);
    if (qty <= 0) continue;
    map[day] = (map[day] || 0) + qty;
  }
  return Object.entries(map)
    .map(([day, quantity]) => ({ day, quantity: Math.round(quantity) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ---- weekly / daily profit breakdown -----------------------------------

function weeklyProfit(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const week = parseWeek(rec.transaction_date);
    if (!week) continue;

    const rev = num(revenueOf(rec));
    const cost = totalCostOf(rec);

    if (!map[week]) map[week] = { revenue: 0, cost: 0, hasCost: false };
    map[week].revenue += rev;
    if (cost > 0) {
      map[week].cost += cost;
      map[week].hasCost = true;
    }
  }
  return Object.entries(map)
    .map(([week, data]) => ({
      week,
      revenue: Math.round(data.revenue * 100) / 100,
      cost: data.hasCost ? Math.round(data.cost * 100) / 100 : null,
      profit: data.hasCost ? Math.round((data.revenue - data.cost) * 100) / 100 : null,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

function dailyProfit(normalizedRecords) {
  const map = {};
  for (const rec of normalizedRecords) {
    const day = parseMonth(rec.transaction_date) ? String(rec.transaction_date).trim().substring(0, 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    const rev = num(revenueOf(rec));
    const cost = totalCostOf(rec);

    if (!map[day]) map[day] = { revenue: 0, cost: 0, hasCost: false };
    map[day].revenue += rev;
    if (cost > 0) {
      map[day].cost += cost;
      map[day].hasCost = true;
    }
  }
  return Object.entries(map)
    .map(([day, data]) => ({
      day,
      revenue: Math.round(data.revenue * 100) / 100,
      cost: data.hasCost ? Math.round(data.cost * 100) / 100 : null,
      profit: data.hasCost ? Math.round((data.revenue - data.cost) * 100) / 100 : null,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ---- sales seasonality (multi-year overlay) --------------------------

/**
 * Computes seasonality patterns by grouping revenue by calendar month
 * across multiple years. Output is structured for a multi-line overlay
 * chart where each year is its own line and the X-axis is Jan-Dec.
 *
 * Returns null if fewer than 12 months of data exist (seasonality is
 * not meaningful on short time spans).
 */
function salesSeasonality(normalizedRecords) {
  // Build year×month pivot: { "2024": { "01": 150000, "02": 200000, ... }, ... }
  const pivot = {};
  const monthTotals = {}; // aggregate across all years for seasonality index

  for (const rec of normalizedRecords) {
    const date = rec.transaction_date;
    if (date == null || date === '') continue;
    const s = String(date).trim();
    const m = /^(\d{4})-(\d{2})/.exec(s);
    if (!m) continue;
    const year = m[1];
    const month = m[2];
    const rev = num(revenueOf(rec));

    if (!pivot[year]) pivot[year] = {};
    pivot[year][month] = (pivot[year][month] || 0) + rev;
    monthTotals[month] = (monthTotals[month] || 0) + rev;
  }

  const years = Object.keys(pivot).sort();
  if (years.length === 0) return null;

  // Determine how many distinct months exist across the dataset
  const allMonths = Object.keys(monthTotals).sort();
  if (allMonths.length < 2) return null;

  // Build multi-series: each year → array of { x: month, y: revenue }
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const series = [];
  let totalRevenue = 0;
  let totalDataPoints = 0;

  for (const year of years) {
    const data = [];
    for (let m = 1; m <= 12; m++) {
      const monthKey = String(m).padStart(2, '0');
      const rev = Math.round((pivot[year][monthKey] || 0) * 100) / 100;
      data.push({ x: monthNames[m - 1], y: rev });
      if (rev > 0) {
        totalRevenue += rev;
        totalDataPoints++;
      }
    }
    series.push({ name: year, data });
  }

  // ---- compute seasonality index per calendar month -------------------
  // Index = (avg revenue in that month across years) / (overall avg monthly)
  const overallAvg = totalDataPoints > 0 ? totalRevenue / totalDataPoints : 0;

  const seasonalityIndex = [];
  for (let m = 1; m <= 12; m++) {
    const monthKey = String(m).padStart(2, '0');
    const total = monthTotals[monthKey] || 0;
    const yearsWithData = years.filter(y => pivot[y][monthKey] > 0).length;
    const avg = yearsWithData > 0 ? total / yearsWithData : 0;
    const index = overallAvg > 0 ? Math.round((avg / overallAvg) * 100) : 100;
    seasonalityIndex.push({
      month: monthNames[m - 1],
      monthKey,
      avgRevenue: Math.round(avg * 100) / 100,
      index, // 100 = average, >100 = above avg, <100 = below avg
    });
  }

  // ---- identify peak and trough months --------------------------------
  const activeMonths = seasonalityIndex.filter(s => s.index > 0);
  let peakMonth = activeMonths[0];
  let troughMonth = activeMonths[0];
  for (const s of activeMonths) {
    if (s.index > (peakMonth?.index || 0)) peakMonth = s;
    if (s.index < (troughMonth?.index || Infinity)) troughMonth = s;
  }

  // ---- pattern classification -----------------------------------------
  const peakRatio = troughMonth && troughMonth.index > 0
    ? peakMonth.index / troughMonth.index
    : 1;
  const isHighlySeasonal = peakRatio >= 1.8;
  const isModeratelySeasonal = peakRatio >= 1.35;

  let patternType;
  let patternSubtitle;

  if (years.length === 1) {
    patternType = 'Insufficient History';
    patternSubtitle = `Only ${years[0]} data available. Seasonality requires multiple years of history for reliable patterns.`;
  } else if (isHighlySeasonal) {
    patternType = 'Highly Seasonal';
    patternSubtitle = `${peakMonth.month} consistently delivers ~${peakMonth.index}% of the average month while ${troughMonth.month} drops to ~${troughMonth.index}%. Demand swings are large and predictable — plan inventory and staffing around them.`;
  } else if (isModeratelySeasonal) {
    patternType = 'Moderately Seasonal';
    patternSubtitle = `${peakMonth.month} tends to be the strongest month (~${peakMonth.index}% of average) with ${troughMonth.month} being the weakest (~${troughMonth.index}%). Moderate seasonal swings — adjust purchasing 4-6 weeks ahead of ${peakMonth.month}.`;
  } else {
    patternType = 'Relatively Stable';
    patternSubtitle = `Monthly demand is fairly even across the year (range: ${troughMonth.index}%–${peakMonth.index}% of average). Revenue is consistent month-to-month — focus on growing the baseline rather than seasonal preparation.`;
  }

  // ---- build chart-friendly pivot data for the stacked-area renderer --
  const chartData = [];
  for (let m = 1; m <= 12; m++) {
    const monthKey = String(m).padStart(2, '0');
    const point = { month: monthNames[m - 1] };
    for (const year of years) {
      point[year] = Math.round((pivot[year][monthKey] || 0) * 100) / 100;
    }
    chartData.push(point);
  }

  return {
    series,
    years,
    chartData, // { month, "2024": ..., "2025": ... }
    categories: years, // for legend
    seasonalityIndex,
    peakMonth: peakMonth ? { month: peakMonth.month, index: peakMonth.index, avgRevenue: peakMonth.avgRevenue } : null,
    troughMonth: troughMonth ? { month: troughMonth.month, index: troughMonth.index, avgRevenue: troughMonth.avgRevenue } : null,
    patternType,
    patternSubtitle,
    peakRatio: Math.round(peakRatio * 100) / 100,
    overallMonthlyAvg: Math.round(overallAvg * 100) / 100,
    monthsOfData: allMonths.length,
  };
}

// ---- product performance over time (heatmap) ------------------------

/**
 * Tracks monthly revenue per product to reveal which products are
 * improving, declining, or stable. Returns a pivot table for heatmap
 * rendering plus momentum scores for each product.
 */
function productPerformanceOverTime(normalizedRecords, topN = 12) {
  // Step 1: identify top N products by total revenue
  const productTotals = {};
  for (const rec of normalizedRecords) {
    const name = productOf(rec) ? String(productOf(rec)).trim() : '';
    if (!name) continue;
    const rev = num(revenueOf(rec));
    productTotals[name] = (productTotals[name] || 0) + rev;
  }
  const topNames = Object.entries(productTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name);

  // Step 2: build product × month pivot
  const monthSet = new Set();
  const pivot = {}; // { product: { "2025-01": 15000, ... } }

  for (const rec of normalizedRecords) {
    const name = productOf(rec) ? String(productOf(rec)).trim() : '';
    if (!name || !topNames.includes(name)) continue;
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;
    const rev = num(revenueOf(rec));

    monthSet.add(month);
    if (!pivot[name]) pivot[name] = {};
    pivot[name][month] = (pivot[name][month] || 0) + rev;
  }

  const months = [...monthSet].sort();
  if (months.length < 2 || topNames.length === 0) return null;

  const monthLabels = months.map((m) => {
    const parts = m.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthIdx = parseInt(parts[1], 10) - 1;
    return monthIdx >= 0 && monthIdx < 12
      ? `${monthNames[monthIdx]} ${parts[0].slice(2)}`
      : m;
  });

  // Step 3: compute momentum per product (linear regression on monthly revenue)
  const productAnalysis = [];
  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (const name of topNames) {
    const productData = pivot[name] || {};
    const values = months.map((m) => Math.round((productData[m] || 0) * 100) / 100);
    const totalRev = values.reduce((s, v) => s + v, 0);

    // Simple linear regression: month index vs revenue
    const n = months.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
    const avgMonthly = n > 0 ? totalRev / n : 0;
    const momentum = avgMonthly > 0 ? (slope / avgMonthly) * 100 : 0;
    // momentum: positive = growing, negative = declining (as % of avg monthly revenue per month)

    // Classify trajectory
    let trajectory;
    if (momentum > 5) trajectory = 'Growing';
    else if (momentum < -5) trajectory = 'Declining';
    else trajectory = 'Stable';

    // Track min/max for heatmap color scale
    for (const v of values) {
      if (v > 0 && v < globalMin) globalMin = v;
      if (v > globalMax) globalMax = v;
    }

    productAnalysis.push({
      name,
      values,
      totalRevenue: Math.round(totalRev * 100) / 100,
      avgMonthly: Math.round(avgMonthly * 100) / 100,
      momentum: Math.round(momentum * 10) / 10,
      trajectory,
      slope: Math.round(slope * 100) / 100,
    });
  }

  // Sort: declining first, then stable, then growing (loss detection)
  productAnalysis.sort((a, b) => {
    const order = { Declining: 0, Stable: 1, Growing: 2 };
    return (order[a.trajectory] ?? 1) - (order[b.trajectory] ?? 1);
  });

  // Identify products losing momentum (declining)
  const losingMomentum = productAnalysis.filter(p => p.trajectory === 'Declining');
  const gainingMomentum = productAnalysis.filter(p => p.trajectory === 'Growing');

  // Build insight
  let insightTitle, insightSubtitle;
  if (losingMomentum.length > 0) {
    const names = losingMomentum.slice(0, 3).map(p => p.name).join(', ');
    insightTitle = `${losingMomentum.length} product${losingMomentum.length > 1 ? 's' : ''} losing momentum`;
    insightSubtitle = `${names} ${losingMomentum.length === 1 ? 'is' : 'are'} trending downward. Review pricing, promotion, or placement before these products become dead stock.`;
  } else if (gainingMomentum.length > 0) {
    insightTitle = `All products stable or growing`;
    insightSubtitle = `${gainingMomentum.length} product${gainingMomentum.length > 1 ? 's' : ''} showing positive momentum. Double down on what's working — increase stock for growing products.`;
  } else {
    insightTitle = 'Product performance is steady';
    insightSubtitle = 'No significant upward or downward trends detected. The portfolio is stable month-to-month.';
  }

  return {
    products: productAnalysis,
    months,
    monthLabels,
    globalMin: globalMin === Infinity ? 0 : Math.round(globalMin * 100) / 100,
    globalMax: globalMax === -Infinity ? 0 : Math.round(globalMax * 100) / 100,
    losingMomentum: losingMomentum.map(p => ({ name: p.name, momentum: p.momentum, totalRevenue: p.totalRevenue })),
    gainingMomentum: gainingMomentum.map(p => ({ name: p.name, momentum: p.momentum, totalRevenue: p.totalRevenue })),
    insight: {
      title: insightTitle,
      subtitle: insightSubtitle,
    },
  };
}

// ---- revenue forecast (time series projection) ----------------------

/**
 * Simple time-series forecast using linear regression on monthly revenue.
 * Projects the next 1-3 months with confidence bands based on historical
 * residual error.
 *
 * Requires at least 3 months of data; accuracy improves with 12+ months.
 */
function revenueForecast(normalizedRecords, forecastMonths = 3) {
  // Step 1: aggregate revenue by month
  const monthMap = {};
  for (const rec of normalizedRecords) {
    const month = parseMonth(rec.transaction_date);
    if (!month) continue;
    const rev = num(revenueOf(rec));
    monthMap[month] = (monthMap[month] || 0) + rev;
  }

  const sortedMonths = Object.keys(monthMap).sort();
  if (sortedMonths.length < 3) return null;

  const historical = sortedMonths.map((m, i) => ({
    month: m,
    index: i,
    revenue: Math.round(monthMap[m] * 100) / 100,
  }));

  // Step 2: linear regression (month index → revenue)
  const n = historical.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of historical) {
    sumX += p.index;
    sumY += p.revenue;
    sumXY += p.index * p.revenue;
    sumX2 += p.index * p.index;
  }
  const denominator = n * sumX2 - sumX * sumX;
  const slope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
  const intercept = (sumY - slope * sumX) / n;

  // Step 3: compute residuals for confidence band
  const fitted = historical.map(p => intercept + slope * p.index);
  let sumSqResiduals = 0;
  for (let i = 0; i < n; i++) {
    const err = historical[i].revenue - fitted[i];
    sumSqResiduals += err * err;
  }
  const rmse = Math.sqrt(sumSqResiduals / n);

  // Step 4: project forecast months
  const forecast = [];
  const lastIndex = n - 1;
  for (let f = 1; f <= forecastMonths; f++) {
    const idx = lastIndex + f;
    const predicted = Math.round((intercept + slope * idx) * 100) / 100;
    // 80% confidence band: ±1.28 * RMSE
    const band = Math.round(1.28 * rmse * 100) / 100;
    const upper = Math.round((predicted + band) * 100) / 100;
    const lower = Math.round(Math.max(0, predicted - band) * 100) / 100;

    // Format forecast month label
    const lastMonth = sortedMonths[lastIndex];
    const [y, m] = lastMonth.split('-').map(Number);
    const forecastDate = new Date(y, m - 1 + f, 1);
    const forecastMonth = forecastDate.toISOString().substring(0, 7);

    forecast.push({
      month: forecastMonth,
      index: idx,
      predicted,
      upper,
      lower,
      band,
    });
  }

  // Step 5: build chart data (historical + forecast extension)
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatLabel(monthStr) {
    const [y, m] = monthStr.split('-').map(Number);
    const mi = m - 1;
    return mi >= 0 && mi < 12 ? `${monthNames[mi]} ${String(y).slice(2)}` : monthStr;
  }

  const chartData = historical.map(p => ({
    label: formatLabel(p.month),
    month: p.month,
    revenue: p.revenue,
    isForecast: false,
  }));

  // Connect last historical point to first forecast point
  const lastHistorical = chartData[chartData.length - 1];
  if (lastHistorical && forecast.length > 0) {
    lastHistorical.forecastRevenue = lastHistorical.revenue;
    lastHistorical.forecastUpper = lastHistorical.revenue;
    lastHistorical.forecastLower = lastHistorical.revenue;
  }

  for (const f of forecast) {
    chartData.push({
      label: formatLabel(f.month),
      month: f.month,
      revenue: null,
      forecastRevenue: f.predicted,
      forecastUpper: f.upper,
      forecastLower: f.lower,
      isForecast: true,
    });
  }

  // Step 6: build insight
  const lastRev = historical[n - 1].revenue;
  const nextRev = forecast[0]?.predicted || 0;
  const pctChange = lastRev > 0 ? Math.round(((nextRev - lastRev) / lastRev) * 1000) / 10 : 0;
  const direction = pctChange >= 0 ? 'grow' : 'decline';
  const absPct = Math.abs(pctChange);

  const totalMonthly = historical.reduce((s, p) => s + p.revenue, 0);
  const avgMonthly = Math.round(totalMonthly / n);

  const rSquared = (() => {
    const meanY = sumY / n;
    let ssTot = 0;
    for (const p of historical) ssTot += (p.revenue - meanY) ** 2;
    return ssTot > 0 ? Math.round((1 - sumSqResiduals / ssTot) * 100) : 0;
  })();

  let insightTitle, insightSubtitle;
  if (forecast.length > 0) {
    const fmt = (v) => '₦' + Number(v).toLocaleString('en-NG');
    insightTitle = `Next month projected at ${fmt(nextRev)}`;
    insightSubtitle = `Revenue is forecast to ${direction} ${absPct}% vs. the current month (${fmt(lastRev)}). R² = ${rSquared}% — ${rSquared >= 70 ? 'strong historical fit, forecast is reliable.' : rSquared >= 40 ? 'moderate fit; use forecast directionally.' : 'high variability; use forecast as a rough guide only.'}`;
  } else {
    insightTitle = 'Insufficient data for forecasting';
    insightSubtitle = 'At least 3 months of revenue data are needed to produce a meaningful forecast.';
  }

  return {
    historical,
    forecast,
    chartData,
    slope: Math.round(slope * 100) / 100,
    intercept: Math.round(intercept * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    rSquared,
    avgMonthly,
    lastMonthRevenue: lastRev,
    nextMonthForecast: nextRev,
    pctChange,
    direction,
    monthsOfData: n,
    insight: {
      title: insightTitle,
      subtitle: insightSubtitle,
    },
  };
}

// ---- sales concentration risk ---------------------------------------

/**
 * Measures revenue concentration to detect over-dependence on a few products.
 *
 * Computes:
 *   - Each product's share of total revenue
 *   - Cumulative share (Pareto series)
 *   - HHI (Herfindahl-Hirschman Index) for overall concentration
 *   - Top-N concentration ratios (CR3, CR5)
 *   - Risk classification
 */
function salesConcentrationRisk(normalizedRecords) {
  // Aggregate revenue per product
  const productRev = {};
  for (const rec of normalizedRecords) {
    const name = productOf(rec) ? String(productOf(rec)).trim() : '';
    if (!name) continue;
    productRev[name] = (productRev[name] || 0) + num(revenueOf(rec));
  }

  const entries = Object.entries(productRev)
    .map(([product, revenue]) => ({ product, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);

  const totalRev = entries.reduce((s, e) => s + e.revenue, 0);
  if (totalRev === 0 || entries.length < 2) return null;

  // Compute share & cumulative share
  let cumShare = 0;
  const paretoData = entries.map((e) => {
    const share = Math.round((e.revenue / totalRev) * 10000) / 100;
    cumShare += share;
    return {
      product: e.product,
      revenue: e.revenue,
      share,
      cumulative: Math.round(Math.min(cumShare, 100) * 100) / 100,
    };
  });

  // Top 10 for the donut
  const top10 = paretoData.slice(0, 10);
  const otherRevenue = paretoData.slice(10).reduce((s, e) => s + e.revenue, 0);
  const otherShare = Math.round((otherRevenue / totalRev) * 10000) / 100;

  // HHI: sum of squared market shares (0-10,000 scale)
  const hhi = Math.round(paretoData.reduce((s, e) => s + (e.share * e.share), 0));
  // CR3, CR5
  const cr3 = Math.round(paretoData.slice(0, 3).reduce((s, e) => s + e.share, 0));
  const cr5 = Math.round(paretoData.slice(0, 5).reduce((s, e) => s + e.share, 0));
  const top1Share = paretoData[0]?.share || 0;

  // Risk classification
  let riskLevel, riskTitle, riskSubtitle;
  if (top1Share >= 40 || cr3 >= 70 || hhi >= 2500) {
    riskLevel = 'High';
    riskTitle = `High concentration risk — ${paretoData[0].product} drives ${cr3}% of revenue`;
    riskSubtitle = `The top 3 products account for ${cr3}% of total revenue (HHI: ${hhi}). Losing any one would severely impact the business. Diversify your product mix and invest in growing mid-tier products to reduce dependence.`;
  } else if (top1Share >= 25 || cr3 >= 50 || hhi >= 1500) {
    riskLevel = 'Moderate';
    riskTitle = `Moderate concentration — top 3 products contribute ${cr3}% of revenue`;
    riskSubtitle = `Revenue is somewhat concentrated (HHI: ${hhi}). While not critical, expanding your product range would improve resilience. Focus on growing products ranked 4-8 to balance the portfolio.`;
  } else {
    riskLevel = 'Low';
    riskTitle = `Well diversified — revenue is spread across ${entries.length} products`;
    riskSubtitle = `No single product or small group dominates (HHI: ${hhi}, CR3: ${cr3}%). The business has healthy diversification. Maintain this balance as you grow.`;
  }

  return {
    paretoData,
    top10,
    otherRevenue,
    otherShare,
    totalRevenue: totalRev,
    hhi,
    cr3,
    cr5,
    top1Share,
    riskLevel,
    insight: {
      title: riskTitle,
      subtitle: riskSubtitle,
    },
    productCount: entries.length,
    // Donut data: top 10 + "Other" slice
    donutData: [
      ...top10.map(p => ({ name: p.product, value: p.revenue, share: p.share })),
      ...(otherRevenue > 0 ? [{ name: 'Other Products', value: Math.round(otherRevenue * 100) / 100, share: Math.round(otherShare * 100) / 100 }] : []),
    ],
  };
}

// ---- profit leakage detector ----------------------------------------

/**
 * "Where Is Profit Leaking?" — Decision Intelligence Widget.
 *
 * Deterministic analytics that identifies products eroding gross profit
 * using four evidence-based rules:
 *   1. High Revenue, Low Margin
 *   2. Sold Below Cost
 *   3. Low Profit Contribution
 *   4. Margin Below Target
 *
 * Every output is traceable to the underlying data. No generative AI.
 *
 * @param {Array} normalizedRecords
 * @param {number} targetMargin - default 25%
 * @param {number} highRevenuePercentile - top N% rank considered "high revenue", default 20
 * @param {number} lowContributionThreshold - products below this % of total GP are "low", default 1
 */
function profitLeakage(normalizedRecords, targetMargin = 25, highRevenuePercentile = 20, lowContributionThreshold = 1) {
  // ---- Step 1: aggregate per-product metrics --------------------------
  const productMap = {}; // { name: { revenue, totalCost, qty, hasCost, belowCostCount, belowCostAmount } }

  for (const rec of normalizedRecords) {
    const name = productOf(rec) ? String(productOf(rec)).trim() : '';
    if (!name) continue;

    const qty = num(rec.quantity);
    const rev = num(revenueOf(rec));
    const unitCost = num(costOf(rec));
    const tCost = totalCostOf(rec);

    if (!productMap[name]) {
      productMap[name] = {
        revenue: 0, totalCost: 0, qty: 0, hasCost: false,
        belowCostCount: 0, belowCostAmount: 0,
      };
    }
    const p = productMap[name];
    p.revenue += rev;
    p.totalCost += tCost;
    p.qty += qty;
    if (tCost > 0 || unitCost > 0) p.hasCost = true;

    // Check if individual sale was below cost
    if (unitCost > 0 && num(priceOf(rec)) < unitCost) {
      p.belowCostCount++;
      p.belowCostAmount += (unitCost - num(priceOf(rec))) * qty;
    }
  }

  let products = Object.entries(productMap).map(([name, p]) => {
    const grossProfit = p.hasCost ? p.revenue - p.totalCost : 0;
    const grossMargin = p.hasCost && p.revenue > 0
      ? Math.round((grossProfit / p.revenue) * 10000) / 100
      : null;
    return {
      product: name,
      revenue: Math.round(p.revenue * 100) / 100,
      totalCost: Math.round(p.totalCost * 100) / 100,
      quantity: Math.round(p.qty * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      grossMargin,
      hasCost: p.hasCost,
      belowCostCount: p.belowCostCount,
      belowCostAmount: Math.round(p.belowCostAmount * 100) / 100,
    };
  });

  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalGrossProfit = products.reduce((s, p) => s + p.grossProfit, 0);
  const hasAnyCost = products.some(p => p.hasCost);

  if (products.length < 2 || totalRevenue === 0) {
    return { error: 'Insufficient product data for profit leakage analysis.' };
  }

  if (!hasAnyCost) {
    return {
      error: 'Profit Leakage Analysis cannot be performed because Cost Price is unavailable.',
      costUnavailable: true,
    };
  }

  // ---- Step 2: rank products by revenue, compute percentiles ----------
  products.sort((a, b) => b.revenue - a.revenue);
  const highRevenueCutoffRank = Math.max(1, Math.ceil(products.length * (highRevenuePercentile / 100)));

  // ---- Step 3: apply rules & severity --------------------------------
  const totalGP = products.reduce((s, p) => s + p.grossProfit, 0);
  const totalMargin = totalRevenue > 0 ? Math.round((totalGP / totalRevenue) * 10000) / 100 : 0;

  const classified = products.map((p, i) => {
    const revenueRank = i + 1;
    const isHighRevenue = revenueRank <= highRevenueCutoffRank;
    const soldBelowCost = p.hasCost && p.grossProfit < 0;
    const marginBelowTarget = p.hasCost && p.grossMargin !== null && p.grossMargin < targetMargin;
    const profitContribution = totalGP > 0 ? Math.round((p.grossProfit / totalGP) * 10000) / 100 : 0;
    const isLowContribution = profitContribution < lowContributionThreshold && profitContribution >= 0;

    // Determine severity
    let severity;
    if (soldBelowCost) {
      severity = 'Critical';
    } else if (isHighRevenue && marginBelowTarget) {
      severity = 'High';
    } else if (isLowContribution && marginBelowTarget) {
      severity = 'Medium';
    } else if (marginBelowTarget) {
      severity = 'Medium';
    } else {
      severity = 'Healthy';
    }

    // Rules triggered
    const rules = [];
    if (isHighRevenue && marginBelowTarget && !soldBelowCost) rules.push('High Revenue, Low Margin');
    if (soldBelowCost) rules.push('Sold Below Cost');
    if (isLowContribution && !soldBelowCost) rules.push('Low Profit Contribution');
    if (marginBelowTarget) rules.push('Margin Below Target');

    return {
      ...p,
      revenueRank,
      isHighRevenue,
      soldBelowCost,
      marginBelowTarget,
      profitContribution,
      isLowContribution,
      severity,
      rules,
    };
  });

  // ---- Step 4: products below target (for summary) -------------------
  const belowTarget = classified.filter(p => p.marginBelowTarget);
  const productsBelowCost = classified.filter(p => p.soldBelowCost);

  // ---- Step 5: estimate opportunity ----------------------------------
  // For products below target margin (but not below cost), compute:
  // what if their margin was raised to the target?
  let estimatedOpportunity = 0;
  for (const p of belowTarget) {
    if (p.soldBelowCost) continue; // can't just raise price on these
    const targetGP = p.revenue * (targetMargin / 100);
    const gap = Math.max(0, targetGP - p.grossProfit);
    estimatedOpportunity += gap;
  }
  estimatedOpportunity = Math.round(estimatedOpportunity * 100) / 100;

  // Highest leakage product
  const highestLeakage = belowTarget.length > 0
    ? belowTarget.sort((a, b) => {
        const gapA = a.revenue * (targetMargin / 100) - a.grossProfit;
        const gapB = b.revenue * (targetMargin / 100) - b.grossProfit;
        return gapB - gapA;
      })[0]
    : null;

  // ---- Step 6: deterministic insights --------------------------------

  const insights = [];

  // Insight: high-revenue low-margin count
  const highRevLowMargin = classified.filter(p => p.isHighRevenue && p.marginBelowTarget && !p.soldBelowCost);
  if (highRevLowMargin.length > 0) {
    const theirRevenue = Math.round(highRevLowMargin.reduce((s, p) => s + p.revenue, 0));
    const theirShare = Math.round((theirRevenue / totalRevenue) * 100);
    insights.push(
      `${highRevLowMargin.length} product${highRevLowMargin.length > 1 ? 's' : ''} account${highRevLowMargin.length === 1 ? 's' : ''} for ${theirShare}% of total revenue but ${highRevLowMargin.length === 1 ? 'has' : 'have'} margins below the configured target of ${targetMargin}%.`
    );
  }

  // Insight: below cost
  if (productsBelowCost.length > 0) {
    const names = productsBelowCost.map(p => p.product).join(', ');
    insights.push(
      `${productsBelowCost.length} product${productsBelowCost.length > 1 ? 's' : ''} ${productsBelowCost.length === 1 ? 'is' : 'are'} being sold below recorded cost price: ${names}.`
    );
  }

  // Insight: low contribution despite volume
  const lowContribHighVolume = classified.filter(p => p.isLowContribution && p.revenue > 0 && !p.soldBelowCost);
  if (lowContribHighVolume.length > 0) {
    const theirRevenue = Math.round(lowContribHighVolume.reduce((s, p) => s + p.revenue, 0));
    const theirRevShare = Math.round((theirRevenue / totalRevenue) * 100);
    insights.push(
      `${lowContribHighVolume.length} product${lowContribHighVolume.length > 1 ? 's' : ''} contribute${lowContribHighVolume.length === 1 ? 's' : ''} less than ${lowContributionThreshold}% of total gross profit despite representing ${theirRevShare}% of sales revenue.`
    );
  }

  // Insight: overall margin context
  if (belowTarget.length > 0) {
    const avgMarginBelow = Math.round(belowTarget.reduce((s, p) => s + (p.grossMargin || 0), 0) / belowTarget.length);
    insights.push(
      `${belowTarget.length} of ${classified.length} products are below the ${targetMargin}% margin target, with an average margin of ${avgMarginBelow}%.`
    );
  }

  // ---- Step 7: business interpretation -------------------------------
  let businessInterpretation;
  if (highRevLowMargin.length > productsBelowCost.length) {
    businessInterpretation = `Most profit leakage comes from high-volume products with below-target margins rather than from products sold at a loss. The biggest opportunity is margin improvement on your top-selling products.`;
  } else if (productsBelowCost.length > 0) {
    businessInterpretation = `The most urgent issue is products being sold below their recorded cost price. These products are directly eroding profit with every sale. Address pricing on these items immediately.`;
  } else {
    businessInterpretation = `Profit leakage is distributed across multiple products with margins below the ${targetMargin}% target. A systematic margin review across the portfolio is recommended.`;
  }

  // ---- Step 8: recommended action -----------------------------------
  let recommendedAction;
  if (highRevLowMargin.length > 0 && productsBelowCost.length === 0) {
    const top5Names = highRevLowMargin.slice(0, 5).map(p => p.product).join(', ');
    recommendedAction = `Review pricing for the highest-revenue products with below-target margins: ${top5Names}. A modest price increase on these products would have outsized impact on overall profitability.`;
  } else if (productsBelowCost.length > 0) {
    const names = productsBelowCost.map(p => p.product).join(', ');
    recommendedAction = `Immediately investigate products being sold below recorded cost price: ${names}. Verify the cost data is correct. If it is, either raise selling prices or discontinue these products.`;
  } else if (highRevLowMargin.length > 0 && productsBelowCost.length > 0) {
    recommendedAction = `First, address products sold below cost (${productsBelowCost.map(p => p.product).join(', ')}). Then, review pricing for the high-revenue, low-margin products: ${highRevLowMargin.slice(0, 3).map(p => p.product).join(', ')}.`;
  } else {
    recommendedAction = `Review purchase costs before increasing sales volume of low-margin products. Negotiate better supplier terms on your top 5 products by volume.`;
  }

  // ---- Step 9: expected business impact ------------------------------
  let expectedImpact;
  if (estimatedOpportunity > 0) {
    expectedImpact = `Increasing the average gross margin of the ${belowTarget.length} flagged products from ${Math.round(belowTarget.reduce((s, p) => s + (p.grossMargin || 0), 0) / belowTarget.length)}% to ${targetMargin}% would increase gross profit by approximately ₦${Math.round(estimatedOpportunity).toLocaleString('en-NG')}.`;
  } else {
    expectedImpact = `All products meet or exceed the ${targetMargin}% margin target. No margin-based profit leakage detected. Monitor quarterly to maintain performance.`;
  }

  // ---- Step 10: scatter chart data -----------------------------------
  const chartData = classified
    .filter(p => p.hasCost && p.revenue > 0)
    .map(p => ({
      name: p.product,
      revenue: p.revenue,
      margin: p.grossMargin !== null ? p.grossMargin : 0,
      grossProfit: p.grossProfit,
      severity: p.severity,
      quantity: p.quantity,
    }));

  // Confidence: based on cost data coverage
  const productsWithCost = classified.filter(p => p.hasCost).length;
  const confidence = products.length > 0
    ? Math.round((productsWithCost / products.length) * 100)
    : 0;

  return {
    // Core output
    title: 'Where Is Profit Leaking?',
    subtitle: 'Identify products generating sales but failing to generate healthy profits.',
    summary: {
      productsBelowTarget: belowTarget.length,
      averageMargin: totalMargin,
      estimatedOpportunity,
      highestLeakageProduct: highestLeakage ? highestLeakage.product : null,
    },
    chartData,
    products: classified,
    totalRevenue,
    totalGrossProfit: totalGP,
    targetMargin,
    productsBelowCost,
    highRevLowMargin,
    // Insights
    insights,
    businessInterpretation,
    recommendedAction,
    expectedImpact,
    confidence,
    costAvailable: true,
  };
}

// ---- revenue by category (no-date fallback) ----------------------------

function revenueByCategory(normalizedRecords) {
  const catMap = {};

  for (const rec of normalizedRecords) {
    const cat = (rec.category || '').toString().trim();
    const label = cat || 'Uncategorized';
    const rev = num(revenueOf(rec));
    if (rev <= 0) continue;
    catMap[label] = (catMap[label] || 0) + rev;
  }

  return Object.entries(catMap)
    .map(([category, revenue]) => ({ category, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);
}
