/**
 * AI Advisor — dynamic metric engine over the CURRENT UPLOAD's own records.
 *
 * Counterpart to advisorMetricQuery.js, which aggregates the star schema
 * (the `sale` table) in SQL. That engine is structurally blind to an
 * inventory upload: loadFactRecords (db.js) skips any row without a
 * transaction date (`if (!calendarId) continue`), so a stock snapshot
 * contributes ZERO rows to `sale`. Its cost/selling/stock columns do reach
 * the fact store, but until now nothing could compute with them — the
 * Advisor could see the fields (getDataFields) yet had no tool to answer
 * "what is my potential profit", so it thrashed and gave up.
 *
 * DIVISION OF RESPONSIBILITY (deliberate — do not blur):
 *   - Sales-transaction measures (revenue, quantity, profit, margin by week/
 *     category/payment method, ...) belong to getBusinessMetric / the star
 *     schema. They stay there.
 *   - STOCK-shaped measures — anything derived from current_stock, or from
 *     cost/selling price as per-unit attributes — belong here.
 * The two stores legitimately hold different row sets (the fact store keeps
 * undated rows the star schema drops), so computing the same named metric in
 * both would let them disagree on one number. One source of truth per
 * number: this engine deliberately does NOT offer sales revenue/quantity.
 *
 * Math notes:
 *   - Ratio measures aggregate numerator and denominator separately, never
 *     an average of per-row ratios (that would weight a 1-unit product the
 *     same as a 1,000-unit one).
 *   - Value measures (potential_*, inventory_value_*) are inherently
 *     stock-weighted. Per-unit measures (unit_margin*) are a simple mean
 *     across rows, which avoids dividing by a zero stock total and reduces
 *     to the exact per-product figure on the usual one-row-per-product file.
 */

const { FIELD_ALIASES } = require('./widgetEngine');

const round = (n, d = 2) => {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const m = 10 ** d;
  return Math.round(Number(n) * m) / m;
};

/**
 * Same alias table detectAvailableFields matches on, so "this dataset has
 * cost data" means the same thing to the availability gate and to the
 * arithmetic. Defined locally rather than imported from advisorQueries to
 * keep the dependency one-way (advisorQueries -> here).
 */
function readField(rec, canonical) {
  const direct = rec[canonical];
  if (direct != null && direct !== '') return direct;
  for (const alias of FIELD_ALIASES[canonical] || []) {
    const v = rec[alias];
    if (v != null && v !== '') return v;
  }
  return null;
}

/** Numeric read — returns null (never 0) when absent or unparseable, so a
 *  missing cost price can never be silently treated as free stock. */
function numField(rec, canonical) {
  const raw = readField(rec, canonical);
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[₦$€£,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Same floor and reasoning as analytics.js::profitLeakage,
// db.js::queryAnalytics and insights.js::profitByCategory — a handful of
// cost-tagged products must not produce a confident-looking margin for a
// whole catalogue.
const MIN_COST_COVERAGE_PCT = 20;

const MEASURES = {
  stock_units: {
    label: 'Units in stock', format: 'number', kind: 'sum', costAware: false,
    requires: ['current_stock'],
    row: (r) => numField(r, 'current_stock'),
  },
  product_count: {
    label: 'Product count', format: 'number', kind: 'distinct', costAware: false,
    requires: ['product_name'],
    key: (r) => {
      const v = readField(r, 'product_name');
      return v ? String(v).trim().toLowerCase() : null;
    },
  },
  inventory_value_at_cost: {
    label: 'Inventory value at cost', format: 'currency', kind: 'sum', costAware: true,
    requires: ['cost_price', 'current_stock'],
    row: (r) => mul(numField(r, 'cost_price'), numField(r, 'current_stock')),
  },
  inventory_value_at_retail: {
    label: 'Inventory value at retail', format: 'currency', kind: 'sum', costAware: false,
    requires: ['selling_price', 'current_stock'],
    row: (r) => mul(numField(r, 'selling_price'), numField(r, 'current_stock')),
  },
  potential_revenue: {
    label: 'Potential revenue', format: 'currency', kind: 'sum', costAware: false,
    requires: ['selling_price', 'current_stock'],
    row: (r) => mul(numField(r, 'selling_price'), numField(r, 'current_stock')),
  },
  potential_cost: {
    label: 'Potential cost', format: 'currency', kind: 'sum', costAware: true,
    requires: ['cost_price', 'current_stock'],
    row: (r) => mul(numField(r, 'cost_price'), numField(r, 'current_stock')),
  },
  potential_gross_profit: {
    label: 'Potential gross profit', format: 'currency', kind: 'sum', costAware: true,
    requires: ['cost_price', 'selling_price', 'current_stock'],
    row: (r) => {
      const sell = numField(r, 'selling_price');
      const cost = numField(r, 'cost_price');
      const stock = numField(r, 'current_stock');
      if (sell == null || cost == null || stock == null) return null;
      return (sell - cost) * stock;
    },
  },
  potential_margin_pct: {
    label: 'Potential margin %', format: 'percent', kind: 'ratio', scale: 100, costAware: true,
    requires: ['cost_price', 'selling_price', 'current_stock'],
    numerator: (r) => {
      const sell = numField(r, 'selling_price');
      const cost = numField(r, 'cost_price');
      const stock = numField(r, 'current_stock');
      if (sell == null || cost == null || stock == null) return null;
      return (sell - cost) * stock;
    },
    denominator: (r) => {
      const sell = numField(r, 'selling_price');
      const cost = numField(r, 'cost_price');
      const stock = numField(r, 'current_stock');
      // Denominator restricted to the SAME rows as the numerator — dividing
      // cost-known profit by all-rows revenue is the deflation bug fixed
      // elsewhere this session.
      if (sell == null || cost == null || stock == null) return null;
      return sell * stock;
    },
  },
  unit_margin: {
    label: 'Margin per unit', format: 'currency', kind: 'mean', costAware: true,
    requires: ['cost_price', 'selling_price'],
    row: (r) => {
      const sell = numField(r, 'selling_price');
      const cost = numField(r, 'cost_price');
      if (sell == null || cost == null) return null;
      return sell - cost;
    },
  },
  unit_margin_pct: {
    label: 'Margin % per unit', format: 'percent', kind: 'mean', costAware: true,
    requires: ['cost_price', 'selling_price'],
    row: (r) => {
      const sell = numField(r, 'selling_price');
      const cost = numField(r, 'cost_price');
      if (sell == null || cost == null || sell === 0) return null;
      return ((sell - cost) / sell) * 100;
    },
  },
};

function mul(a, b) {
  if (a == null || b == null) return null;
  return a * b;
}

const DIMENSIONS = {
  product: { field: 'product_name', label: 'Product' },
  category: { field: 'category', label: 'Category' },
  supplier: { field: 'supplier', label: 'Supplier' },
  branch: { field: 'branch', label: 'Branch' },
  batch_number: { field: 'batch_number', label: 'Batch number' },
};

const TEXT_FILTERS = {
  product: 'product_name',
  category: 'category',
  supplier: 'supplier',
  branch: 'branch',
};

function applyTextFilters(records, filters) {
  let out = records;
  for (const [key, canonical] of Object.entries(TEXT_FILTERS)) {
    const want = filters[key];
    if (!want) continue;
    const needle = String(want).trim().toLowerCase();
    out = out.filter((r) => {
      const v = readField(r, canonical);
      return v != null && String(v).toLowerCase().includes(needle);
    });
  }
  return out;
}

/** Distinct real values on record for a filtered field — lets the model
 *  self-correct a near-miss filter instead of concluding "you have none". */
function distinctValues(records, canonical, limit = 15) {
  const seen = new Set();
  for (const r of records) {
    const v = readField(r, canonical);
    if (v == null || v === '') continue;
    seen.add(String(v).trim());
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/**
 * Aggregate one bucket of rows for a measure. Returns
 * { value, rowsUsed, rowsTotal } — rowsUsed counts rows that actually
 * contributed (i.e. had every field the measure needs).
 */
function aggregate(rows, def) {
  if (def.kind === 'distinct') {
    const seen = new Set();
    for (const r of rows) {
      const k = def.key(r);
      if (k) seen.add(k);
    }
    return { value: seen.size, rowsUsed: seen.size, rowsTotal: rows.length };
  }

  if (def.kind === 'ratio') {
    let num = 0; let den = 0; let used = 0;
    for (const r of rows) {
      const n = def.numerator(r);
      const d = def.denominator(r);
      if (n == null || d == null) continue;
      num += n; den += d; used++;
    }
    if (used === 0 || den === 0) return { value: null, rowsUsed: used, rowsTotal: rows.length };
    return { value: (num / den) * (def.scale || 1), rowsUsed: used, rowsTotal: rows.length };
  }

  let total = 0; let used = 0;
  for (const r of rows) {
    const v = def.row(r);
    if (v == null) continue;
    total += v; used++;
  }
  if (used === 0) return { value: null, rowsUsed: 0, rowsTotal: rows.length };
  return {
    value: def.kind === 'mean' ? total / used : total,
    rowsUsed: used,
    rowsTotal: rows.length,
  };
}

/**
 * Cost coverage for a cost-aware measure: of the rows that carry the
 * measure's NON-cost requirements, how many also carry a cost price — plus
 * the retail-value share those rows represent. Both must clear the floor,
 * so neither a few high-value nor a long tail of low-value products alone
 * can pass.
 */
function costCoverage(rows) {
  let base = 0; let withCost = 0;
  let baseValue = 0; let withCostValue = 0;
  for (const r of rows) {
    const sell = numField(r, 'selling_price');
    const stock = numField(r, 'current_stock');
    const cost = numField(r, 'cost_price');
    const rowValue = sell != null && stock != null ? sell * stock : null;
    base++;
    if (rowValue != null) baseValue += rowValue;
    if (cost != null) {
      withCost++;
      if (rowValue != null) withCostValue += rowValue;
    }
  }
  const rowsPct = base > 0 ? round((withCost / base) * 100, 1) : 0;
  const valuePct = baseValue > 0 ? round((withCostValue / baseValue) * 100, 1) : 0;
  return {
    rowsWithCost: withCost,
    totalRows: base,
    rowsPct,
    valuePct,
    hasReliableCostCoverage: rowsPct >= MIN_COST_COVERAGE_PCT
      && (baseValue === 0 ? true : valuePct >= MIN_COST_COVERAGE_PCT),
  };
}

/**
 * The four figures that answer "what is my potential profit" in one call.
 * Returned alongside any potential or inventory-value measure so the model
 * doesn't need four round trips (MAX_TOOL_ITERATIONS is 5) and so the parts
 * are guaranteed internally consistent with each other.
 */
function relatedFigures(rows, availableFields) {
  const has = (f) => availableFields.has(f);
  if (!has('current_stock') || !has('selling_price')) return null;
  const out = {
    potentialRevenue: round(aggregate(rows, MEASURES.potential_revenue).value),
  };
  if (has('cost_price')) {
    const cov = costCoverage(rows);
    if (cov.hasReliableCostCoverage) {
      out.potentialCost = round(aggregate(rows, MEASURES.potential_cost).value);
      out.potentialGrossProfit = round(aggregate(rows, MEASURES.potential_gross_profit).value);
      out.potentialMarginPct = round(aggregate(rows, MEASURES.potential_margin_pct).value);
    } else {
      out.potentialCost = null;
      out.potentialGrossProfit = null;
      out.potentialMarginPct = null;
      out.costFiguresUnavailableReason = `Cost price covers only ${cov.rowsWithCost} of ${cov.totalRows} rows (${cov.valuePct}% of retail value) — too thin to report cost, profit or margin reliably.`;
    }
  }
  return out;
}

/**
 * @param {{records: object[], fields: Set<string>, currentFilename: string|null, scope: string}} ctx
 *   Scoped records + detected fields, resolved by advisorQueries.getScopedRecords
 *   so this engine inherits the current-upload-by-default discipline.
 * @param {{measure: string, groupBy?: string|null, filters?: object,
 *          n?: number, offset?: number, sortDir?: string,
 *          minValue?: number, maxValue?: number}} params
 */
function computeDatasetMetric(ctx, params = {}) {
  const {
    measure, groupBy = null, filters = {},
    n = 20, offset = 0, sortDir = 'desc',
    minValue = null, maxValue = null,
  } = params;

  const def = MEASURES[measure];
  if (!def) {
    return { error: `Unknown measure '${measure}'. Supported: ${Object.keys(MEASURES).join(', ')}.` };
  }

  // A value threshold only means something per group ("products below 15%
  // margin"). Default the grouping to product rather than erroring, and say
  // so — an extra round trip is worse than a disclosed sensible default.
  let effectiveGroupBy = groupBy;
  let autoGrouped = false;
  if (!effectiveGroupBy && (minValue != null || maxValue != null)) {
    effectiveGroupBy = 'product';
    autoGrouped = true;
  }

  const dim = effectiveGroupBy ? DIMENSIONS[effectiveGroupBy] : null;
  if (effectiveGroupBy && !dim) {
    return { error: `Unknown groupBy '${effectiveGroupBy}'. Supported: ${Object.keys(DIMENSIONS).join(', ')}.` };
  }

  const scopeNote = ctx.scope === 'all'
    ? 'Covers all uploaded datasets combined.'
    : `Covers the current upload${ctx.currentFilename ? ` (${ctx.currentFilename})` : ''} only.`;

  // ---- filters, with near-miss self-correction --------------------------
  const activeTextFilters = Object.keys(TEXT_FILTERS).filter((k) => filters[k]);
  const rows = applyTextFilters(ctx.records, filters);
  if (rows.length === 0) {
    if (activeTextFilters.length > 0) {
      const availableValues = {};
      for (const k of activeTextFilters) {
        availableValues[k] = distinctValues(ctx.records, TEXT_FILTERS[k]);
      }
      return {
        measure, groupBy: effectiveGroupBy, filters, scope: ctx.scope, scopeNote,
        rows: [], totalMatching: 0,
        note: 'No records matched the given filters — the filter value may not match exactly. See availableValues for the real values on record.',
        availableValues,
      };
    }
    return { available: false, reason: 'No records in this upload.' };
  }

  // ---- cost-coverage gate ----------------------------------------------
  const coverage = def.costAware ? costCoverage(rows) : null;
  if (coverage && !coverage.hasReliableCostCoverage) {
    return {
      available: false,
      scope: ctx.scope,
      scopeNote,
      reason: `Cost price is available for only ${coverage.rowsWithCost} of ${coverage.totalRows} matched records (${coverage.valuePct}% of retail value) — not enough to compute ${def.label.toLowerCase()} reliably.`,
      costCoverage: coverage,
    };
  }

  const dir = String(sortDir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const cappedN = Math.max(1, Math.min(200, Number(n) || 20));
  const cappedOffset = Math.max(0, Number(offset) || 0);

  // ---- single total ----------------------------------------------------
  if (!dim) {
    const agg = aggregate(rows, def);
    if (agg.value == null) {
      return {
        available: false, scope: ctx.scope, scopeNote,
        reason: `No records carry every field ${def.label.toLowerCase()} needs (${def.requires.join(', ')}).`,
      };
    }
    const related = relatedFigures(rows, ctx.fields);
    return {
      measure, label: def.label, format: def.format, filters,
      scope: ctx.scope, scopeNote,
      value: round(agg.value),
      recordsUsed: agg.rowsUsed,
      recordsMatched: rows.length,
      ...(coverage ? { costCoverage: coverage } : {}),
      ...(related ? { relatedFigures: related } : {}),
    };
  }

  // ---- grouped ---------------------------------------------------------
  const buckets = new Map();
  for (const r of rows) {
    const raw = readField(r, dim.field);
    const key = raw != null && String(raw).trim() !== '' ? String(raw).trim() : 'Unspecified';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }

  let grouped = [];
  for (const [key, bucketRows] of buckets) {
    const agg = aggregate(bucketRows, def);
    // Per-group cost discipline mirrors insights.js::profitByCategory: a
    // group whose own cost coverage is too thin reports null, not a
    // specific-looking figure derived from one or two of its rows.
    let value = agg.value;
    let groupCoverage = null;
    if (def.costAware) {
      groupCoverage = costCoverage(bucketRows);
      if (!groupCoverage.hasReliableCostCoverage) value = null;
    }
    grouped.push({
      group: key,
      value: value != null ? round(value) : null,
      recordsUsed: agg.rowsUsed,
      recordsInGroup: bucketRows.length,
      ...(groupCoverage && value == null
        ? { valueUnavailableReason: `Cost price covers only ${groupCoverage.rowsWithCost} of ${groupCoverage.totalRows} records in this group.` }
        : {}),
    });
  }

  const groupsBeforeThreshold = grouped.length;
  if (minValue != null) grouped = grouped.filter((g) => g.value != null && g.value >= Number(minValue));
  if (maxValue != null) grouped = grouped.filter((g) => g.value != null && g.value <= Number(maxValue));

  // Nulls (unavailable, not zero) always sort last regardless of direction —
  // they are missing evidence, not the smallest value.
  grouped.sort((a, b) => {
    if (a.value == null && b.value == null) return 0;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return dir === 'asc' ? a.value - b.value : b.value - a.value;
  });

  const totalMatching = grouped.length;
  const page = grouped.slice(cappedOffset, cappedOffset + cappedN);

  const notes = [];
  if (autoGrouped) notes.push("Grouped by product because a value threshold was given (a threshold applies to groups, not to one overall total).");
  if (totalMatching > page.length) {
    notes.push(`Showing ${page.length} of ${totalMatching} groups (positions ${cappedOffset + 1}-${cappedOffset + page.length}), ranked ${dir === 'asc' ? 'lowest' : 'highest'} first — the list is NOT complete.`);
  }
  if ((minValue != null || maxValue != null) && groupsBeforeThreshold > totalMatching) {
    notes.push(`${totalMatching} of ${groupsBeforeThreshold} groups met the value threshold.`);
  }

  return {
    measure, label: def.label, format: def.format, groupBy: dim.label, filters,
    scope: ctx.scope, scopeNote,
    sortDir: dir,
    rows: page,
    totalMatching,
    offset: cappedOffset,
    ...(coverage ? { costCoverage: coverage } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

module.exports = { computeDatasetMetric, MEASURES, DIMENSIONS, MIN_COST_COVERAGE_PCT };
