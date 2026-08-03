/**
 * Business Health Framework — Five-pillar scoring model for pharmacy performance.
 *
 * Pillars are weighted to reflect their relative importance to a retail pharmacy.
 * Each pillar contains metric definitions with scoring functions that produce
 * normalized 0–100 scores.
 *
 * Total weight = 100%.
 */

// ---- helpers -----------------------------------------------------------

const round = (n, d = 1) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};

/** Clamp and round a value to [0, 100]. */
function clampScore(v) {
  return Math.max(0, Math.min(100, round(v, 1)));
}

/**
 * Score a value against 4-tier thresholds.
 * Returns { score: 0–100, band, detail }.
 *
 * @param {number}  value      — the raw value to score
 * @param {{ excellent: number, good: number, fair: number, poor: number }} thresholds — boundary values
 * @param {{ higherIsBetter: boolean }} opts
 */
function scoreFourTier(value, thresholds, { higherIsBetter = true } = {}) {
  const { excellent, good, fair, poor } = thresholds;
  if (higherIsBetter) {
    if (value >= excellent) return { score: 100, band: 'good' };
    if (value >= good)     return { score: clampScore(lerp(value, good, 50, excellent, 100)), band: 'good' };
    if (value >= fair)     return { score: clampScore(lerp(value, fair, 25, good, 50)), band: 'fair' };
    if (value >= poor)     return { score: clampScore(lerp(value, poor, 0, fair, 25)), band: 'warning' };
    return { score: 0, band: 'critical' };
  }
  // lowerIsBetter (e.g. discount impact)
  if (value <= excellent) return { score: 100, band: 'good' };
  if (value <= good)      return { score: clampScore(lerp(value, excellent, 100, good, 50)), band: 'good' };
  if (value <= fair)      return { score: clampScore(lerp(value, good, 50, fair, 25)), band: 'fair' };
  if (value <= poor)      return { score: clampScore(lerp(value, fair, 25, poor, 0)), band: 'warning' };
  return { score: 0, band: 'critical' };
}

/** Linear interpolation between (x1,y1) and (x2,y2). */
function lerp(x, x1, y1, x2, y2) {
  if (x <= x1) return y1;
  if (x >= x2) return y2;
  return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
}

/** Return the band label for a score. */
function band(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'fair';
  if (score >= 25) return 'warning';
  return 'critical';
}

/** Compute coefficient of variation (std / mean) for an array of numbers. */
function cv(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// ---- configurable defaults ---------------------------------------------

const DEFAULTS = {
  profitability: {
    grossMargin:       { excellent: 40, good: 30, fair: 20, poor: 10 },   // %
    profitGrowth:      { excellent: 10, good:  5, fair:  0, poor: -5 },   // % MoM
    highMarginMix:     { excellent: 40, good: 25, fair: 15, poor:  5 },   // % of products
    highMarginThreshold: 30,  // margin % above which a product is "high-margin"
    discountImpact:    { excellent:  5, good: 15, fair: 25, poor: 40 },   // avg discount % (lower is better)
  },
  inventory: {
    turnover:          { excellent:  6, good:  4, fair:  2, poor:  1 },   // ratio (higher = faster)
    deadStock:         { excellent:  2, good:  5, fair:  8, poor: 10 },   // % (lower is better)
    nearExpiry:        { excellent:  2, good:  5, fair:  8, poor: 10 },   // % (lower is better)
    lowStock:          { excellent:  5, good: 10, fair: 15, poor: 20 },   // absolute count (lower is better)
    overstock:         { excellent:  5, good: 10, fair: 15, poor: 20 },   // % of products (lower is better)
  },
  customer: {
    repeatRate:        { excellent: 60, good: 40, fair: 25, poor: 10 },   // % (higher is better)
    customerGrowth:    { excellent: 10, good:  5, fair:  0, poor: -5 },   // % MoM (higher is better)
    avgSpend:          { excellent: 5000, good: 3000, fair: 1500, poor: 500 }, // NGN
    purchaseFrequency: { excellent:  3, good:  2, fair:  1, poor:  0.5 }, // tx/customer (higher is better)
  },
  operations: {
    dataCompleteness:  { excellent: 95, good: 85, fair: 70, poor: 50 },   // % (higher is better)
    recordQuality:     { excellent: 90, good: 75, fair: 50, poor: 25 },   // % excellent+good (higher is better)
    structuralPass:    { excellent: 98, good: 95, fair: 90, poor: 80 },   // % (higher is better)
    productRecognition:{ excellent: 90, good: 70, fair: 50, poor: 30 },   // % (higher is better)
  },
};

// ---- metric scoring functions ------------------------------------------

/**
 * Revenue Growth — average month-over-month revenue change.
 *
 * Thresholds (monthly MoM %):
 *   > 15 %  → 100
 *   5–15 %  →  75
 *   0–5 %   →  50
 *   -5–0 %  →  25
 *   < -5 %  →   0
 */
function scoreRevenueGrowth(metrics) {
  const months = metrics.trends?.months || [];
  if (months.length < 2) {
    return { score: 0, band: 'critical', detail: 'Insufficient monthly data — at least 2 months required.' };
  }
  const growthRates = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].revenue;
    const curr = months[i].revenue;
    if (prev > 0) growthRates.push(((curr - prev) / prev) * 100);
  }
  if (growthRates.length === 0) {
    return { score: 0, band: 'critical', detail: 'Could not compute growth rates.' };
  }
  const avgGrowth = growthRates.reduce((s, g) => s + g, 0) / growthRates.length;
  const score = clampScore(lerp(avgGrowth, -5, 0, 15, 100));
  return {
    score,
    band: band(score),
    detail:
      avgGrowth >= 0
        ? `Average monthly revenue growth of +${round(avgGrowth)}% across ${growthRates.length} periods.`
        : `Average monthly revenue decline of ${round(avgGrowth)}% across ${growthRates.length} periods.`,
  };
}

/**
 * Transaction Growth — average month-over-month transaction count change.
 *
 * Thresholds (monthly MoM %):
 *   > 10 %  → 100
 *   3–10 %  →  75
 *   0–3 %   →  50
 *   -5–0 %  →  25
 *   < -5 %  →   0
 */
function scoreTransactionGrowth(metrics) {
  const months = metrics.trends?.months || [];
  if (months.length < 2) {
    return { score: 0, band: 'critical', detail: 'Insufficient monthly data.' };
  }
  const growthRates = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].transactions;
    const curr = months[i].transactions;
    if (prev > 0) growthRates.push(((curr - prev) / prev) * 100);
  }
  if (growthRates.length === 0) {
    return { score: 0, band: 'critical', detail: 'Could not compute transaction growth rates.' };
  }
  const avgGrowth = growthRates.reduce((s, g) => s + g, 0) / growthRates.length;
  const score = clampScore(lerp(avgGrowth, -5, 0, 10, 100));
  return {
    score,
    band: band(score),
    detail:
      avgGrowth >= 0
        ? `Average monthly transaction growth of +${round(avgGrowth)}%.`
        : `Average monthly transaction decline of ${round(avgGrowth)}%.`,
  };
}

/**
 * Average Basket Value Growth — trend in revenue per transaction.
 *
 * Basket = revenue / transactions per month.
 * Thresholds (MoM % change in basket):
 *   > 8 %   → 100  (strong upselling)
 *   3–8 %   →  75
 *   -3–3 %  →  50  (stable)
 *   -8–-3 % →  25
 *   < -8 %  →   0
 */
function scoreBasketGrowth(metrics) {
  const months = metrics.trends?.months || [];
  if (months.length < 2) {
    return { score: 0, band: 'critical', detail: 'Insufficient monthly data.' };
  }
  const baskets = months.map((m) =>
    m.transactions > 0 ? m.revenue / m.transactions : 0
  );
  const growthRates = [];
  for (let i = 1; i < baskets.length; i++) {
    if (baskets[i - 1] > 0) growthRates.push(((baskets[i] - baskets[i - 1]) / baskets[i - 1]) * 100);
  }
  if (growthRates.length === 0) {
    return { score: 0, band: 'critical', detail: 'Could not compute basket growth.' };
  }
  const avgGrowth = growthRates.reduce((s, g) => s + g, 0) / growthRates.length;
  const score = clampScore(lerp(avgGrowth, -8, 0, 8, 100));
  const latestBasket = baskets[baskets.length - 1];
  return {
    score,
    band: band(score),
    detail: `Average basket size: ₦${round(latestBasket, 0).toLocaleString('en-NG')}. Basket value changed ${avgGrowth >= 0 ? '+' : ''}${round(avgGrowth)}% per month on average.`,
  };
}

/**
 * Sales Stability — how consistent monthly revenue is.
 *
 * Uses coefficient of variation (CV = std / mean).
 * Thresholds:
 *   CV < 10 %  → 100  (very stable)
 *   10–20 %    →  75
 *   20–35 %    →  50
 *   35–50 %    →  25
 *   > 50 %     →   0
 */
function scoreSalesStability(metrics) {
  const months = metrics.trends?.months || [];
  const revenues = months.map((m) => m.revenue).filter((r) => r > 0);
  if (revenues.length < 2) {
    return { score: 0, band: 'critical', detail: 'Insufficient monthly data for stability analysis.' };
  }
  const coeffVar = cv(revenues);
  if (coeffVar === null) {
    return { score: 0, band: 'critical', detail: 'Could not compute revenue variation.' };
  }
  const cvPct = coeffVar * 100;
  const score = clampScore(100 - lerp(cvPct, 10, 0, 50, 100));
  return {
    score,
    band: band(score),
    detail:
      cvPct < 15
        ? `Highly stable — monthly revenue varies only ${round(cvPct)}% from the average.`
        : cvPct < 30
          ? `Moderately stable — monthly revenue varies ${round(cvPct)}% from the average.`
          : `Unstable — monthly revenue varies ${round(cvPct)}% from the average. Consider investigating seasonal or operational causes.`,
  };
}

/**
 * Product Diversity — how concentrated revenue is among products.
 *
 * Uses the top-1 product revenue share.
 * Thresholds:
 *   top1 < 20 %  → 100  (highly diversified)
 *   20–35 %      →  75
 *   35–50 %      →  50
 *   50–70 %      →  25
 *   > 70 %       →   0
 *
 * Bonus: if fewer than 5 distinct products, cap the score at 50.
 */
function scoreProductDiversity(metrics) {
  const products = metrics.products;
  if (!products || !products.totalDistinctProducts) {
    return { score: 0, band: 'critical', detail: 'No product data available.' };
  }
  const top1Share = products.revenueConcentration?.top1 ?? 100;
  let score = clampScore(lerp(top1Share, 20, 100, 70, 0));
  const distinctCount = products.totalDistinctProducts;
  if (distinctCount < 5) {
    score = Math.min(score, 50);
  }
  return {
    score,
    band: band(score),
    detail:
      top1Share <= 20
        ? `Well diversified — the top product accounts for only ${round(top1Share)}% of revenue across ${distinctCount} products.`
        : top1Share <= 50
          ? `Moderate concentration — the top product drives ${round(top1Share)}% of revenue across ${distinctCount} products.`
          : `High concentration risk — the top product drives ${round(top1Share)}% of revenue. Consider expanding the product range.`,
  };
}

// ---- profitability scoring functions -----------------------------------

/**
 * Gross Margin — overall profit as a percentage of revenue.
 *
 * Configurable thresholds (defaults):
 *   > 40 %  → excellent (100)
 *   30–40 % → good
 *   20–30 % → fair
 *   < 20 %  → poor / critical
 */
function scoreGrossMargin(metrics, opts) {
  const t = opts?.grossMargin || DEFAULTS.profitability.grossMargin;
  const margin = metrics.overview?.grossMargin;
  if (margin == null) {
    return { score: 0, band: 'critical', detail: 'No cost data available — cannot compute gross margin.' };
  }
  const result = scoreFourTier(margin, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `Gross margin is ${round(margin)}%. ${margin >= 30 ? 'Healthy margin indicates good pricing power and cost control.' : margin >= 20 ? 'Acceptable margin — review supplier costs for improvement opportunities.' : 'Low margin — investigate pricing strategy and supplier negotiations.'}`,
  };
}

/**
 * Gross Profit Growth — average month-over-month change in gross profit.
 *
 * Configurable thresholds (defaults):
 *   > 10 %  → excellent
 *   5–10 %  → good
 *   0–5 %   → fair
 *   < 0 %   → poor
 */
function scoreProfitGrowth(metrics, opts) {
  const t = opts?.profitGrowth || DEFAULTS.profitability.profitGrowth;
  const months = metrics.trends?.months || [];
  const profits = months.map((m) => m.profit).filter((p) => p != null);
  if (profits.length < 2) {
    return { score: 0, band: 'critical', detail: 'Insufficient monthly profit data — need cost data across at least 2 months.' };
  }
  const growthRates = [];
  for (let i = 1; i < profits.length; i++) {
    const prev = profits[i - 1];
    if (prev !== 0) growthRates.push(((profits[i] - prev) / Math.abs(prev)) * 100);
  }
  if (growthRates.length === 0) {
    return { score: 0, band: 'critical', detail: 'Could not compute profit growth rates.' };
  }
  const avgGrowth = growthRates.reduce((s, g) => s + g, 0) / growthRates.length;
  const result = scoreFourTier(avgGrowth, t, { higherIsBetter: true });
  return {
    ...result,
    detail:
      avgGrowth >= 0
        ? `Average monthly profit growth of +${round(avgGrowth)}% across ${growthRates.length} periods.`
        : `Average monthly profit decline of ${round(avgGrowth)}% across ${growthRates.length} periods.`,
  };
}

/**
 * High-Margin Product Mix — percentage of products with margin above the
 * configured threshold (default 30%).
 *
 * Configurable thresholds for the *mix percentage*:
 *   > 40 % of products  → excellent
 *   25–40 %             → good
 *   15–25 %             → fair
 *   < 15 %              → poor
 */
function scoreHighMarginMix(metrics, opts) {
  const t = opts?.highMarginMix || DEFAULTS.profitability.highMarginMix;
  const threshold = opts?.highMarginThreshold ?? DEFAULTS.profitability.highMarginThreshold;
  const allProducts = metrics.products?.allProducts || [];
  if (allProducts.length === 0) {
    return { score: 0, band: 'critical', detail: 'No product-level margin data available.' };
  }
  const productsWithMargin = allProducts.filter((p) => p.margin != null);
  if (productsWithMargin.length === 0) {
    return { score: 0, band: 'critical', detail: 'No products have cost data — cannot compute margins per product.' };
  }
  const highMarginCount = productsWithMargin.filter((p) => p.margin >= threshold).length;
  const highMarginPct = (highMarginCount / productsWithMargin.length) * 100;
  const result = scoreFourTier(highMarginPct, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `${highMarginCount} of ${productsWithMargin.length} products (${round(highMarginPct)}%) have margins ≥ ${threshold}%. ${highMarginPct >= 25 ? 'Strong mix of profitable products.' : 'Consider reviewing low-margin products or negotiating better supplier prices.'}`,
  };
}

/**
 * Discount Impact — average discount rate across transactions.
 *
 * Lower discount rates = better (less margin erosion).
 * Looks for discount data via:
 *   1. `options.discountStats` — pre-computed { avgDiscountRate, discountedPct }
 *   2. Falls back to checking whether averageSellingPrice significantly
 *      exceeds implied unit revenue as a rough proxy.
 *
 * Configurable thresholds (defaults, lower is better):
 *   <  5 % avg discount  → excellent
 *   5–15 %                → good
 *   15–25 %               → fair
 *   25–40 %               → poor
 *   > 40 %                → critical
 */
function scoreDiscountImpact(metrics, opts) {
  const t = opts?.discountImpact || DEFAULTS.profitability.discountImpact;

  // Best case: explicit discount stats provided
  if (opts?.discountStats && opts.discountStats.totalTransactions > 0) {
    const ds = opts.discountStats;
    const avgRate = ds.avgDiscountRate ?? 0;
    const discountedPct = ds.discountedPct ?? 0;
    const result = scoreFourTier(avgRate, t, { higherIsBetter: false });
    return {
      ...result,
      detail: `Average discount rate of ${round(avgRate)}% across ${round(discountedPct)}% of transactions. ${avgRate <= 15 ? 'Discounting appears well-controlled.' : 'Heavy discounting is eroding margins — consider tightening discount policies.'}`,
    };
  }

  // Fallback: proxy from selling price vs implied unit revenue
  const overview = metrics.overview;
  if (overview && overview.averageSellingPrice > 0 && overview.totalQuantitySold > 0) {
    const impliedUnitRev = overview.totalRevenue / overview.totalQuantitySold;
    const asp = overview.averageSellingPrice;
    if (asp > 0 && impliedUnitRev < asp) {
      const impliedDiscount = ((asp - impliedUnitRev) / asp) * 100;
      const result = scoreFourTier(impliedDiscount, t, { higherIsBetter: false });
      return {
        ...result,
        detail: `Estimated average discount of ~${round(impliedDiscount)}% based on list price (₦${round(asp, 0)}) vs actual unit revenue (₦${round(impliedUnitRev, 0)}). For more accurate tracking, include a discount column in your upload.`,
      };
    }
  }

  return {
    score: 50,
    band: 'fair',
    detail: 'Insufficient data to measure discount impact. Upload data with a discount column for accurate tracking.',
  };
}

// ---- inventory health scoring functions --------------------------------

/**
 * Inventory Turnover — how many times inventory is sold and replaced.
 *
 * Higher turnover = capital isn't tied up in stock.
 * Accepts `opts.inventoryStats.turnoverRatio` (pre-computed median turnover).
 * Falls back to checking metrics for any turnover data.
 *
 * Configurable thresholds (defaults):
 *   > 6   → excellent (turns every 2 months)
 *   4–6   → good
 *   2–4   → fair
 *   1–2   → poor
 *   < 1   → critical
 */
function scoreInventoryTurnover(metrics, opts) {
  const t = opts?.turnover || DEFAULTS.inventory.turnover;
  const inv = opts?.inventoryStats;

  if (inv && inv.turnoverRatio != null) {
    const ratio = inv.turnoverRatio;
    const result = scoreFourTier(ratio, t, { higherIsBetter: true });
    return {
      ...result,
      detail: `Median inventory turnover ratio of ${round(ratio, 2)}× per period. ${ratio >= 4 ? 'Inventory is moving efficiently.' : ratio >= 2 ? 'Inventory movement is acceptable but could be faster.' : 'Slow turnover — capital is tied up in stock. Consider demand forecasting and promotional strategies.'}`,
    };
  }

  // Fallback: use products data for a rough velocity proxy
  const products = metrics.products?.allProducts || [];
  if (products.length === 0) {
    return { score: 0, band: 'critical', detail: 'No inventory or product movement data available.' };
  }
  return {
    score: 50,
    band: 'fair',
    detail: 'Inventory turnover data not provided. Upload inventory data or provide inventoryStats for accurate measurement.',
  };
}

/**
 * Dead Stock — percentage of products with zero movement.
 *
 * Dead stock ties up capital and may need to be written off.
 * Accepts `opts.inventoryStats.deadStockPct`.
 *
 * Configurable thresholds (defaults, lower is better):
 *   < 2 %   → excellent
 *   2–5 %   → good
 *   5–8 %   → fair
 *   8–10 %  → poor
 *   > 10 %  → critical
 */
function scoreDeadStock(metrics, opts) {
  const t = opts?.deadStock || DEFAULTS.inventory.deadStock;
  const inv = opts?.inventoryStats;

  if (inv && inv.deadStockPct != null) {
    const pct = inv.deadStockPct;
    const result = scoreFourTier(pct, t, { higherIsBetter: false });
    return {
      ...result,
      detail: `${round(pct)}% of products (${inv.deadStockCount || '?'} of ${inv.totalProducts || '?'}) show zero movement. ${pct <= 5 ? 'Dead stock is well-controlled.' : pct <= 10 ? 'Some dead stock — review slow movers for possible clearance.' : 'High dead stock — capital is stagnating. Run clearance promotions and review purchasing decisions.'}`,
    };
  }

  // Fallback: check products with zero revenue
  const products = metrics.products?.allProducts || [];
  if (products.length === 0) {
    return { score: 0, band: 'critical', detail: 'No product movement data available.' };
  }
  const zeroRevenue = products.filter((p) => !p.revenue || p.revenue === 0).length;
  if (zeroRevenue === 0 && products.length > 0) {
    return {
      score: 100,
      band: 'good',
      detail: `All ${products.length} products show sales activity — no dead stock detected in sales data.`,
    };
  }
  const pct = (zeroRevenue / products.length) * 100;
  const result = scoreFourTier(pct, t, { higherIsBetter: false });
  return {
    ...result,
    detail: `${zeroRevenue} of ${products.length} products (${round(pct)}%) have zero recorded revenue — potential dead stock.`,
  };
}

/**
 * Near Expiry Stock — percentage of products approaching expiration or
 * already discontinued.
 *
 * Expired stock = direct loss. Near-expiry = urgent clearance needed.
 * Accepts `opts.inventoryStats.nearExpiryPct`.
 *
 * Configurable thresholds (defaults, lower is better):
 *   < 2 %   → excellent
 *   2–5 %   → good
 *   5–8 %   → fair
 *   8–10 %  → poor
 *   > 10 %  → critical
 */
function scoreNearExpiry(metrics, opts) {
  const t = opts?.nearExpiry || DEFAULTS.inventory.nearExpiry;
  const inv = opts?.inventoryStats;

  if (inv && inv.nearExpiryPct != null) {
    const pct = inv.nearExpiryPct;
    const result = scoreFourTier(pct, t, { higherIsBetter: false });
    return {
      ...result,
      detail: `${round(pct)}% of products (${inv.nearExpiryCount || '?'} of ${inv.totalProducts || '?'}) are near expiry or discontinued. ${pct <= 5 ? 'Expiry risk is well-managed.' : pct <= 10 ? 'Moderate expiry risk — prioritize selling near-expiry stock.' : 'High expiry risk — urgent action needed to clear near-expiry products before write-off.'}`,
    };
  }

  // Fallback: check products data for discontinuation flags (if available)
  return {
    score: 50,
    band: 'fair',
    detail: 'Near-expiry data not available. Upload inventory data with expiry dates or provide inventoryStats for accurate measurement.',
  };
}

/**
 * Low Stock Risk — number of products below reorder threshold.
 *
 * Stockouts lose sales and frustrate customers.
 * Accepts `opts.inventoryStats.lowStockCount`.
 *
 * Configurable thresholds (defaults, lower is better):
 *   < 5    → excellent
 *   5–10   → good
 *   10–15  → fair
 *   15–20  → poor
 *   > 20   → critical
 */
function scoreLowStock(metrics, opts) {
  const t = opts?.lowStock || DEFAULTS.inventory.lowStock;
  const inv = opts?.inventoryStats;

  if (inv && inv.lowStockCount != null) {
    const count = inv.lowStockCount;
    const result = scoreFourTier(count, t, { higherIsBetter: false });
    return {
      ...result,
      detail: `${count} product${count !== 1 ? 's' : ''} below reorder threshold${inv.totalProducts ? ' (out of ' + inv.totalProducts + ')' : ''}. ${count <= 10 ? 'Low stock risk is under control.' : count <= 20 ? 'Several products need restocking — review purchase orders.' : 'Many products at risk of stockout — prioritize restocking to avoid lost sales.'}`,
    };
  }

  // Fallback: fast-moving products are at higher risk of stocking out
  const products = metrics.products?.allProducts || [];
  if (products.length === 0) {
    return { score: 0, band: 'critical', detail: 'No product data available.' };
  }
  // Flag products with high revenue but low distinct transaction count as potential stockout risk
  return {
    score: 50,
    band: 'fair',
    detail: 'Stock-level data not available. Upload inventory data with stock quantities or provide inventoryStats for accurate low-stock tracking.',
  };
}

/**
 * Overstock Risk — percentage of products with excessive inventory relative
 * to their sales velocity.
 *
 * Overstocking ties up working capital and increases expiry risk.
 * Accepts `opts.inventoryStats.overstockPct`.
 *
 * Configurable thresholds (defaults, lower is better):
 *   < 5 %   → excellent
 *   5–10 %  → good
 *   10–15 % → fair
 *   15–20 % → poor
 *   > 20 %  → critical
 */
function scoreOverstock(metrics, opts) {
  const t = opts?.overstock || DEFAULTS.inventory.overstock;
  const inv = opts?.inventoryStats;

  if (inv && inv.overstockPct != null) {
    const pct = inv.overstockPct;
    const result = scoreFourTier(pct, t, { higherIsBetter: false });
    return {
      ...result,
      detail: `${round(pct)}% of products (${inv.overstockCount || '?'} of ${inv.totalProducts || '?'}) are overstocked relative to demand. ${pct <= 10 ? 'Overstock levels are reasonable.' : pct <= 20 ? 'Some overstock — review purchasing quantities for affected products.' : 'Significant overstock — capital is tied up unnecessarily. Reduce order quantities and run promotions.'}`,
    };
  }

  // Fallback: slow movers with revenue could indicate overstock
  return {
    score: 50,
    band: 'fair',
    detail: 'Stock-level data not available. Upload inventory data with stock quantities or provide inventoryStats for accurate overstock tracking.',
  };
}

// ---- customer health scoring functions ---------------------------------

/**
 * Repeat Customer Rate — percentage of customers who have made more than
 * one purchase.
 *
 * Requires customer-level data. Only scored when customer data exists.
 * Accepts `opts.customerStats.repeatCustomerRate`.
 *
 * Configurable thresholds (defaults):
 *   > 60 %  → excellent (strong loyalty)
 *   40–60 % → good
 *   25–40 % → fair
 *   10–25 % → poor
 *   < 10 %  → critical
 */
function scoreRepeatCustomerRate(metrics, opts) {
  const t = opts?.repeatRate || DEFAULTS.customer.repeatRate;
  const cs = opts?.customerStats;

  if (!cs || !cs.hasCustomerData) {
    return { score: 0, band: 'critical', detail: 'Customer data not available.' };
  }
  if (cs.repeatCustomerRate == null) {
    return { score: 0, band: 'critical', detail: 'Repeat customer rate data not provided.' };
  }
  const rate = cs.repeatCustomerRate;
  const result = scoreFourTier(rate, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `${round(rate)}% of customers (${cs.returningCustomers || '?'} of ${cs.totalCustomers || '?'}) are repeat buyers. ${rate >= 40 ? 'Strong customer loyalty — focus on retention programs.' : rate >= 25 ? 'Moderate loyalty — consider a loyalty card or follow-up program.' : 'Low repeat rate — investigate customer satisfaction and consider retention strategies.'}`,
  };
}

/**
 * Customer Growth — average month-over-month growth in distinct customer count.
 *
 * Accepts `opts.customerStats.customerGrowthRate`.
 *
 * Configurable thresholds (defaults):
 *   > 10 %  → excellent
 *   5–10 %  → good
 *   0–5 %   → fair
 *   < 0 %   → poor
 */
function scoreCustomerGrowth(metrics, opts) {
  const t = opts?.customerGrowth || DEFAULTS.customer.customerGrowth;
  const cs = opts?.customerStats;

  if (!cs || !cs.hasCustomerData) {
    return { score: 0, band: 'critical', detail: 'Customer data not available.' };
  }
  if (cs.customerGrowthRate == null) {
    return { score: 0, band: 'critical', detail: 'Customer growth data not provided.' };
  }
  const growth = cs.customerGrowthRate;
  const result = scoreFourTier(growth, t, { higherIsBetter: true });
  return {
    ...result,
    detail:
      growth >= 0
        ? `Customer base growing at +${round(growth)}% per month (${cs.totalCustomers || '?'} distinct customers).`
        : `Customer base shrinking at ${round(growth)}% per month. Investigate competitive pressure or service issues.`,
  };
}

/**
 * Average Customer Spend — mean revenue per distinct customer.
 *
 * Accepts `opts.customerStats.avgCustomerSpend` (in NGN).
 *
 * Configurable thresholds (defaults):
 *   > ₦5,000  → excellent
 *   ₦3–5,000  → good
 *   ₦1.5–3K   → fair
 *   ₦500–1.5K → poor
 *   < ₦500    → critical
 */
function scoreAverageSpend(metrics, opts) {
  const t = opts?.avgSpend || DEFAULTS.customer.avgSpend;
  const cs = opts?.customerStats;

  if (!cs || !cs.hasCustomerData) {
    return { score: 0, band: 'critical', detail: 'Customer data not available.' };
  }
  if (cs.avgCustomerSpend == null) {
    return { score: 0, band: 'critical', detail: 'Average spend data not provided.' };
  }
  const spend = cs.avgCustomerSpend;
  const result = scoreFourTier(spend, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `Average customer spend of ₦${round(spend, 0).toLocaleString('en-NG')}. ${spend >= 3000 ? 'Healthy spend per customer.' : spend >= 1500 ? 'Moderate spend — upselling and bundling may increase basket size.' : 'Low spend per customer — consider product bundling or minimum purchase incentives.'}`,
  };
}

/**
 * Purchase Frequency — average number of transactions per customer.
 *
 * Accepts `opts.customerStats.avgPurchaseFrequency`.
 *
 * Configurable thresholds (defaults):
 *   > 3 tx/customer  → excellent
 *   2–3               → good
 *   1–2               → fair
 *   0.5–1             → poor
 *   < 0.5             → critical
 */
function scorePurchaseFrequency(metrics, opts) {
  const t = opts?.purchaseFrequency || DEFAULTS.customer.purchaseFrequency;
  const cs = opts?.customerStats;

  if (!cs || !cs.hasCustomerData) {
    return { score: 0, band: 'critical', detail: 'Customer data not available.' };
  }
  if (cs.avgPurchaseFrequency == null) {
    return { score: 0, band: 'critical', detail: 'Purchase frequency data not provided.' };
  }
  const freq = cs.avgPurchaseFrequency;
  const result = scoreFourTier(freq, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `Customers average ${round(freq, 1)} transactions each. ${freq >= 2 ? 'Good engagement — customers return regularly.' : freq >= 1 ? 'Most customers purchase once — focus on re-engagement campaigns.' : 'Very low frequency — customers rarely return. Investigate product availability and service quality.'}`,
  };
}

// ---- operational excellence scoring functions ---------------------------

/**
 * Data Completeness — average fill rate across the four required fields
 * (product name, quantity, revenue, date).
 *
 * Uses `metrics.health.dataCompleteness` directly — no external data needed.
 *
 * Configurable thresholds (defaults):
 *   > 95 %  → excellent
 *   85–95 % → good
 *   70–85 % → fair
 *   50–70 % → poor
 *   < 50 %  → critical
 */
function scoreDataCompleteness(metrics, opts) {
  const t = opts?.dataCompleteness || DEFAULTS.operations.dataCompleteness;
  const health = metrics.health;
  if (!health || !health.dataCompleteness) {
    return { score: 0, band: 'critical', detail: 'No data health metrics available.' };
  }
  const dc = health.dataCompleteness;
  // Average across the four core required fields
  const avg = (dc.productName + dc.quantity + dc.revenue + dc.date) / 4;
  const result = scoreFourTier(avg, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `Average field completeness of ${round(avg)}% across core fields (product: ${dc.productName}%, quantity: ${dc.quantity}%, revenue: ${dc.revenue}%, date: ${dc.date}%). ${avg >= 85 ? 'Data capture is strong.' : avg >= 70 ? 'Some fields are frequently missing — consider enforcing data entry standards.' : 'Many required fields are empty — data quality is hindering reliable analysis.'}`,
  };
}

/**
 * Record Quality Score — percentage of records rated excellent or good
 * in the validation quality distribution.
 *
 * Uses `metrics.health.qualityDistribution`.
 *
 * Configurable thresholds (defaults):
 *   > 90 % excellent/good  → excellent
 *   75–90 %                → good
 *   50–75 %                → fair
 *   25–50 %                → poor
 *   < 25 %                 → critical
 */
function scoreRecordQuality(metrics, opts) {
  const t = opts?.recordQuality || DEFAULTS.operations.recordQuality;
  const health = metrics.health;
  if (!health || !health.qualityDistribution) {
    return { score: 0, band: 'critical', detail: 'No quality distribution data available.' };
  }
  const qd = health.qualityDistribution;
  const total = (qd.excellent || 0) + (qd.good || 0) + (qd.fair || 0) + (qd.poor || 0);
  if (total === 0) {
    return { score: 0, band: 'critical', detail: 'No records in quality distribution.' };
  }
  const goodOrBetter = (qd.excellent || 0) + (qd.good || 0);
  const pct = (goodOrBetter / total) * 100;
  const result = scoreFourTier(pct, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `${round(pct)}% of records (${goodOrBetter} of ${total}) are rated good or excellent. ${pct >= 75 ? 'Record quality is high — data can be trusted for decisions.' : pct >= 50 ? 'Moderate quality — review common validation failures for improvement.' : 'Low record quality — significant data entry issues detected. Staff training or system controls may be needed.'}`,
  };
}

/**
 * Structural Pass Rate — percentage of uploaded rows that passed structural
 * validation (parseable date, numeric quantity, valid price, etc.).
 *
 * Uses `metrics.health.pipelineStages`.
 *
 * Configurable thresholds (defaults):
 *   > 98 %  → excellent
 *   95–98 % → good
 *   90–95 % → fair
 *   80–90 % → poor
 *   < 80 %  → critical
 */
function scoreStructuralPass(metrics, opts) {
  const t = opts?.structuralPass || DEFAULTS.operations.structuralPass;
  const health = metrics.health;
  if (!health || !health.pipelineStages) {
    return { score: 0, band: 'critical', detail: 'No pipeline stage data available.' };
  }
  const stages = health.pipelineStages;
  const uploaded = stages.uploadedRows || 0;
  const structurallyValid = stages.structurallyValidRows || 0;
  if (uploaded === 0) {
    return { score: 0, band: 'critical', detail: 'No rows uploaded.' };
  }
  const passRate = (structurallyValid / uploaded) * 100;
  const result = scoreFourTier(passRate, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `${round(passRate)}% of rows passed structural validation (${structurallyValid} of ${uploaded}). ${passRate >= 95 ? 'Data format is clean — fields are consistently parseable.' : passRate >= 90 ? 'Some rows have format issues — consider standardizing data export.' : 'Significant structural issues — review data export format and field types.'}`,
  };
}

/**
 * Product Recognition Rate — percentage of product names successfully
 * matched to known drugs by the normalizer.
 *
 * Uses `metrics.health.productRecognition`.
 *
 * Configurable thresholds (defaults):
 *   > 90 %  → excellent
 *   70–90 % → good
 *   50–70 % → fair
 *   30–50 % → poor
 *   < 30 %  → critical
 */
function scoreProductRecognition(metrics, opts) {
  const t = opts?.productRecognition || DEFAULTS.operations.productRecognition;
  const health = metrics.health;
  if (!health || !health.productRecognition) {
    return { score: 0, band: 'critical', detail: 'No product recognition data available.' };
  }
  const pr = health.productRecognition;
  const rate = pr.recognitionRate;
  if (rate == null) {
    return { score: 0, band: 'critical', detail: 'Product recognition rate not available.' };
  }
  const result = scoreFourTier(rate, t, { higherIsBetter: true });
  return {
    ...result,
    detail: `${round(rate)}% of product names recognized (${pr.recognizedCount || 0} recognized, ${pr.unknownCount || 0} unknown). ${rate >= 70 ? 'Product data is well-standardized — analysis is reliable.' : rate >= 50 ? 'Many products are unrecognized — expand the drug dictionary or standardize product naming.' : 'Most products are unrecognized — product-level analysis will be incomplete. Review product naming conventions.'}`,
  };
}

// ---- pillar definition -------------------------------------------------

const PILLARS = [
  {
    name: 'Sales Performance',
    description:
      'Measures revenue generation, transaction volume, and growth trajectory. Strong sales performance indicates market demand and effective pricing.',
    weight: 25, // %
    metrics: [
      { name: 'Revenue Growth', description: 'Average month-over-month revenue change.', weight: 30, scoreFn: scoreRevenueGrowth },
      { name: 'Transaction Growth', description: 'Average month-over-month change in transaction count.', weight: 25, scoreFn: scoreTransactionGrowth },
      { name: 'Average Basket Value Growth', description: 'Trend in revenue per transaction (upselling indicator).', weight: 20, scoreFn: scoreBasketGrowth },
      { name: 'Sales Stability', description: 'Consistency of monthly revenue (lower variation = healthier).', weight: 15, scoreFn: scoreSalesStability },
      { name: 'Product Diversity', description: 'How evenly revenue is spread across products.', weight: 10, scoreFn: scoreProductDiversity },
    ],
  },
  {
    name: 'Profitability',
    description:
      'Evaluates margin health, cost control, and bottom-line efficiency. Even high-revenue pharmacies can be unprofitable if margins are thin.',
    weight: 25,
    metrics: [
      { name: 'Gross Margin', description: 'Gross profit as a percentage of total revenue.', weight: 40, scoreFn: scoreGrossMargin },
      { name: 'Gross Profit Growth', description: 'Average month-over-month change in gross profit.', weight: 25, scoreFn: scoreProfitGrowth },
      { name: 'High-Margin Product Mix', description: 'Percentage of products with healthy margins (>30% by default).', weight: 20, scoreFn: scoreHighMarginMix },
      { name: 'Discount Impact', description: 'Average discount rate — lower is better (less margin erosion).', weight: 15, scoreFn: scoreDiscountImpact },
    ],
  },
  {
    name: 'Inventory Health',
    description:
      'Assesses stock turnover, expiry risk, and product availability. Poor inventory management ties up capital and leads to waste.',
    weight: 25,
    metrics: [
      { name: 'Inventory Turnover', description: 'How many times inventory is sold and replaced per period.', weight: 25, scoreFn: scoreInventoryTurnover },
      { name: 'Dead Stock', description: 'Percentage of products with zero movement — capital sitting idle.', weight: 20, scoreFn: scoreDeadStock },
      { name: 'Near Expiry Stock', description: 'Percentage of products approaching expiration or discontinued.', weight: 20, scoreFn: scoreNearExpiry },
      { name: 'Low Stock Risk', description: 'Number of products below reorder threshold — risk of stockout.', weight: 20, scoreFn: scoreLowStock },
      { name: 'Overstock Risk', description: 'Percentage of products with excessive inventory vs demand.', weight: 15, scoreFn: scoreOverstock },
    ],
  },
  {
    name: 'Customer Health',
    description:
      'Tracks customer retention, payment behaviour, and service reach. Loyal customers and diverse payment channels signal a resilient business.',
    weight: 15,
    metrics: [
      { name: 'Repeat Customer Rate', description: 'Percentage of customers who return for multiple purchases.', weight: 35, scoreFn: scoreRepeatCustomerRate },
      { name: 'Customer Growth', description: 'Month-over-month growth in distinct customer count.', weight: 25, scoreFn: scoreCustomerGrowth },
      { name: 'Average Spend', description: 'Mean revenue per distinct customer.', weight: 20, scoreFn: scoreAverageSpend },
      { name: 'Purchase Frequency', description: 'Average number of transactions per customer.', weight: 20, scoreFn: scorePurchaseFrequency },
    ],
  },
  {
    name: 'Operational Excellence',
    description:
      'Gauges data quality, record-keeping practices, and process maturity. Clean, complete data enables reliable decision-making.',
    weight: 10,
    metrics: [
      { name: 'Data Completeness', description: 'Average fill rate across required fields (product, quantity, revenue, date).', weight: 30, scoreFn: scoreDataCompleteness },
      { name: 'Record Quality Score', description: 'Percentage of records rated excellent or good by validation.', weight: 25, scoreFn: scoreRecordQuality },
      { name: 'Structural Pass Rate', description: 'Percentage of rows that passed structural (type/format) validation.', weight: 25, scoreFn: scoreStructuralPass },
      { name: 'Product Recognition', description: 'Percentage of product names matched to known drugs.', weight: 20, scoreFn: scoreProductRecognition },
    ],
  },
];

// ---- public API --------------------------------------------------------

function getPillars() {
  return PILLARS;
}

function validateWeights() {
  const total = PILLARS.reduce((sum, p) => sum + p.weight, 0);
  return { valid: total === 100, total };
}

/**
 * The result shape for a pillar whose underlying data does not exist.
 *
 * `assessed: false` is the important field — scoreBusinessHealth zeroes the
 * pillar's weight and spreads it across the pillars that CAN be measured, so
 * a missing capability neither scores 0 nor counts toward the total. The
 * score/band remain 0/'critical' purely for shape compatibility with callers
 * that read them; nothing consumes them once `assessed` is false, and the
 * dashboard card already branches on `assessed` to render a reason instead of
 * a number.
 *
 * @param {number} index    position in PILLARS
 * @param {string} summary  shown on the pillar card
 * @param {string} detail   what to upload to enable it
 * @param {string} reason   one-line "Missing: …" for the concerns list
 */
function unassessedPillar(index, summary, detail, reason) {
  const self = PILLARS[index];
  return {
    pillar: self.name,
    assessed: false,
    overallScore: 0,
    band: 'critical',
    weight: self.weight,
    metrics: [{
      name: self.name,
      description: summary,
      score: 0,
      band: 'critical',
      detail,
      reason,
      weight: 100,
      contribution: 0,
    }],
    strengths: [],
    concerns: [reason],
    reasons: [reason],
    notAssessedReason: detail,
  };
}

/**
 * Score the Sales Performance pillar.
 *
 * @param {object} metrics — the full output of computeAllMetrics()
 * @param {object} [opts]  — optional overrides (reserved for future configurability)
 */
function scoreSalesPerformance(metrics, opts = {}) {
  return _scorePillar(0, metrics, opts);
}

/**
 * Score the Profitability pillar.
 *
 * Requires cost data to be meaningful: Gross Margin (40%), Gross Profit
 * Growth (25%), and High-Margin Mix (20%) all depend on cost_price. Without
 * it every metric returns 0/'critical' — "No cost data", "Insufficient
 * profit data" — and the pillar's full 25% lands on the score as though the
 * pharmacy were failing, when it had simply not uploaded cost prices.
 *
 * Discount Impact (15%) can score without costs, but three-quarters of the
 * pillar cannot, so both halves are skipped or both scored together. The
 * overall message is clearer that way — either "all profitability metrics"
 * or none.
 *
 * @param {object} metrics — the full output of computeAllMetrics()
 * @param {object} [opts]  — optional threshold overrides and extra data
 * @param {object} [opts.grossMargin]          — thresholds for gross margin %
 * @param {object} [opts.profitGrowth]         — thresholds for profit growth %
 * @param {object} [opts.highMarginMix]        — thresholds for high-margin product mix %
 * @param {number} [opts.highMarginThreshold]  — margin % defining "high-margin" (default 30)
 * @param {object} [opts.discountImpact]       — thresholds for discount impact %
 * @param {object} [opts.discountStats]        — pre-computed { avgDiscountRate, discountedPct, totalTransactions }
 */
function scoreProfitability(metrics, opts = {}) {
  // The same gate as scoreInventoryHealth: an explicit signal that real cost
  // data was never uploaded. Without this check, every metric below returns
  // 0/'critical', and the pillar's full 25% drags the score despite the
  // pharmacy having uploaded exactly what it needed to.
  if (metrics?.overview?.hasCostData === false) {
    return unassessedPillar(
      1,
      'Could not be assessed — no cost prices or purchase prices were found in your uploads. '
      + 'The 25% weight has been redistributed across the pillars that can be measured.',
      'No cost data available. Upload a cost sheet (unit cost / purchase price per product) '
      + 'to enable margin analysis and profitability scoring.',
      'Missing: cost or purchase prices — the uploaded files carry selling prices only.',
    );
  }
  return _scorePillar(1, metrics, opts);
}

/**
 * Score the Inventory Health pillar.
 *
 * @param {object} metrics  — the full output of computeAllMetrics()
 * @param {object} [opts]   — optional threshold overrides and extra data
 * @param {object} [opts.inventoryStats] — pre-computed inventory metrics:
 *   { turnoverRatio, deadStockCount, deadStockPct, nearExpiryCount, nearExpiryPct,
 *     lowStockCount, overstockCount, overstockPct, totalProducts }
 */
function scoreInventoryHealth(metrics, opts = {}) {
  // Inventory can only be judged against real stock/expiry data. Without it
  // every metric in this pillar returns 0/'critical' — "no inventory data
  // available", "stock-level data not available" — and the pillar's full 25%
  // landed on the overall score as if the pharmacy were failing at inventory
  // management, when it had simply uploaded a sales report. A pharmacy cannot
  // be marked down for a file it never claimed to have.
  //
  // Absence is only concluded from an explicit signal. If no inventoryStats
  // were supplied at all, the caller may be a context that never computes
  // them, and silently dropping a quarter of the score there would be a
  // second, quieter bug — so that case still scores as before.
  const stats = opts?.inventoryStats;
  if (stats && stats.hasInventoryData === false) {
    return unassessedPillar(
      2,
      'Could not be assessed — no stock levels or expiry dates were found in your uploads. '
      + 'The 25% weight has been redistributed across the pillars that can be measured.',
      'No inventory data available. Upload a stock report (quantity on hand, reorder level) '
      + 'or a batch/expiry report to enable inventory scoring.',
      'Missing: stock quantities and expiry dates — the uploaded files carry sales only.',
    );
  }
  return _scorePillar(2, metrics, opts);
}

/**
 * Score the Customer Health pillar.
 *
 * Only scored when customer data exists (beyond default walk-in customers).
 * When no customer data is available, returns { assessed: false } with
 * redistribution weights so the caller can reallocate the 15% weight
 * proportionally across the remaining four pillars.
 *
 * @param {object} metrics  — the full output of computeAllMetrics()
 * @param {object} [opts]   — optional threshold overrides and extra data
 * @param {object} [opts.customerStats] — pre-computed customer metrics:
 *   { repeatCustomerRate, customerGrowthRate, avgCustomerSpend,
 *     avgPurchaseFrequency, totalCustomers, newCustomers, returningCustomers,
 *     hasCustomerData }
 * @returns {{
 *   pillar: string,
 *   assessed: boolean,
 *   overallScore: number,
 *   band: string,
 *   weight: number,
 *   metrics: Array,
 *   redistribution?: Array<{ pillar: string, addedWeight: number }>
 * }}
 */
function scoreCustomerHealth(metrics, opts = {}) {
  const cs = opts?.customerStats;
  const hasData = cs && cs.hasCustomerData;

  if (!hasData) {
    // Build redistribution: spread 15% proportionally across Sales(25), Profit(25), Inventory(25), Ops(10)
    // Proportions: 25/85, 25/85, 25/85, 10/85
    const otherPillars = PILLARS.filter((_, i) => i !== 3);
    const otherTotal = otherPillars.reduce((s, p) => s + p.weight, 0);
    const redistribution = otherPillars.map((p) => ({
      pillar: p.name,
      addedWeight: round((p.weight / otherTotal) * PILLARS[3].weight, 1),
    }));

    return {
      pillar: PILLARS[3].name,
      assessed: false,
      overallScore: 0,
      band: 'critical',
      weight: PILLARS[3].weight,
      metrics: [
        {
          name: 'Customer Health',
          description: 'Could not be assessed — customer-identifying data (names, phone numbers, or patient IDs) was not found in the uploaded records. The 15% weight will be redistributed.',
          score: 0,
          band: 'critical',
          detail: 'No customer data available. To enable customer health tracking, include a customer name, phone number, or patient ID column in your upload.',
          reason: 'Missing: Customer-identifying data (names, phone numbers, or patient IDs) was not found.',
          weight: 100,
          contribution: 0,
        },
      ],
      strengths: [],
      concerns: ['Missing: Customer-identifying data (names, phone numbers, or patient IDs) was not found.'],
      reasons: ['Missing: Customer-identifying data (names, phone numbers, or patient IDs) was not found.'],
      redistribution,
      notAssessedReason:
        'Customer-identifying data (names, phone numbers, or patient IDs) was not found in the uploaded records.',
    };
  }

  return _scorePillar(3, metrics, opts);
}

/** Build a short, data-driven reason from a metric result. */
function _metricReason(metricName, score, metricBand, detail) {
  const prefix = metricBand === 'good'
    ? 'Strong'
    : metricBand === 'fair'
      ? 'Adequate'
      : metricBand === 'warning'
        ? 'Weak'
        : 'Poor';
  // Extract the first sentence (split on ". " to avoid cutting decimal numbers like 9.1%)
  const firstSentence = detail
    ? detail.split('. ')[0].trim()
    : `${metricName} scored ${score}/100`;
  // Avoid double period if the first sentence already ends with one
  const clean = firstSentence.endsWith('.') ? firstSentence.slice(0, -1) : firstSentence;
  return `${prefix}: ${clean}.`;
}

function _scorePillar(pillarIndex, metrics, opts) {
  const pillar = PILLARS[pillarIndex];
  const results = pillar.metrics.map((m) => {
    const result = m.scoreFn(metrics, opts);
    const reason = _metricReason(m.name, result.score, result.band, result.detail);
    return {
      name: m.name,
      description: m.description,
      score: result.score,
      band: result.band,
      detail: result.detail,
      reason,
      weight: m.weight,
      contribution: round((result.score * m.weight) / 100, 1),
    };
  });

  const overallScore = round(results.reduce((s, r) => s + r.contribution, 0), 1);

  const strengths = results.filter((r) => r.band === 'good').map((r) => r.reason);
  const concerns = results.filter((r) => r.band === 'warning' || r.band === 'critical').map((r) => r.reason);
  const reasons = results.map((r) => r.reason);

  return {
    pillar: pillar.name,
    overallScore,
    band: band(overallScore),
    metrics: results,
    strengths,
    concerns,
    reasons,
  };
}

/**
 * Score the Operational Excellence pillar.
 *
 * All metrics consume `metrics.health` directly — no external stats needed.
 *
 * @param {object} metrics — the full output of computeAllMetrics()
 * @param {object} [opts]  — optional threshold overrides
 */
function scoreOperationalExcellence(metrics, opts = {}) {
  return _scorePillar(4, metrics, opts);
}

// ---- overall business health -------------------------------------------

/**
 * Rate the overall score.
 *   90–100 = Excellent
 *   75–89  = Healthy
 *   60–74  = Stable
 *   40–59  = At Risk
 *   < 40   = Critical
 */
function rating(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Healthy';
  if (score >= 60) return 'Stable';
  if (score >= 40) return 'At Risk';
  return 'Critical';
}

/**
 * Combine all five pillars into one overall Business Health Score.
 *
 * Uses configured pillar weights. When Customer Health cannot be assessed,
 * its 15% weight is redistributed proportionally across the other four pillars.
 *
 * @param {object} metrics — the full output of computeAllMetrics()
 * @param {object} [opts]  — optional overrides for any pillar (thresholds, stats)
 * @returns {{
 *   overallScore: number,
 *   rating: string,
 *   pillars: Array<{ name: string, weight: number, adjustedWeight: number, score: number, band: string, assessed: boolean, metrics: Array }>,
 *   customerRedistributed: boolean,
 *   redistribution: Array|null,
 *   computedAt: string
 * }}
 */
function scoreBusinessHealth(metrics, opts = {}) {
  const sales    = scoreSalesPerformance(metrics, opts);
  const profit   = scoreProfitability(metrics, opts);
  const inventory = scoreInventoryHealth(metrics, opts);
  const customer = scoreCustomerHealth(metrics, opts);
  const ops      = scoreOperationalExcellence(metrics, opts);

  // `assessed` used to be hardcoded true for every pillar except Customer, so
  // a pharmacy that uploaded only sales was scored on Inventory Health anyway
  // — every metric in it returned 0 for want of stock data, and the pillar's
  // full 25% dragged the overall score down. Each pillar now reports whether
  // it could be measured, and the same redistribution Customer always had
  // applies to any of them.
  const results = [sales, profit, inventory, customer, ops];
  const pillars = results.map((r, i) => ({
    name: r.pillar,
    weight: PILLARS[i].weight,
    adjustedWeight: PILLARS[i].weight,
    score: r.overallScore,
    band: r.band,
    assessed: r.assessed !== false,
    metrics: r.metrics,
    strengths: r.strengths,
    concerns: r.concerns,
    reasons: r.reasons,
    notAssessedReason: r.notAssessedReason || null,
  }));

  // Spread the weight of every unassessed pillar across the assessed ones, in
  // proportion to their own weights, so the remaining weights still total 100
  // and a 70 on the pillars that ARE measurable reads as 70 rather than being
  // diluted toward zero by pillars nobody could score.
  const unassessed = pillars.filter((p) => !p.assessed);
  const assessed = pillars.filter((p) => p.assessed);
  const freedWeight = unassessed.reduce((s, p) => s + p.weight, 0);
  const assessedBase = assessed.reduce((s, p) => s + p.weight, 0);

  const redistribution = [];
  if (freedWeight > 0 && assessedBase > 0) {
    for (const p of assessed) {
      const added = round((p.weight / assessedBase) * freedWeight, 1);
      p.adjustedWeight = round(p.weight + added, 1);
      redistribution.push({ pillar: p.name, addedWeight: added });
    }
  }
  for (const p of unassessed) p.adjustedWeight = 0;

  // Retained under its original name because the dashboard card reads it to
  // print "Customer Health unavailable."; `unassessedPillars` is the general
  // form for anything that wants the full picture.
  const customerRedistributed = customer.assessed === false;

  // Divide by the actual adjusted total rather than a hardcoded 100: rounding
  // each redistributed share to one decimal can leave the sum at 99.9 or
  // 100.1, which would quietly scale every score up or down.
  const adjustedTotal = pillars.reduce((s, p) => s + p.adjustedWeight, 0);
  const overallScore = adjustedTotal > 0
    ? round(pillars.reduce((s, p) => s + p.score * p.adjustedWeight, 0) / adjustedTotal, 1)
    : 0;

  // Aggregate across all pillars
  const allStrengths = pillars.flatMap((p) => p.strengths || []);
  const allConcerns  = pillars.flatMap((p) => p.concerns || []);
  const allReasons   = pillars.flatMap((p) => p.reasons || []);

  return {
    overallScore,
    rating: rating(overallScore),
    pillars,
    strengths: allStrengths,
    concerns: allConcerns,
    reasons: allReasons,
    customerRedistributed,
    redistribution: redistribution.length > 0 ? redistribution : null,
    // Which pillars could not be measured, and why — so the dashboard can say
    // "scored on Sales, Profitability and Operations" instead of leaving the
    // owner to wonder why a number moved.
    unassessedPillars: unassessed.map((p) => ({ name: p.name, reason: p.notAssessedReason })),
    computedAt: new Date().toISOString(),
  };
}

module.exports = { PILLARS, getPillars, validateWeights, scoreSalesPerformance, scoreProfitability, scoreInventoryHealth, scoreCustomerHealth, scoreOperationalExcellence, scoreBusinessHealth, DEFAULTS };
