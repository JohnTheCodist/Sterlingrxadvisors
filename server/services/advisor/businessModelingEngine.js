/**
 * Business Modeling Engine — the Advisor's planning and simulation layer.
 *
 * The rest of the Advisor answers "what happened?" from validated analytics.
 * This answers "what should I do?", "what if I do X?" and "how do I reach Y?"
 *
 * ── What this engine is NOT ────────────────────────────────────────────────
 * It is not a second analytics engine. It computes NO metric of its own from
 * the database. Every current-state figure it uses comes from the existing
 * validated queries (getRevenueProfitSummary, getDatasetMetric), and every
 * projected figure is explicit arithmetic over those figures. If the source
 * figure is null because cost coverage was too thin, this engine reports the
 * same shortfall rather than modeling around it.
 *
 * That constraint is the whole design. A planning layer that quietly invents
 * its own baseline would produce plausible naira figures with nothing behind
 * them — the single worst failure mode this platform has.
 *
 * ── Modeling vs. guessing ──────────────────────────────────────────────────
 * Modeling is allowed; guessing is not. Every scenario states the assumptions
 * it rests on, in plain language, in an `assumptions` array the Advisor is
 * required to surface. A projection whose assumptions are hidden is a guess
 * wearing a suit.
 *
 * ── Confidence ─────────────────────────────────────────────────────────────
 *   fact       — read directly from validated analytics. High confidence.
 *   scenario   — arithmetic over a fact under stated assumptions. Medium.
 *   hypothesis — a possible explanation nothing in the data confirms. Low.
 * Every figure this engine returns is labelled with one of the three, so the
 * Advisor can calibrate its language instead of flattening all three into the
 * same declarative voice.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * Defaults to the CURRENT UPLOAD, and inherits the existing scope gate
 * verbatim — if the current upload has no sales rows but history does, this
 * returns that same availableInCurrentUpload:false shape rather than reaching
 * backwards on its own initiative.
 */

const queries = require('../advisorQueries');

// ---- helpers ---------------------------------------------------------------

const round = (n, dp = 2) => {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const f = 10 ** dp;
  return Math.round(Number(n) * f) / f;
};

const pct = (n) => round(n, 1);

/** Whole units — you cannot serve 4.3 extra customers. */
const ceilUnits = (n) => (Number.isFinite(Number(n)) ? Math.ceil(Number(n)) : null);

function daysBetween(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const a = new Date(startISO);
  const b = new Date(endISO);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  // Inclusive of both endpoints — a single-day file covers 1 day, not 0.
  const d = Math.round((b - a) / 86400000) + 1;
  return d > 0 ? d : null;
}

/**
 * A scope gate result from the underlying query passes straight through.
 * Detecting it by shape rather than re-running the check keeps this engine
 * from having its own, separately-drifting copy of that rule.
 */
const isScopeGate = (r) => !!r && r.availableInCurrentUpload === false;

function missing(what, needs, extra = {}) {
  return { available: false, reason: what, missing: needs, ...extra };
}

// ---- current state ---------------------------------------------------------

/**
 * The baseline every model is built on. Sales-side first; when the upload is
 * an inventory snapshot with no transactions, falls back to the stock-side
 * potential figures, which are a legitimate baseline for planning questions
 * even though no selling has happened yet.
 */
async function loadBaseline(organizationId, scope) {
  const sales = await queries.getRevenueProfitSummary(organizationId, { scope });

  if (!isScopeGate(sales) && Number(sales.transactionCount) > 0) {
    return {
      kind: 'sales',
      scope: sales.scope,
      scopeNote: sales.scopeNote,
      revenue: sales.totalRevenue,
      profit: sales.grossProfit,
      marginPct: sales.grossMargin,
      cost: sales.totalCost,
      transactions: sales.transactionCount,
      units: sales.totalQuantitySold,
      avgTransactionValue: sales.averageTransactionValue,
      periodStart: sales.periodStart,
      periodEnd: sales.periodEnd,
      periodDays: daysBetween(sales.periodStart, sales.periodEnd),
      costCoverage: sales.costCoverage,
      source: 'getRevenueProfitSummary',
    };
  }

  // Inventory-only upload. potential_* are what this stock COULD return if
  // sold at the recorded selling price — a forward-looking baseline, so it is
  // labelled as such and never presented as achieved revenue.
  const [pRev, pProfit, pMargin] = await Promise.all([
    queries.getDatasetMetric(organizationId, { measure: 'potential_revenue', scope }),
    queries.getDatasetMetric(organizationId, { measure: 'potential_gross_profit', scope }),
    queries.getDatasetMetric(organizationId, { measure: 'potential_margin_pct', scope }),
  ]);

  if (pRev && pRev.available !== false && pRev.value != null) {
    return {
      kind: 'inventory',
      scope,
      scopeNote: 'Based on the current inventory snapshot — stock on hand at recorded prices, not sales history.',
      potentialRevenue: pRev.value,
      potentialProfit: pProfit && pProfit.available !== false ? pProfit.value : null,
      potentialMarginPct: pMargin && pMargin.available !== false ? pMargin.value : null,
      source: 'getDatasetMetric',
      salesGate: isScopeGate(sales) ? sales : null,
    };
  }

  return { kind: 'none', salesGate: isScopeGate(sales) ? sales : null, sales };
}

// ---- goal modeling ---------------------------------------------------------

const GOAL_METRICS = new Set(['revenue', 'profit']);

/**
 * "How do I reach ₦2M revenue?" / "How do I get profit to ₦500k?"
 *
 * Decomposes the target into the drivers that actually move it and sizes the
 * change each one would need to carry ALONE, plus a blended path where both
 * move together. Options are alternatives, not a sequence — an owner picks
 * the lever they can actually pull.
 */
async function modelGoal(organizationId, params = {}) {
  const { metric, target, scope = 'current' } = params;

  if (!GOAL_METRICS.has(metric)) {
    return { error: `Unknown metric '${metric}'. Supported: ${[...GOAL_METRICS].join(', ')}.` };
  }
  const targetNum = Number(target);
  if (!Number.isFinite(targetNum) || targetNum <= 0) {
    return { error: 'target must be a positive number (the figure the owner wants to reach).' };
  }

  const base = await loadBaseline(organizationId, scope);

  if (base.kind === 'none') {
    if (base.salesGate) return base.salesGate;
    return missing(
      'There is no sales or inventory data in the current upload to model a plan from.',
      ['sales transactions, or an inventory snapshot with selling prices and current stock']
    );
  }

  if (base.kind === 'inventory') {
    return modelGoalFromInventory(base, metric, targetNum);
  }

  return metric === 'revenue'
    ? modelRevenueGoal(base, targetNum)
    : modelProfitGoal(base, targetNum);
}

function modelRevenueGoal(base, target) {
  const { revenue, transactions, avgTransactionValue: atv, periodDays } = base;

  if (!(revenue > 0) || !(transactions > 0) || !(atv > 0)) {
    return missing(
      'Revenue, transaction count and average transaction value are all needed to model a revenue goal, and at least one is zero or unavailable in the current upload.',
      ['sales transactions with prices']
    );
  }

  const gap = target - revenue;
  const ratio = target / revenue;
  const options = [];

  if (gap <= 0) {
    return {
      available: true,
      kind: 'goal_model',
      objective: { metric: 'revenue', target: round(target), reached: true },
      currentState: currentStateBlock(base),
      gap: { absolute: round(gap), pct: pct((gap / revenue) * 100), direction: 'already_met' },
      message: `Current revenue of ₦${round(revenue)} already meets the ₦${round(target)} target.`,
      assumptions: [],
      confidence: 'fact',
      scope: base.scope,
      scopeNote: base.scopeNote,
    };
  }

  // Lever 1 — serve more transactions at today's basket size.
  const reqTransactions = target / atv;
  const extraTransactions = reqTransactions - transactions;
  options.push({
    id: 'more_transactions',
    lever: 'Transaction volume',
    description: `Serve ${ceilUnits(extraTransactions)} more transactions over the same period, holding the average basket at ₦${round(atv)}.`,
    requiredValue: ceilUnits(reqTransactions),
    currentValue: transactions,
    changeAbsolute: ceilUnits(extraTransactions),
    changePct: pct((extraTransactions / transactions) * 100),
    perDay: periodDays ? round(extraTransactions / periodDays, 1) : null,
    perDayNote: periodDays
      ? `About ${round(extraTransactions / periodDays, 1)} extra transactions per day across the ${periodDays}-day period this upload covers.`
      : null,
    assumptions: [
      `Assumes the average transaction value stays at ₦${round(atv)}.`,
      'Assumes the current product mix is unchanged.',
    ],
    confidence: 'scenario',
  });

  // Lever 2 — same footfall, bigger basket.
  const reqAtv = target / transactions;
  options.push({
    id: 'bigger_basket',
    lever: 'Average basket value',
    description: `Lift the average basket from ₦${round(atv)} to ₦${round(reqAtv)} across the same ${transactions} transactions.`,
    requiredValue: round(reqAtv),
    currentValue: round(atv),
    changeAbsolute: round(reqAtv - atv),
    changePct: pct(((reqAtv - atv) / atv) * 100),
    assumptions: [
      `Assumes transaction count stays at ${transactions}.`,
      'Assumes the uplift comes from basket size, not price increases (a price rise is a different scenario).',
    ],
    confidence: 'scenario',
  });

  // Lever 3 — both move together. Splitting the multiplier evenly means each
  // driver grows by sqrt(ratio) - 1, which is materially gentler than asking
  // either one to carry the whole gap.
  const each = Math.sqrt(ratio) - 1;
  options.push({
    id: 'blended',
    lever: 'Both together',
    description: `Grow transactions and average basket by ${pct(each * 100)}% each — usually the most achievable path, since neither driver has to move far.`,
    transactions: { current: transactions, required: ceilUnits(transactions * (1 + each)), changePct: pct(each * 100) },
    basket: { current: round(atv), required: round(atv * (1 + each)), changePct: pct(each * 100) },
    assumptions: [
      'Assumes both drivers can move independently and simultaneously.',
      'Assumes the current product mix is unchanged.',
    ],
    confidence: 'scenario',
  });

  return {
    available: true,
    kind: 'goal_model',
    objective: { metric: 'revenue', target: round(target), reached: false },
    currentState: currentStateBlock(base),
    gap: { absolute: round(gap), pct: pct((gap / revenue) * 100), multiple: round(ratio, 2), direction: 'increase' },
    drivers: ['Transaction volume', 'Average basket value'],
    options,
    assumptions: [
      'All options model the same period this upload covers — not an annualised or forward projection.',
      'None of these account for demand, competition or capacity, which this platform has no data on.',
    ],
    confidence: 'scenario',
    outcomesServed: ['Increase revenue', 'Increase profit'],
    scope: base.scope,
    scopeNote: base.scopeNote,
  };
}

function modelProfitGoal(base, target) {
  const { revenue, profit, marginPct, costCoverage } = base;

  // Profit modeling needs a trustworthy margin. When cost coverage gated it
  // out upstream, say exactly that rather than modeling on a number that was
  // withheld precisely because it could not be trusted.
  if (profit == null || marginPct == null) {
    return missing(
      'A profit goal cannot be modelled because gross profit and margin are not available for the current upload.',
      ['cost prices with enough coverage to trust (at least 20% of rows and 20% of revenue)'],
      {
        costCoverage: costCoverage || null,
        whatWouldFixIt: 'Upload purchase/cost prices for the products in this file, then ask again.',
      }
    );
  }
  if (!(revenue > 0) || !(marginPct > 0)) {
    return missing(
      'Revenue and a positive gross margin are both needed to model a profit goal.',
      ['sales revenue and cost prices']
    );
  }

  const gap = target - profit;
  const marginRate = marginPct / 100;

  if (gap <= 0) {
    return {
      available: true,
      kind: 'goal_model',
      objective: { metric: 'profit', target: round(target), reached: true },
      currentState: currentStateBlock(base),
      gap: { absolute: round(gap), pct: pct((gap / profit) * 100), direction: 'already_met' },
      message: `Current gross profit of ₦${round(profit)} already meets the ₦${round(target)} target.`,
      assumptions: [],
      confidence: 'fact',
      scope: base.scope,
      scopeNote: base.scopeNote,
    };
  }

  const options = [];

  // Lever 1 — sell more at today's margin.
  const reqRevenue = target / marginRate;
  options.push({
    id: 'grow_revenue',
    lever: 'Revenue at current margin',
    description: `Grow revenue from ₦${round(revenue)} to ₦${round(reqRevenue)} while holding gross margin at ${pct(marginPct)}%.`,
    requiredValue: round(reqRevenue),
    currentValue: round(revenue),
    changeAbsolute: round(reqRevenue - revenue),
    changePct: pct(((reqRevenue - revenue) / revenue) * 100),
    assumptions: [
      `Assumes gross margin holds at ${pct(marginPct)}% as volume grows.`,
      'Assumes supplier costs do not rise with the extra volume.',
    ],
    confidence: 'scenario',
  });

  // Lever 2 — same revenue, better margin.
  const reqMarginPct = (target / revenue) * 100;
  options.push({
    id: 'improve_margin',
    lever: 'Gross margin at current revenue',
    description: `Lift gross margin from ${pct(marginPct)}% to ${pct(reqMarginPct)}% on the same ₦${round(revenue)} of revenue — a ${pct(reqMarginPct - marginPct)} percentage-point improvement.`,
    requiredValue: pct(reqMarginPct),
    currentValue: pct(marginPct),
    changePercentagePoints: pct(reqMarginPct - marginPct),
    assumptions: [
      `Assumes revenue holds at ₦${round(revenue)}.`,
      'Margin gains come from buying better, repricing, or shifting mix toward higher-margin lines — this model does not say which is achievable.',
    ],
    confidence: 'scenario',
  });

  // Lever 3 — both.
  const ratio = target / profit;
  const each = Math.sqrt(ratio) - 1;
  options.push({
    id: 'blended',
    lever: 'Both together',
    description: `Grow revenue by ${pct(each * 100)}% and lift margin by ${pct(marginPct * each)} percentage points together.`,
    revenue: { current: round(revenue), required: round(revenue * (1 + each)), changePct: pct(each * 100) },
    margin: { current: pct(marginPct), required: pct(marginPct * (1 + each)), changePercentagePoints: pct(marginPct * each) },
    assumptions: ['Assumes revenue growth and margin improvement can be pursued at the same time.'],
    confidence: 'scenario',
  });

  return {
    available: true,
    kind: 'goal_model',
    objective: { metric: 'profit', target: round(target), reached: false },
    currentState: currentStateBlock(base),
    gap: { absolute: round(gap), pct: pct((gap / profit) * 100), multiple: round(ratio, 2), direction: 'increase' },
    drivers: ['Revenue', 'Gross margin'],
    options,
    assumptions: [
      'All options model the same period this upload covers.',
      `Gross margin of ${pct(marginPct)}% is measured only on rows that carry a cost price.`,
    ],
    confidence: 'scenario',
    outcomesServed: ['Increase profit', 'Improve cash flow'],
    scope: base.scope,
    scopeNote: base.scopeNote,
  };
}

/**
 * Inventory-snapshot planning. No selling has happened, so the only honest
 * baseline is what the stock on hand could return — stated as potential
 * throughout so it can never be mistaken for achieved trading.
 */
function modelGoalFromInventory(base, metric, target) {
  const current = metric === 'revenue' ? base.potentialRevenue : base.potentialProfit;
  const label = metric === 'revenue' ? 'potential revenue' : 'potential gross profit';

  if (current == null) {
    return missing(
      `The current upload is an inventory snapshot, and ${label} cannot be computed from it.`,
      metric === 'profit'
        ? ['purchase/cost price and selling price against current stock']
        : ['selling price and current stock']
    );
  }

  const gap = target - current;
  return {
    available: true,
    kind: 'goal_model',
    basis: 'inventory_snapshot',
    objective: { metric, target: round(target), reached: gap <= 0 },
    currentState: {
      [metric === 'revenue' ? 'potentialRevenue' : 'potentialGrossProfit']: round(current),
      potentialMarginPct: base.potentialMarginPct != null ? pct(base.potentialMarginPct) : null,
      basis: 'Stock on hand valued at recorded selling prices — not sales history.',
      confidence: 'fact',
      source: base.source,
    },
    gap: {
      absolute: round(gap),
      pct: current > 0 ? pct((gap / current) * 100) : null,
      direction: gap <= 0 ? 'already_met' : 'increase',
    },
    interpretation: gap > 0
      ? `Selling the entire current stock at recorded prices would return ₦${round(current)} of ${label}, which is ₦${round(gap)} short of the ₦${round(target)} target. Reaching it needs more stock, higher prices, or a shift toward higher-value lines — this upload has no sales history, so the rate at which that stock actually sells is unknown.`
      : `Selling the entire current stock at recorded prices would return ₦${round(current)} of ${label}, which already covers the ₦${round(target)} target — assuming all of it sells.`,
    assumptions: [
      'Assumes every unit of current stock sells at its recorded selling price.',
      'Assumes no expiry, damage, or markdown losses.',
      'This upload contains no transactions, so sell-through rate and timing are unknown.',
    ],
    confidence: 'scenario',
    outcomesServed: ['Increase revenue', 'Reduce working capital tied up in inventory'],
    scope: base.scope,
    scopeNote: base.scopeNote,
  };
}

function currentStateBlock(base) {
  return {
    revenue: round(base.revenue),
    grossProfit: base.profit != null ? round(base.profit) : null,
    grossMarginPct: base.marginPct != null ? pct(base.marginPct) : null,
    transactions: base.transactions,
    averageTransactionValue: round(base.avgTransactionValue),
    unitsSold: round(base.units),
    periodStart: base.periodStart,
    periodEnd: base.periodEnd,
    periodDays: base.periodDays,
    costCoverage: base.costCoverage || null,
    basis: 'Read from the platform\'s validated analytics — not recomputed here.',
    confidence: 'fact',
    source: base.source,
  };
}

// ---- scenario modeling -----------------------------------------------------

/**
 * Each lever states how it propagates. `revenueFactor` and `costFactor` are
 * how revenue and cost each scale; anything a lever leaves untouched stays
 * explicitly at 1 so the arithmetic is auditable rather than implicit.
 */
const LEVERS = {
  price: {
    label: 'Selling price',
    unit: 'percent',
    revenueFactor: (c) => 1 + c,
    costFactor: () => 1,
    assumptions: (c) => [
      `Assumes unit volume is completely unchanged by a ${pct(c * 100)}% price move — in practice some customers respond to price, and this platform has no elasticity data to model that.`,
      'Assumes purchase costs are unchanged.',
    ],
  },
  volume: {
    label: 'Unit volume',
    unit: 'percent',
    revenueFactor: (c) => 1 + c,
    costFactor: (c) => 1 + c,
    assumptions: (c) => [
      `Assumes selling prices and product mix are unchanged as volume moves ${pct(c * 100)}%.`,
      'Assumes purchase cost per unit is unchanged — no bulk discount or penalty.',
    ],
  },
  transactions: {
    label: 'Transaction count',
    unit: 'percent',
    revenueFactor: (c) => 1 + c,
    costFactor: (c) => 1 + c,
    assumptions: (c) => [
      `Assumes the average basket value is unchanged as transaction count moves ${pct(c * 100)}%.`,
      'Assumes cost of goods scales with the extra volume.',
    ],
  },
  basket: {
    label: 'Average basket value',
    unit: 'percent',
    revenueFactor: (c) => 1 + c,
    costFactor: (c) => 1 + c,
    assumptions: (c) => [
      `Assumes transaction count is unchanged and the ${pct(c * 100)}% uplift comes from more items per basket.`,
      'Assumes those extra items carry the same margin as the current mix.',
    ],
  },
  cost: {
    label: 'Purchase cost',
    unit: 'percent',
    revenueFactor: () => 1,
    costFactor: (c) => 1 + c,
    assumptions: (c) => [
      `Assumes selling prices are held while purchase costs move ${pct(c * 100)}% — the margin change is absorbed, not passed on.`,
      'Assumes unit volume is unchanged.',
    ],
  },
};

/**
 * "What if I raise prices 10%?" / "What happens if sales grow 20%?"
 *
 * Applies one lever to the validated baseline and reports the resulting
 * revenue, profit and margin. Single-lever by design: compounding several
 * speculative changes multiplies the error and produces a number that looks
 * far more precise than it is.
 */
async function modelScenario(organizationId, params = {}) {
  const { lever, changePct, scope = 'current' } = params;

  const def = LEVERS[lever];
  if (!def) {
    return { error: `Unknown lever '${lever}'. Supported: ${Object.keys(LEVERS).join(', ')}.` };
  }
  const changeNum = Number(changePct);
  if (!Number.isFinite(changeNum)) {
    return { error: 'changePct must be a number — the percentage change to apply (e.g. 10 for +10%, -5 for a 5% cut).' };
  }
  if (changeNum <= -100) {
    return { error: 'changePct must be greater than -100 (a -100% change removes the business entirely).' };
  }

  const base = await loadBaseline(organizationId, scope);
  if (base.kind === 'none') {
    if (base.salesGate) return base.salesGate;
    return missing('There is no sales data in the current upload to model a scenario against.', ['sales transactions']);
  }
  if (base.kind === 'inventory') {
    return missing(
      'Scenario modelling needs sales history, and the current upload is an inventory snapshot with no transactions.',
      ['sales transactions'],
      {
        alternative: 'Potential revenue, cost, profit and margin for the stock on hand are available from the inventory tools instead.',
        potentialRevenue: base.potentialRevenue != null ? round(base.potentialRevenue) : null,
        potentialGrossProfit: base.potentialProfit != null ? round(base.potentialProfit) : null,
      }
    );
  }

  const c = changeNum / 100;
  const { revenue, profit, cost, marginPct } = base;

  if (!(revenue > 0)) {
    return missing('Revenue is zero or unavailable in the current upload, so there is nothing to model against.', ['sales revenue']);
  }

  const newRevenue = revenue * def.revenueFactor(c);

  // Profit only moves if cost is known. Where it isn't, report the revenue
  // effect and say plainly that the profit effect is unavailable — never
  // silently treat unknown cost as zero, which would report the entire
  // revenue change as profit.
  let newProfit = null;
  let newMarginPct = null;
  let profitDelta = null;
  const costKnown = cost != null && profit != null && marginPct != null;
  if (costKnown) {
    const newCost = cost * def.costFactor(c);
    newProfit = newRevenue - newCost;
    newMarginPct = newRevenue > 0 ? (newProfit / newRevenue) * 100 : null;
    profitDelta = newProfit - profit;
  }

  return {
    available: true,
    kind: 'scenario_model',
    scenario: {
      lever: def.label,
      leverId: lever,
      changePct: pct(changeNum),
      description: `${def.label} ${changeNum >= 0 ? 'up' : 'down'} ${pct(Math.abs(changeNum))}%`,
    },
    currentState: currentStateBlock(base),
    projected: {
      revenue: round(newRevenue),
      revenueDelta: round(newRevenue - revenue),
      revenueDeltaPct: pct(((newRevenue - revenue) / revenue) * 100),
      grossProfit: newProfit != null ? round(newProfit) : null,
      grossProfitDelta: profitDelta != null ? round(profitDelta) : null,
      grossProfitDeltaPct: costKnown && profit !== 0 ? pct((profitDelta / Math.abs(profit)) * 100) : null,
      grossMarginPct: newMarginPct != null ? pct(newMarginPct) : null,
      grossMarginDeltaPoints: newMarginPct != null ? pct(newMarginPct - marginPct) : null,
      confidence: 'scenario',
    },
    profitEffectAvailable: costKnown,
    profitEffectNote: costKnown
      ? null
      : 'The profit and margin effect cannot be computed because cost prices are missing or too thin to trust in the current upload. Only the revenue effect is modelled here.',
    costCoverage: base.costCoverage || null,
    assumptions: [
      ...def.assumptions(c),
      'Models the same period this upload covers — not an annual figure.',
      'This is a projection, not a measurement.',
    ],
    confidence: 'scenario',
    outcomesServed: lever === 'cost' ? ['Increase profit'] : ['Increase revenue', 'Increase profit'],
    scope: base.scope,
    scopeNote: base.scopeNote,
  };
}

module.exports = { modelGoal, modelScenario, LEVERS, GOAL_METRICS };
