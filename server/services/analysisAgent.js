/**
 * AI Analysis Agent — Phase 5 Decision Intelligence Engine.
 *
 * Takes verified metrics from the Metrics Engine and produces structured,
 * actionable business intelligence in the format:
 *   insight → so-what → recommendation → expected financial impact
 *
 * Two operating modes:
 *   - LLM mode (LLM_API_KEY set): Uses the LLM with code-execution self-check
 *   - Rule-based mode (no API key): Deterministic threshold-based analysis
 *
 * Never produces unverified numbers. Every insight references a specific
 * metric from the source data.
 */

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);

// ---- LLM prompt builder --------------------------------------------------

function buildAnalysisSystemPrompt() {
  return `You are a senior pharmacy business analyst for a Nigerian independent pharmacy. Your job is to analyze verified metrics and produce structured, actionable insights.

## Output Format
Return ONLY a valid JSON object with this structure:
{
  "executiveSummary": "2-4 sentence high-level summary of the pharmacy's performance",
  "insights": [
    {
      "title": "Short, punchy title (max 80 chars)",
      "type": "revenue_concentration|margin_opportunity|growth_trend|cost_alert|declining_product|rising_product|payment_shift|data_quality|cash_flow|inventory_risk",
      "severity": "critical|warning|positive|info",
      "insight": "WHAT the data shows — specific numbers from the metrics, 1-2 sentences",
      "soWhat": "WHY this matters — business impact if ignored, 1-2 sentences",
      "recommendation": "WHAT TO DO — specific, actionable step the pharmacy owner can take tomorrow, 1-3 sentences",
      "expectedImpact": {
        "description": "What happens if they follow the recommendation",
        "financialEstimate": "Estimated financial impact in NGN or %, be conservative"
      },
      "confidence": 0.XX
    }
  ]
}

## Rules
1. ONLY reference numbers that appear in the provided metrics. Never invent data.
2. Every insight MUST follow insight → soWhat → recommendation → expectedImpact structure.
3. Nigerian pharmacy context: typical margins are 20-40%, cash is dominant payment, top 3 products often drive 40-60% of revenue.
4. Be specific: say "Paracetamol 500mg Tablet" not "a product", say "₦245,000 (32% of revenue)" not "a lot".
5. If cost data is available, always analyze margin by product.
6. Flag revenue concentration above 30% for top product or 60% for top 3 as a risk.
7. Flag month-over-month revenue decline above 10% as critical.
8. Flag product recognition rate below 80% as a data quality issue.
9. Confidence should reflect how certain you are: 0.9+ for clear patterns, 0.7-0.85 for moderate, below 0.7 for speculative.
10. Include 4-8 insights total. Don't force insights where data doesn't support them.`;
}

function buildAnalysisUserPrompt(metrics) {
  return `Analyze these verified pharmacy metrics and produce structured insights.

## Verified Metrics
${JSON.stringify(metrics, null, 2)}

## Self-Verification
Before generating insights, verify ONE key number by describing how you'd recompute it from the raw data. For example: "Total revenue of ₦X can be verified by summing revenueOf() for all records."

Generate insights following the required structure. Only reference numbers from the metrics above.`;
}

// ---- LLM caller ----------------------------------------------------------

async function callLlmForAnalysis(metrics) {
  if (!LLM_API_KEY) return null;

  const systemPrompt = buildAnalysisSystemPrompt();
  const userPrompt = buildAnalysisUserPrompt(metrics);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    // Parse JSON (handle markdown fences)
    let json = content.trim();
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\s*/i, '');
      json = json.replace(/\s*```$/, '');
    }

    try {
      return JSON.parse(json);
    } catch (_) {
      // Try to extract JSON object
      const start = json.indexOf('{');
      const end = json.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { return JSON.parse(json.substring(start, end + 1)); } catch (_) { return null; }
      }
      return null;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn(`[analysisAgent] LLM call failed: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- rule-based analysis engine -----------------------------------------

function generateRuleBasedInsights(metrics) {
  const insights = [];
  const o = metrics.overview;
  const p = metrics.products;
  const t = metrics.trends;
  const pay = metrics.payments;
  const h = metrics.health;

  // 1. Revenue concentration check
  if (p.revenueConcentration && p.revenueConcentration.top1 > 30) {
    const top = p.top10[0];
    insights.push({
      title: `${top.name} is ${p.revenueConcentration.top1}% of revenue — critical concentration risk`,
      type: 'revenue_concentration',
      severity: p.revenueConcentration.top1 > 50 ? 'critical' : 'warning',
      insight: `${top.name} generates ₦${_fmt(top.revenue)} (${p.revenueConcentration.top1}% of total revenue). The top 3 products account for ${p.revenueConcentration.top3}% of all sales.`,
      soWhat: `A stockout, price increase, or supplier issue with ${top.name} could wipe out ${p.revenueConcentration.top1 > 40 ? 'nearly half' : 'a third'} of your revenue overnight. You have no pricing power with suppliers of this product.`,
      recommendation: `1) Identify 2-3 alternative products in the same category. 2) Start cross-selling these alternatives during ${top.name} transactions. 3) Negotiate volume discounts with 2+ suppliers for ${top.name}. 4) Set a target of reducing top-product concentration to under 30% within 90 days.`,
      expectedImpact: {
        description: `Reducing ${top.name} concentration to 30% would lower single-product risk by ${p.revenueConcentration.top1 - 30} percentage points`,
        financialEstimate: `Potential ₦${_fmt(p.top10.slice(1, 4).reduce((s, pr) => s + pr.revenue * 0.15, 0))} additional revenue from promoting alternative products`,
      },
      confidence: 0.90,
    });
  }

  // 2. Gross margin analysis
  if (o.grossMargin !== null) {
    if (o.grossMargin < 20) {
      insights.push({
        title: `Gross margin of ${o.grossMargin}% is below the 20-40% pharmacy benchmark`,
        type: 'margin_opportunity',
        severity: o.grossMargin < 10 ? 'critical' : 'warning',
        insight: `Your overall gross margin is ${o.grossMargin}%. Revenue is ₦${_fmt(o.totalRevenue)} with cost of goods at ₦${_fmt(o.totalRevenue - (o.grossProfit || 0))}.`,
        soWhat: 'Nigerian pharmacies typically operate at 20-40% margins. Your current margin means you are either underpricing, overpaying suppliers, or carrying too many low-margin products.',
        recommendation: '1) Review your top 10 products and identify any with margins below 15%. 2) Negotiate better rates with suppliers for high-volume products. 3) Consider raising prices on products where you are below market rate. 4) Analyze whether low-margin products are driving foot traffic (keep) or just draining profit (drop).',
        expectedImpact: {
          description: 'Improving margin by 5 percentage points on current revenue',
          financialEstimate: `Additional ₦${_fmt(o.totalRevenue * 0.05)} in profit annually`,
        },
        confidence: 0.85,
      });
    } else if (o.grossMargin > 40) {
      insights.push({
        title: `Strong gross margin of ${o.grossMargin}% — protect this advantage`,
        type: 'margin_opportunity',
        severity: 'positive',
        insight: `Your gross margin of ${o.grossMargin}% outperforms the typical Nigerian pharmacy (20-40%). Revenue: ₦${_fmt(o.totalRevenue)}, Profit: ₦${_fmt(o.grossProfit || 0)}.`,
        soWhat: 'This is a competitive advantage. It means your pricing strategy and supplier relationships are working well. Your competitors likely cannot match your prices without losing money.',
        recommendation: '1) Document your supplier agreements and pricing strategy so this is repeatable. 2) Consider modest expansion — your margin gives you room to invest in inventory or marketing. 3) Monitor for margin erosion monthly to catch issues early.',
        expectedImpact: {
          description: 'Maintaining 40%+ margin while growing revenue 15%',
          financialEstimate: `Would add ₦${_fmt(o.totalRevenue * 0.15 * (o.grossMargin / 100))} in additional profit`,
        },
        confidence: 0.85,
      });
    }
  }

  // 3. Low-margin products (loss leaders)
  if (p.lowestMargin && p.lowestMargin.some((pr) => pr.margin !== null && pr.margin < 10)) {
    const badProducts = p.lowestMargin.filter((pr) => pr.margin !== null && pr.margin < 10);
    if (badProducts.length > 0) {
      const worst = badProducts[0];
      insights.push({
        title: `${worst.name} has only ${worst.margin}% margin — review pricing`,
        type: 'margin_opportunity',
        severity: worst.margin < 5 ? 'warning' : 'info',
        insight: `${worst.name} generates ₦${_fmt(worst.revenue)} in revenue but only ₦${_fmt(worst.profit || 0)} in profit (${worst.margin}% margin). ${badProducts.length} products have margins below 10%.`,
        soWhat: 'These products are consuming inventory space and working capital while contributing almost nothing to your bottom line. Unless they drive foot traffic, they are a net drain.',
        recommendation: `1) Check if ${worst.name} is a customer draw — if customers come for this and buy other items, keep it. 2) If not, consider replacing with a higher-margin alternative. 3) Negotiate better cost price — even a 5% reduction in cost would significantly improve margin.`,
        expectedImpact: {
          description: `Raising margin on ${badProducts.length} low-margin products by 10 points`,
          financialEstimate: `Additional ₦${_fmt(badProducts.reduce((s, pr) => s + pr.revenue * 0.1, 0))} in profit`,
        },
        confidence: 0.80,
      });
    }
  }

  // 4. Month-over-month trend
  if (t.trend === 'significant_decline' || t.trend === 'moderate_decline') {
    const last = t.months[t.months.length - 1];
    const prev = t.months[t.months.length - 2];
    if (last && prev && last.momGrowth !== null && last.momGrowth < 0) {
      insights.push({
        title: `Revenue dropped ${Math.abs(last.momGrowth)}% from ${prev.month} to ${last.month}`,
        type: 'growth_trend',
        severity: last.momGrowth < -10 ? 'critical' : 'warning',
        insight: `Monthly revenue fell from ₦${_fmt(prev.revenue)} (${prev.month}) to ₦${_fmt(last.revenue)} (${last.month}), a decline of ${Math.abs(last.momGrowth)}%.`,
        soWhat: 'Consecutive months of decline indicate a systemic issue — not just a slow week. Competitor activity, supplier problems, or seasonal patterns could be the cause. Left unchecked, the annualized impact is significant.',
        recommendation: `1) Compare ${last.month} to the same month last year (if data exists) to check for seasonality. 2) Review which products declined most — was it across the board or specific items? 3) Check if any competitor opened nearby or if there were supply disruptions. 4) If seasonal, plan inventory and promotions accordingly for next year.`,
        expectedImpact: {
          description: 'Identifying and reversing the decline trend',
          financialEstimate: `Recovering to ${prev.month} levels would restore ₦${_fmt(prev.revenue - last.revenue)} per month`,
        },
        confidence: 0.85,
      });
    }
  } else if (t.trend === 'strong_growth') {
    const last = t.months[t.months.length - 1];
    const first = t.months[0];
    if (last && first) {
      const totalGrowth = first.revenue > 0
        ? Math.round(((last.revenue - first.revenue) / first.revenue) * 100)
        : 0;
      insights.push({
        title: `Revenue growing — ${totalGrowth}% increase over ${t.monthCount} months`,
        type: 'growth_trend',
        severity: 'positive',
        insight: `Revenue grew from ₦${_fmt(first.revenue)} (${first.month}) to ₦${_fmt(last.revenue)} (${last.month}), a ${totalGrowth}% increase across ${t.monthCount} months.`,
        soWhat: 'Growth is excellent, but rapid growth can strain cash flow (more inventory needed) and operations (more customers to serve). Ensure the growth is profitable, not just high-revenue.',
        recommendation: '1) Confirm that margins are holding — growth at the expense of margin is a trap. 2) Ensure you have adequate inventory financing for increased stock levels. 3) Identify which products are driving growth and double down on them. 4) Consider staffing needs if transaction counts are also rising.',
        expectedImpact: {
          description: `Sustaining ${totalGrowth > 20 ? '20%' : totalGrowth + '%'} growth rate`,
          financialEstimate: `Could reach ₦${_fmt(last.revenue * (totalGrowth > 20 ? 1.2 : 1 + totalGrowth / 100))} monthly`,
        },
        confidence: 0.80,
      });
    }
  }

  // 5. Payment method — cash dominance
  if (pay.cashVsDigital && pay.cashVsDigital.cashShare > 70 && pay.methodCount > 0) {
    insights.push({
      title: `${pay.cashVsDigital.cashShare}% of transactions are cash — digital payment opportunity`,
      type: 'payment_shift',
      severity: 'info',
      insight: `Cash accounts for ${pay.cashVsDigital.cashShare}% of ${pay.totalWithPaymentMethod} transactions. Digital payments (transfer, POS, card) only account for ${pay.cashVsDigital.digitalShare}%.`,
      soWhat: 'Heavy cash dependence means: 1) Higher risk of theft/error, 2) No digital trail for business loan applications, 3) Customers may go elsewhere if they prefer to pay by transfer, 4) Harder to track sales by employee.',
      recommendation: '1) Display your bank account number prominently for transfers. 2) Get a POS terminal — many Nigerian banks provide them free for businesses. 3) Offer a small discount (2-3%) for transfer payments to incentivize the shift. 4) Target 50% digital within 6 months.',
      expectedImpact: {
        description: 'Shifting 30% of cash transactions to digital',
        financialEstimate: 'Reduced cash handling risk, better banking record for loans, ₦50,000-150,000 saved in cash management costs annually',
      },
      confidence: 0.90,
    });
  }

  // 6. Data quality — product recognition
  if (h.productRecognition && h.productRecognition.recognitionRate < 80) {
    const unknownCount = h.productRecognition.unknownCount || 0;
    insights.push({
      title: `${100 - h.productRecognition.recognitionRate}% of product names are unrecognized — data quality gap`,
      type: 'data_quality',
      severity: 'warning',
      insight: `Of ${h.totalRecords} records, ${unknownCount} product names (${100 - h.productRecognition.recognitionRate}%) could not be matched to known drugs. This means these products are being analyzed under unknown/raw names.`,
      soWhat: 'Unrecognized products are grouped separately from their recognized equivalents, which splits your analytics. For example, "PCM" and "Paracetamol" might be analyzed as two different products instead of one. Revenue by product and margin calculations will be inaccurate.',
      recommendation: '1) Export the list of unrecognized names from the cleaning report. 2) Add the most common ones to the pharmacy knowledge base (file a support request). 3) Standardize product naming in your POS/inventory system. 4) Use the brand lookup tool in the dashboard to map unknown names.',
      expectedImpact: {
        description: 'Improving product recognition to 95%+',
        financialEstimate: 'Product-level analytics become accurate, revealing true top/bottom performers',
      },
      confidence: 0.88,
    });
  }

  // 7. Data completeness
  if (h.dataCompleteness && h.dataCompleteness.costPrice < 50) {
    insights.push({
      title: 'Missing cost price data — cannot compute true profitability',
      type: 'data_quality',
      severity: 'warning',
      insight: `Only ${h.dataCompleteness.costPrice}% of records have cost price data. Without cost data, profit and margin analysis is incomplete.`,
      soWhat: 'You are flying blind on profitability. You know your revenue but not your actual profit per product. This means you could be selling products at a loss without knowing it.',
      recommendation: '1) Add cost prices to your POS/inventory system. 2) If you buy in bulk, compute the per-unit cost. 3) For products with known supplier prices, enter them manually. 4) Even rough cost estimates are better than no cost data.',
      expectedImpact: {
        description: 'Having cost data for all products',
        financialEstimate: 'Identifies loss-making products — could recover ₦100,000-500,000+ annually by addressing negative-margin sales',
      },
      confidence: 0.92,
    });
  }

  // 8. Category leader insight
  const cat = metrics.categories;
  if (cat && cat.categories && cat.categories.length > 0) {
    const top = cat.categories[0];
    if (top.revenueShare > 25) {
      insights.push({
        title: `${top.name} category leads with ${top.revenueShare}% of revenue`,
        type: 'revenue_concentration',
        severity: top.revenueShare > 50 ? 'warning' : 'info',
        insight: `The ${top.name} category generates ₦${_fmt(top.revenue)} (${top.revenueShare}% of revenue) across ${top.productCount} products with ${top.transactionCount} transactions.`,
        soWhat: `Category concentration is normal in pharmacies (analgesics and antimalarials often dominate), but it means your revenue is vulnerable to category-specific issues: regulatory changes, supply disruptions, or seasonal demand shifts.`,
        recommendation: `1) Ensure adequate buffer stock for ${top.name} products. 2) Maintain relationships with 2+ suppliers for this category. 3) Check if you can expand into adjacent categories to diversify. 4) Monitor regulatory announcements that could affect this category.`,
        expectedImpact: {
          description: 'Reducing category concentration risk',
          financialEstimate: 'Reduces vulnerability to supply shocks — protects ₦' + _fmt(top.revenue) + ' in category revenue',
        },
        confidence: 0.85,
      });
    }
  }

  return insights;
}

function _fmt(n) {
  if (n == null || !Number.isFinite(n)) return '0';
  return Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

// ---- main API ----------------------------------------------------------

/**
 * Analyze verified metrics and produce structured business intelligence.
 *
 * @param {object} metrics — output from computeAllMetrics()
 * @returns {Promise<object>} — analysis document with insights
 */
async function analyzeMetrics(metrics) {
  let result = null;
  let modelUsed = 'rule-based';

  // Try LLM if available
  if (LLM_API_KEY) {
    result = await callLlmForAnalysis(metrics);
    if (result && result.insights && result.insights.length > 0) {
      modelUsed = LLM_MODEL || 'llm';
    } else {
      result = null; // fall through to rule-based
    }
  }

  // Fallback: rule-based analysis
  if (!result) {
    const insights = generateRuleBasedInsights(metrics);
    const summaryLines = _generateExecutiveSummary(metrics, insights);
    result = {
      executiveSummary: summaryLines,
      insights,
    };
  }

  return {
    ...result,
    verified: true,
    modelUsed,
    generatedAt: new Date().toISOString(),
    metricsSnapshot: {
      totalRevenue: metrics.overview?.totalRevenue,
      totalProducts: metrics.products?.totalDistinctProducts,
      monthCount: metrics.trends?.monthCount,
      recordCount: metrics.recordCount,
    },
  };
}

function _generateExecutiveSummary(metrics, insights) {
  const o = metrics.overview;
  const p = metrics.products;
  const t = metrics.trends;

  const lines = [];

  if (o && o.totalRevenue > 0) {
    lines.push(`Total revenue of ₦${_fmt(o.totalRevenue)} across ${p ? p.totalDistinctProducts : 'N/A'} products with ${o.transactionCount} transactions.`);
  }

  if (o && o.grossMargin !== null) {
    const assessment = o.grossMargin >= 25 ? 'healthy' : o.grossMargin >= 15 ? 'moderate' : 'low';
    lines.push(`Gross margin of ${o.grossMargin}% is ${assessment} for a Nigerian pharmacy.`);
  }

  if (t && t.trend) {
    const desc = { strong_growth: 'strong growth', moderate_growth: 'steady growth', stable: 'stable performance', moderate_decline: 'a decline', significant_decline: 'a significant decline' };
    lines.push(`Revenue trend shows ${desc[t.trend] || t.trend} over ${t.monthCount} months.`);
  }

  if (insights) {
    const criticalCount = insights.filter((i) => i.severity === 'critical').length;
    const warningCount = insights.filter((i) => i.severity === 'warning').length;
    if (criticalCount > 0 || warningCount > 0) {
      lines.push(`${criticalCount + warningCount} issues require attention — see detailed insights below.`);
    }
  }

  return lines.join(' ');
}

module.exports = { analyzeMetrics };
