/**
 * Decision Intelligence Engine — Deterministic, data-specific business insights.
 *
 * DESIGN PRINCIPLES:
 *   1. Every observation names specific products, categories, amounts, and percentages.
 *   2. Every recommendation references the same data points — no generic advice.
 *   3. Insights follow the chain: Observation → Evidence → Root Cause → Action → Outcome.
 *   4. Product names, month names, and percentages come directly from the data.
 */

const round = (n, d = 1) => { const m = 10 ** d; return Math.round(n * m) / m; };

// ── formatters ────────────────────────────────────────────────────────

function fmtNaira(n) {
  if (n == null) return 'N/A';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPct(n) {
  if (n == null) return 'N/A';
  return round(n) + '%';
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(ym) {
  if (!ym) return '';
  const parts = String(ym).split('-');
  const idx = parseInt(parts[1], 10) - 1;
  return MONTH_NAMES[idx] + ' ' + parts[0];
}

// ── trend analysis helpers ────────────────────────────────────────────

/**
 * Compute month-over-month revenue changes, attributing large swings
 * to specific products when possible.
 */
function analyzeRevenueTrends(metrics, opts) {
  const months = metrics.trends?.months || [];
  if (months.length < 2) return { swings: [], topDecline: null, topGrowth: null, topDecliners: [], topGainers: [], summary: '' };

  const swings = [];
  let biggestDecline = null, biggestGrowth = null;

  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1], curr = months[i];
    if (prev.revenue <= 0) continue;
    const chgPct = round(((curr.revenue - prev.revenue) / prev.revenue) * 100, 1);
    const swing = {
      month: curr.month, prevMonth: prev.month,
      revenue: curr.revenue, prevRevenue: prev.revenue,
      changePct: chgPct, direction: chgPct >= 0 ? 'up' : 'down',
    };
    swings.push(swing);
    if (chgPct < 0 && (!biggestDecline || chgPct < biggestDecline.changePct)) biggestDecline = swing;
    if (chgPct > 0 && (!biggestGrowth || chgPct > biggestGrowth.changePct)) biggestGrowth = swing;
  }

  // Compute product-level attribution for the biggest decline and growth months
  let topDecliners = [], topGainers = [];
  const records = opts?.records || [];

  if (records.length > 0 && biggestDecline) {
    topDecliners = getProductChanges(records, biggestDecline.month, 'decline');
  }
  if (records.length > 0 && biggestGrowth) {
    topGainers = getProductChanges(records, biggestGrowth.month, 'growth');
  }

  const declineCount = swings.filter(s => s.changePct < 0).length;
  const summary = declineCount >= months.length / 2 ? 'declining'
    : biggestDecline && biggestDecline.changePct < -15 ? 'volatile'
    : 'stable';

  return { swings, biggestDecline, biggestGrowth, topDecliners, topGainers, summary, declineCount };
}

/**
 * Given raw records, compute month-over-month product revenue changes for a specific month.
 * Returns the top 5 products that gained or declined the most.
 */
function getProductChanges(records, targetMonth, direction) {
  // Get the previous month
  const parts = String(targetMonth).split('-');
  const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevMonth = prevY + '-' + String(prevM).padStart(2, '0');

  // Get product name helper
  const productOf = (rec) => rec.product_name || rec.product || 'Unknown';
  const revenueOf = (rec) => {
    if (rec.revenue != null) return rec.revenue;
    return (rec.selling_price || rec.price || 0) * (rec.quantity || 1);
  };

  // Find records matching each month
  const isMonth = (rec, ym) => {
    if (!rec.transaction_date) return false;
    const d = String(rec.transaction_date).substring(0, 7); // YYYY-MM
    return d === ym;
  };

  // Only count records that passed quality checks (same filters as metrics engine).
  // Align with how computeOverview + computeProductMetrics filter records.
  const isExcludedFrom = (rec, metric) => {
    return rec._quality?.excludedMetrics?.includes(metric);
  };

  // Aggregate revenue by product for current and previous month
  const currMap = {}, prevMap = {};
  for (const rec of records) {
    // Skip records excluded from revenue (matches computeOverview) or
    // product breakdown (matches computeProductMetrics).
    if (isExcludedFrom(rec, 'revenue_metrics')) continue;
    if (isExcludedFrom(rec, 'product_breakdown')) continue;
    const name = productOf(rec);
    const rev = revenueOf(rec);
    if (isMonth(rec, targetMonth)) currMap[name] = (currMap[name] || 0) + rev;
    if (isMonth(rec, prevMonth)) prevMap[name] = (prevMap[name] || 0) + rev;
  }

  // Compute changes
  const changes = [];
  for (const [name, currRev] of Object.entries(currMap)) {
    const prevRev = prevMap[name] || 0;
    const changePct = prevRev > 0 ? round(((currRev - prevRev) / prevRev) * 100, 1) : (currRev > 0 ? 100 : 0);
    changes.push({ name, currRev, prevRev, changePct, revenueChange: currRev - prevRev });
  }
  // Also include products that were in prevMonth but disappeared
  for (const [name, prevRev] of Object.entries(prevMap)) {
    if (!currMap[name] && prevRev > 0) {
      changes.push({ name, currRev: 0, prevRev, changePct: -100, revenueChange: -prevRev });
    }
  }

  changes.sort((a, b) => direction === 'decline' ? a.changePct - b.changePct : b.changePct - a.changePct);
  return changes.slice(0, 3);
}

/**
 * Identify which specific products dominate revenue and create concentration risk.
 */
function analyzeConcentration(metrics) {
  const rc = metrics.products?.revenueConcentration || {};
  const allProds = metrics.products?.allProducts || [];
  const totalProducts = allProds.length;

  // Top product by revenue
  const sorted = [...allProds].sort((a, b) => b.revenue - a.revenue);
  const top1 = sorted[0] || null;
  const top3 = sorted.slice(0, 3);
  const top1Share = rc.top1 || 0;
  const top3Share = rc.top3 || 0;

  // Product with highest margin
  const byMargin = [...allProds].filter(p => p.margin != null).sort((a, b) => b.margin - a.margin);
  const highestMargin = byMargin[0] || null;

  // Product with lowest margin (but significant revenue)
  const lowMargin = [...allProds].filter(p => p.revenue > 0 && p.margin != null)
    .sort((a, b) => a.margin - b.margin);
  const lowestMargin = lowMargin[0] || null;

  // Volume leaders (by quantity)
  const byQty = [...allProds].sort((a, b) => b.quantity - a.quantity);
  const topByVolume = byQty[0] || null;

  return { top1, top3, top1Share, top3Share, totalProducts, highestMargin, lowestMargin, topByVolume };
}

/**
 * Find the biggest absolute revenue change between consecutive months
 * and compute product-level contributions.
 */
function findBiggestMonthlyShift(metrics) {
  const months = metrics.trends?.months || [];
  if (months.length < 2) return null;

  let maxShift = null;
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1], curr = months[i];
    const shift = Math.abs(curr.revenue - prev.revenue);
    if (!maxShift || shift > maxShift.shift) {
      maxShift = {
        month: curr.month,
        prevMonth: prev.month,
        currRevenue: curr.revenue,
        prevRevenue: prev.revenue,
        shift,
        changePct: round(((curr.revenue - prev.revenue) / (prev.revenue || 1)) * 100, 1),
      };
    }
  }
  return maxShift;
}

// ── confidence scoring ────────────────────────────────────────────────

function computeConfidenceBase(metrics, opts) {
  let score = 50;
  const months = metrics.trends?.monthCount || metrics.trends?.months?.length || 0;
  if (months >= 24) score += 15;
  else if (months >= 12) score += 10;
  else if (months >= 6) score += 5;

  if (metrics.overview?.hasCostData) score += 10;

  const txCount = metrics.overview?.transactionCount || 0;
  if (txCount >= 10000) score += 10;
  else if (txCount >= 1000) score += 5;

  if (opts?.inventoryStats?.totalProducts > 0) score += 5;
  if (opts?.customerStats?.hasCustomerData) score += 5;

  return Math.min(100, Math.max(0, score));
}

function buildConfidenceReason(metrics, opts) {
  const parts = [];
  const months = metrics.trends?.monthCount || metrics.trends?.months?.length || 0;
  if (months > 0) parts.push(`${months} months of sales history`);
  const tx = metrics.overview?.transactionCount || 0;
  if (tx > 0) parts.push(`${tx.toLocaleString('en-NG')} transactions`);
  if (metrics.overview?.hasCostData) parts.push('complete cost data');
  if (opts?.inventoryStats?.totalProducts > 0) parts.push('inventory records');
  return parts.length > 0 ? `Based on ${parts.join(', ')}.` : 'Insufficient data for high-confidence insights.';
}

// ── insight generation ────────────────────────────────────────────────

/**
 * Generate a list of specific, data-driven insights.
 * Each insight references actual products, months, percentages, and amounts.
 */
function generateInsights(healthResult, metrics, opts = {}) {
  const confidenceBase = computeConfidenceBase(metrics, opts);
  const confidenceReason = buildConfidenceReason(metrics, opts);
  const overview = metrics.overview || {};
  const trends = metrics.trends || {};
  const months = trends.months || [];

  // Pre-compute analyses
  const trend = analyzeRevenueTrends(metrics, opts);
  const concentration = analyzeConcentration(metrics);
  const biggestShift = findBiggestMonthlyShift(metrics);

  const insights = [];
  const push = (i) => {
    i.confidenceReason = confidenceReason;
    insights.push(i);
  };

  // ── 1. Revenue Decline (named products) ────────────────────────────

  if (trend.biggestDecline && trend.biggestDecline.changePct < -5) {
    const d = trend.biggestDecline;
    const pctAbs = Math.abs(d.changePct);

    let productDetail = '';
    if (trend.topDecliners.length > 0) {
      const names = trend.topDecliners.map(p =>
        `${p.name} (${fmtPct(Math.abs(p.changePct))})`);
      productDetail = ` This was driven by declines in ${names.join(', ')}.`;
    }

    const declineAction = trend.topDecliners.length >= 2
      ? `Review stock levels for ${trend.topDecliners[0].name} and ${trend.topDecliners[1].name}. Check if competitors lowered prices or if demand is seasonal. Consider promotional bundles to move stock.`
      : trend.topDecliners.length === 1
        ? `Review stock levels for ${trend.topDecliners[0].name}. Investigate whether a competitor price cut or seasonal demand drop caused this.`
        : `Audit your top 5 products for the previous month to identify which drove the decline. Check for stockouts, pricing changes, or competitor activity.`;

    push({
      observation: `Revenue dropped ${fmtPct(pctAbs)} in ${monthLabel(d.month)} (from ${fmtNaira(d.prevRevenue)} to ${fmtNaira(d.revenue)}).${productDetail}`,
      evidence: [
        `Month-over-month: ${fmtNaira(d.prevRevenue)} → ${fmtNaira(d.revenue)} (${fmtPct(d.changePct)} change).`,
        `Total revenue across ${months.length} months: ${fmtNaira(overview.totalRevenue)}.`,
      ],
      businessImpact: `A ${fmtPct(pctAbs)} revenue drop represents lost income that could have covered fixed costs like rent and salaries. If this trend repeats, quarterly revenue could fall by ${fmtNaira(round(d.prevRevenue - d.revenue, 0))} or more per month.`,
      recommendedAction: declineAction,
      expectedOutcome: `Revenue stabilised at or above ${fmtNaira(d.prevRevenue)} per month by addressing the specific products driving the decline.`,
      confidence: confidenceBase,
      priorityScore: round(Math.abs(d.changePct) * 0.8, 2),
      impact: Math.abs(d.changePct) > 20 ? 3 : 2,
      urgency: Math.abs(d.changePct) > 20 ? 3 : 2,
      pillar: 'Sales Performance',
      metric: 'Revenue Growth',
    });
  }

  // ── 2. Revenue Growth (named products) ─────────────────────────────

  if (trend.biggestGrowth && trend.biggestGrowth.changePct > 10) {
    const d = trend.biggestGrowth;

    let productDetail = '';
    if (trend.topGainers.length > 0) {
      const names = trend.topGainers.map(p =>
        `${p.name} (+${fmtPct(p.changePct)})`);
      productDetail = ` Growth was led by ${names.join(', ')}.`;
    }

    const action = trend.topGainers.length > 0
      ? `Double down on what's working. Increase stock of ${trend.topGainers[0].name} to avoid stockouts. Replicate the ${monthLabel(d.month)} strategy for these products in coming months.`
      : `Identify what drove the ${monthLabel(d.month)} growth — was it a promotion, new customer segment, or seasonal demand — and systematise it.`;

    push({
      observation: `Revenue grew ${fmtPct(d.changePct)} in ${monthLabel(d.month)} (from ${fmtNaira(d.prevRevenue)} to ${fmtNaira(d.revenue)}).${productDetail}`,
      evidence: [
        `Month-over-month: ${fmtNaira(d.prevRevenue)} → ${fmtNaira(d.revenue)} (+${fmtPct(d.changePct)}).`,
        trend.topGainers.length > 0 ? `Top contributors: ${trend.topGainers.slice(0, 3).map(p => p.name + ' (+' + fmtPct(Math.abs(p.changePct)) + ')').join(', ')}.` : '',
      ].filter(Boolean),
      businessImpact: `This growth trend, if sustained, could add ${fmtNaira(round(d.revenue - d.prevRevenue, 0))} in additional monthly revenue.${trend.topGainers.length > 0 ? ` ${trend.topGainers[0].name} alone added ${fmtNaira(round(trend.topGainers[0].revenueChange || 0, 0))}.` : ''}`,
      recommendedAction: action,
      expectedOutcome: `Sustained or increased growth rate for high-performing products.`,
      confidence: confidenceBase,
      priorityScore: round(d.changePct * 0.5, 2),
      impact: 2,
      urgency: 1,
      pillar: 'Sales Performance',
      metric: 'Revenue Growth',
    });
  }

  // ── 3. Revenue Concentration Risk ─────────────────────────────────

  if (concentration.top1Share >= 30) {
    const top1 = concentration.top1;
    const productName = top1 ? top1.name : 'one product';

    push({
      observation: `${productName} alone generates ${fmtPct(concentration.top1Share)} of total revenue (${fmtNaira(top1 ? top1.revenue : 0)}). ${concentration.top3Share >= 70 ? `The top 3 products account for ${fmtPct(concentration.top3Share)} of revenue.` : ''}`,
      evidence: [
        `${productName} revenue: ${fmtNaira(top1 ? top1.revenue : 'N/A')} (${fmtPct(concentration.top1Share)} of total).`,
        concentration.top3.length > 0 ? `Top 3: ${concentration.top3.map(p => p.name + ' (' + fmtPct(p.revenue / overview.totalRevenue * 100) + ')').join(', ')}.` : '',
        `Total products: ${concentration.totalProducts || 'N/A'}.`,
      ].filter(Boolean),
      businessImpact: `Over-reliance on ${productName} creates significant business risk. A single supply disruption, regulatory change, or competitor price cut on this product could cut your revenue by ${fmtPct(concentration.top1Share)}.`,
      recommendedAction: concentration.top1
        ? `Diversify by promoting complementary products. If ${productName} is an antibiotic (Augmentin), stock and promote related pain relief (Paracetamol), vitamins (Vitamin C), and first-aid items. Bundle ${productName} with higher-margin add-ons at a discount.`
        : `Diversify your product portfolio. Add adjacent categories to reduce dependence on a single product.`,
      expectedOutcome: `Reduced business risk — lowering top-product share from ${fmtPct(concentration.top1Share)} to under 30% through portfolio diversification.`,
      confidence: confidenceBase,
      priorityScore: round(concentration.top1Share * 0.6, 2),
      impact: 3,
      urgency: concentration.top1Share >= 50 ? 3 : 2,
      pillar: 'Sales Performance',
      metric: 'Product Diversity',
    });
  }

  // ── 4. Gross Margin Analysis ──────────────────────────────────────

  if (overview.grossMargin != null && overview.grossMargin < 35) {
    const highest = concentration.highestMargin;
    const lowest = concentration.lowestMargin;

    let marginDetail = '';
    if (highest) {
      marginDetail = `${highest.name} has the strongest margin at ${fmtPct(highest.margin)} but contributes only ${fmtPct(highest.revenue / overview.totalRevenue * 100)} of revenue.`;
    }
    if (lowest && lowest !== highest) {
      marginDetail += ` ${lowest.name} drags margins down at ${fmtPct(lowest.margin)} while consuming ${fmtPct(lowest.revenue / overview.totalRevenue * 100)} of revenue.`;
    }

    const action = lowest
      ? `Renegotiate supplier costs for ${lowest.name} or switch to a clinically equivalent generic with better margins. Promote ${highest ? highest.name : 'high-margin products'} more prominently — place them at eye level and near the counter.`
      : `Review your top 5 highest-cost products and get quotes from at least 2 alternative suppliers.`;

    push({
      observation: `Your overall gross margin is ${fmtPct(overview.grossMargin)} — below the 35%+ target for a healthy pharmacy.${marginDetail ? ' ' + marginDetail : ''}`,
      evidence: [
        `Gross margin: ${fmtPct(overview.grossMargin)}.`,
        `Gross profit: ${fmtNaira(overview.grossProfit)} on ${fmtNaira(overview.totalRevenue)} revenue.`,
        highest ? `Highest-margin product: ${highest.name} at ${fmtPct(highest.margin)}.` : '',
        lowest ? `Lowest-margin product: ${lowest.name} at ${fmtPct(lowest.margin)}.` : '',
      ].filter(Boolean),
      businessImpact: `At ${fmtPct(overview.grossMargin)} margin, you earn ${fmtNaira(round(overview.grossProfit || 0, 0))} on ${fmtNaira(overview.totalRevenue)} in sales. Raising margin by just 5 points would add ${fmtNaira(round(overview.totalRevenue * 0.05, 0))} in additional annual profit — without selling a single extra unit.`,
      recommendedAction: action,
      expectedOutcome: `Gross margin improved to above 35% through supplier cost reduction and product mix rebalancing.`,
      confidence: overview.hasCostData ? confidenceBase : confidenceBase - 20,
      priorityScore: round((35 - overview.grossMargin) * 1.5, 2),
      impact: 3,
      urgency: overview.grossMargin < 20 ? 3 : 2,
      pillar: 'Profitability',
      metric: 'Gross Margin',
    });
  }

  // ── 5. High-Margin Opportunity ────────────────────────────────────

  if (concentration.highestMargin && concentration.highestMargin.margin >= 35) {
    const h = concentration.highestMargin;
    const revShare = round(h.revenue / overview.totalRevenue * 100, 1);

    if (revShare < 20) {
      push({
        observation: `${h.name} delivers your best margin (${fmtPct(h.margin)}) but only accounts for ${fmtPct(revShare)} of sales (${fmtNaira(h.revenue)}). This is untapped profit potential.`,
        evidence: [
          `${h.name}: revenue ${fmtNaira(h.revenue)}, margin ${fmtPct(h.margin)}.`,
          `Revenue share: ${fmtPct(revShare)} of total ${fmtNaira(overview.totalRevenue)}.`,
        ],
        businessImpact: `If ${h.name} grew to just 30% of revenue, it could add ${fmtNaira(round(overview.totalRevenue * 0.3 - h.revenue, 0))} in additional sales at ${fmtPct(h.margin)} margin — generating ${fmtNaira(round((overview.totalRevenue * 0.3 - h.revenue) * h.margin / 100, 0))} in new profit.`,
        recommendedAction: `Make ${h.name} a priority display item. Train staff to suggest it as an add-on with every relevant purchase. Create bundle deals that include ${h.name} at a slight discount to increase volume.`,
        expectedOutcome: `Increased revenue share for ${h.name} from ${fmtPct(revShare)} to 20%+, capturing high-margin growth.`,
        confidence: confidenceBase,
        priorityScore: round((35 - (35 - h.margin)) * (20 - revShare) / 4, 2),
        impact: 2,
        urgency: 1,
        pillar: 'Profitability',
        metric: 'High-Margin Product Mix',
      });
    }
  }

  // ── 6. Monthly Revenue Volatility ──────────────────────────────────

  if (trend.swings.length >= 3) {
    const declines = trend.swings.filter(s => s.changePct < -5);
    if (declines.length >= trend.swings.length * 0.4) {
      push({
        observation: `Revenue is volatile — ${declines.length} of the last ${trend.swings.length} months showed declines over 5%. The steepest was ${monthLabel(trend.biggestDecline.month)} (${fmtPct(trend.biggestDecline.changePct)}).`,
        evidence: [
          `Decline months: ${declines.map(d => monthLabel(d.month) + ' (' + fmtPct(d.changePct) + ')').join(', ')}.`,
          `${months.length} months of data available.`,
        ],
        businessImpact: `Unpredictable monthly revenue makes it impossible to plan inventory orders, staffing, or business investments with confidence.`,
        recommendedAction: biggestShift
          ? `Analyse what happened between ${monthLabel(biggestShift.prevMonth)} and ${monthLabel(biggestShift.month)} — ${fmtPct(Math.abs(biggestShift.changePct))} revenue ${biggestShift.changePct > 0 ? 'jump' : 'drop'} in a single month suggests either stockouts or a lost customer segment. Build a minimum baseline from recurring customers to stabilise cash flow.`
          : `Identify your most consistent-selling products and use them as a baseline. Build recurring revenue through chronic medication refill programmes.`,
        expectedOutcome: `More predictable monthly revenue with fewer than 2 months per year showing significant (>10%) declines.`,
        confidence: confidenceBase,
        priorityScore: round(declines.length * 5, 2),
        impact: 2,
        urgency: 2,
        pillar: 'Sales Performance',
        metric: 'Sales Stability',
      });
    }
  }

  // ── 7. Low Transaction Volume ─────────────────────────────────────

  const txCount = overview.transactionCount || 0;
  const monthsCount = months.length || 1;
  const avgTxMonth = round(txCount / monthsCount, 0);
  if (avgTxMonth < 100 && txCount > 0) {
    push({
      observation: `You average ${avgTxMonth} transactions per month — that's about ${round(avgTxMonth / 30, 1)} customers per day. Footfall is your biggest growth lever.`,
      evidence: [
        `Total transactions: ${txCount.toLocaleString('en-NG')} over ${monthsCount} months.`,
        `Average: ${avgTxMonth} per month (${round(avgTxMonth / 30, 1)} per day).`,
        `Average transaction value: ${fmtNaira(overview.averageTransactionValue)}.`,
      ],
      businessImpact: `At ${round(avgTxMonth / 30, 1)} daily customers, even a 20% increase in footfall (about ${round(avgTxMonth * 0.2, 0)} more customers a month) would add ${fmtNaira(round(overview.totalRevenue * 0.2, 0))} in revenue.`,
      recommendedAction: `Run a community health screening day offering free blood pressure and blood sugar checks. Place a sandwich board outside with daily health tips. Launch a WhatsApp broadcast list for health reminders — each message can bring customers in.`,
      expectedOutcome: `20% increase in daily transactions through community visibility and engagement.`,
      confidence: txCount > 200 ? confidenceBase : confidenceBase - 10,
      priorityScore: round(100 - avgTxMonth / 30 * 2, 2),
      impact: 2,
      urgency: avgTxMonth < 30 ? 3 : 2,
      pillar: 'Customer Health',
      metric: 'Transaction Growth',
    });
  }

  // ── 8. Low Average Transaction Value ──────────────────────────────

  const atv = overview.averageTransactionValue || 0;
  if (atv > 0 && atv < 5000 && txCount > 50) {
    const topVol = concentration.topByVolume;
    push({
      observation: `Average spend per transaction is ${fmtNaira(atv)} — below the ₦5,000 threshold for a healthy pharmacy.`,
      evidence: [
        `Average transaction value: ${fmtNaira(atv)}.`,
        `Total transactions: ${txCount.toLocaleString('en-NG')}.`,
        topVol ? `${topVol.name} leads in volume with ${topVol.quantity || 'N/A'} units sold.` : '',
      ],
      businessImpact: `Increasing the average basket by just ₦1,000 would generate ${fmtNaira(txCount * 1000)} in additional annual revenue — without acquiring a single new customer.`,
      recommendedAction: topVol
        ? `Train staff to suggest one complementary product with every ${topVol.name} purchase — for example, vitamins with antibiotics. Create pre-bundled packs at the counter.`
        : `Train staff on suggestive selling. Create impulse-buy displays near the counter with small, high-margin items.`,
      expectedOutcome: `Average transaction value increased by at least ₦1,000 through suggestive selling and bundling.`,
      confidence: confidenceBase,
      priorityScore: round((5000 - atv) / 100, 2),
      impact: 2,
      urgency: 1,
      pillar: 'Customer Health',
      metric: 'Average Spend',
    });
  }

  // ── 9. Margin Erosion (High Revenue, Low Margin) ──────────────────

  if (concentration.lowestMargin && concentration.top1) {
    const lm = concentration.lowestMargin;
    if (lm.revenue / overview.totalRevenue > 0.15 && lm.margin < 25) {
      push({
        observation: `${lm.name} generates ${fmtPct(round(lm.revenue / overview.totalRevenue * 100, 0))} of revenue at just ${fmtPct(lm.margin)} margin. This product is effectively underwriting your operations at very low profitability.`,
        evidence: [
          `${lm.name}: revenue ${fmtNaira(lm.revenue)} (${fmtPct(round(lm.revenue / overview.totalRevenue * 100, 0))} of total) at ${fmtPct(lm.margin)} margin.`,
          `Gross profit from ${lm.name}: approximately ${fmtNaira(round(lm.revenue * lm.margin / 100, 0))}.`,
        ],
        businessImpact: `At ${fmtPct(lm.margin)} margin on your largest product, you are working hard for thin returns. A 5-point margin improvement on ${lm.name} alone would add ${fmtNaira(round(lm.revenue * 0.05, 0))} in profit.`,
        recommendedAction: `Switch to a clinically equivalent generic alternative with better supplier margins. Get quotes from at least 2 alternative wholesalers for ${lm.name}.`,
        expectedOutcome: `Margin on ${lm.name} improved by 5+ points through supplier renegotiation or generic substitution.`,
        confidence: confidenceBase,
        priorityScore: round((25 - (lm.margin || 0)) * 2, 2),
        impact: 3,
        urgency: 2,
        pillar: 'Profitability',
        metric: 'Discount Impact',
      });
    }
  }

  // ── 10. Overall Summary (always included) ─────────────────────────

  const allProds = metrics.products?.allProducts || [];
  const marginOk = overview.grossMargin >= 30;
  const growthOk = trend.summary === 'stable' || trend.summary === 'up';
  const txOk = avgTxMonth >= 50;
  const concOk = concentration.top1Share < 40;

  const strengths = [];
  const weaknesses = [];
  if (marginOk) strengths.push(`healthy margin of ${fmtPct(overview.grossMargin)}`);
  else weaknesses.push(`margin at ${fmtPct(overview.grossMargin)} needs improvement`);
  if (txCount >= 200) strengths.push(`${txCount.toLocaleString('en-NG')} transactions of reliable data`);
  else weaknesses.push(`only ${txCount} transactions — limited data for trend analysis`);
  if (allProds.length >= 5) strengths.push(`${allProds.length} distinct products`);
  if (!concOk) weaknesses.push(`heavy reliance on ${concentration.top1 ? concentration.top1.name : 'one product'} (${fmtPct(concentration.top1Share)} of revenue)`);

  if (strengths.length > 0 || weaknesses.length > 0) {
    const strengthText = strengths.length > 0
      ? `Your business benefits from ${strengths.join(', ')}.`
      : '';
    const weaknessText = weaknesses.length > 0
      ? `Areas to address: ${weaknesses.join(', ')}.`
      : '';

    push({
      observation: `${strengthText} ${weaknessText}`.trim(),
      evidence: [
        `Revenue: ${fmtNaira(overview.totalRevenue)} over ${months.length} months.`,
        `Gross profit: ${fmtNaira(overview.grossProfit)} (${fmtPct(overview.grossMargin)} margin).`,
        `${allProds.length} distinct products across ${months.length} months.`,
        `${txCount.toLocaleString('en-NG')} total transactions.`,
      ],
      businessImpact: weaknessText || 'Maintaining current performance requires focused attention on the areas above.',
      recommendedAction: weaknesses.length > 0
        ? `Prioritise: ${weaknesses.slice(0, 2).join('; ')}.`
        : `Continue current strategy. Monitor monthly trends to catch any slowdown early.`,
      expectedOutcome: `Sustained business health with margin above 30% and diversified revenue sources.`,
      confidence: confidenceBase,
      priorityScore: 5,
      impact: 1,
      urgency: 0,
      pillar: 'Operational Excellence',
      metric: 'Record Quality Score',
    });
  }

  // ── Weather-driven demand (fully optional — absent by default) ──
  // opts.weatherSignals.demandRules is only set when a caller explicitly
  // fetched it (see weatherCache.getOrFetch + weatherDecisionRules
  // .evaluateWeatherDemandRules in index.js) — already the top 0-2
  // qualifying rules against live weather + this pharmacy's own category
  // keywords. Without it, this block never runs and generateInsights()
  // behaves exactly as it always has.
  const demandRules = opts.weatherSignals?.demandRules || [];
  for (const { rule, numericConfidence, evidence } of demandRules) {
    const w = opts.weatherSignals;
    const hasEvidence = evidence.available;
    // The rule's expectedDemand is a clinical HYPOTHESIS. Only treat it as
    // confirmed when this pharmacy's own data actually moves the same
    // direction — otherwise say so plainly rather than recommending action
    // "ahead of an increase" the data doesn't support.
    const confirms = hasEvidence && evidence.pctIncrease > 0;
    const contradicts = hasEvidence && evidence.pctIncrease <= 0;
    const periodLabel = evidence.comparedAs === 'season-vs-season'
      ? { in: 'in-season', out: 'off-season' }
      : { in: 'recent (last 30 days)', out: 'prior 30-day period' };

    const observation = hasEvidence
      ? `${w.state || 'Your area'} is showing ${rule.weatherSignal} (risk: HIGH). ${rule.category} sales ran ${fmtPct(Math.abs(evidence.pctIncrease))} ${evidence.pctIncrease >= 0 ? 'higher' : 'lower'} in the ${periodLabel.in} period than the ${periodLabel.out}${contradicts ? ' — the opposite of the usual clinical pattern for this weather condition' : ' in your own data'}.`
      : `${w.state || 'Your area'} is showing ${rule.weatherSignal} (risk: HIGH). ${rule.rationale}`;

    const projectedRevenue = confirms ? Math.max(0, evidence.avgInPeriodRevenue - evidence.avgOutPeriodRevenue) : null;

    push({
      observation,
      evidence: [
        `Weather signal: ${rule.weatherSignal} — HIGH (live reading for ${w.state}).`,
        hasEvidence
          ? `${periodLabel.in} average revenue: ${fmtNaira(evidence.avgInPeriodRevenue)} vs. ${periodLabel.out} average: ${fmtNaira(evidence.avgOutPeriodRevenue)}.`
          : evidence.reason,
        `Clinical rationale: ${rule.rationale}`,
      ],
      businessImpact: confirms
        ? `${rule.category} revenue could run ${fmtNaira(projectedRevenue)} above a typical period if this pattern holds.`
        : contradicts
          ? `Your own sales history doesn't show the usual weather-driven pattern for ${rule.category} — this may not be worth prioritising right now despite the current weather signal.`
          : `Expected demand direction: ${rule.expectedDemand} for ${rule.category} — no historical pattern in your data yet to size the ₦ impact.`,
      recommendedAction: confirms
        ? `Review ${rule.category} stock levels ahead of the expected ${rule.expectedDemand.toLowerCase()} in demand.`
        : contradicts
          ? `Monitor ${rule.category} stock as usual — your own data doesn't confirm a weather-driven demand jump here.`
          : `Review ${rule.category} stock levels ahead of the expected ${rule.expectedDemand.toLowerCase()} in demand — a clinical pattern, not yet confirmed by your own sales history.`,
      expectedOutcome: `Avoided stockouts on ${rule.category} products during this weather-driven demand window.`,
      confidence: confirms ? numericConfidence : contradicts ? Math.max(20, numericConfidence - 40) : Math.max(30, numericConfidence - 20),
      priorityScore: (confirms ? numericConfidence : contradicts ? numericConfidence - 40 : numericConfidence - 20) * (rule.expectedDemand === 'Increase' ? 0.7 : 0.5),
      impact: rule.expectedDemand === 'Increase' ? 2 : 1,
      urgency: hasEvidence && evidence.pctIncrease > 25 ? 3 : 2,
      pillar: 'Inventory',
      metric: `Seasonal Demand — ${rule.category}`,
    });
  }

  // Phase 2 (Calendar Intelligence integration): collect weather + calendar
  // signals into one flat list for future recommendation logic. This does
  // NOT feed into insight generation above — that block already ran and is
  // untouched. Not merged, not ranked, not filtered — see getExternalSignals().
  opts.externalSignals = getExternalSignals(opts);

  // Final sort: highest priority first, ensure we have at most 8 insights
  insights.sort((a, b) => b.priorityScore - a.priorityScore);
  return insights.slice(0, 8);
}

/**
 * Collects Weather Intelligence and Calendar Intelligence demand signals
 * into a single flat array — externalSignals = [...weatherSignals,
 * ...calendarSignals]. Deliberately does no deduplication, ranking, or
 * filtering; this is scaffolding for future recommendation logic, not a
 * new recommendation engine. Calendar Intelligence itself is treated as
 * read-only — this function only reads its output via getCalendarSignals(),
 * defined in services/calendar/calendarService.js, which this function
 * does not modify.
 *
 * @param {Object} opts
 * @param {Object} [opts.weatherSignals] - from weatherCache.getOrFetch() + weatherDecisionRules.evaluateWeatherDemandRules()
 * @param {Array}  [opts.calendarSignals] - from calendarService.getCalendarSignals()
 */
function getExternalSignals(opts = {}) {
  const weatherSignals = (opts.weatherSignals?.demandRules || []).map(({ rule, evidence }) => ({
    source: 'weather',
    event: rule.weatherSignal,
    category: rule.category,
    expectedDemand: rule.expectedDemand,
    evidenceStrength: rule.confidence,
    rationale: rule.rationale,
    confirmedByOwnData: evidence.available ? evidence.pctIncrease > 0 : null,
  }));
  const calendarSignals = (opts.calendarSignals || []).map((s) => ({ source: 'calendar', ...s }));

  return [...weatherSignals, ...calendarSignals];
}

module.exports = { generateInsights, getExternalSignals };
