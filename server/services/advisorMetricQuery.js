/**
 * AI Advisor — dynamic business-metric query engine.
 *
 * Lets the Advisor answer questions with no dedicated tool by composing a
 * bounded, whitelisted aggregation over the star schema (sale/product/
 * branch/customer/calendar — supabase/migrations/0001_init.sql) instead of
 * declining outright. The LLM only ever selects enum KEYS (measure/groupBy/
 * filter names); every key maps to a hardcoded SQL fragment below, so there
 * is no path from tool input to a raw SQL identifier or fragment.
 * organizationId is always the fixed server-side session value, never taken
 * from tool input — no tenant-isolation risk regardless of what the model
 * requests. Every join double-scopes on organization_id (mirrors
 * getTopCustomers, advisorQueries.js), even though the FK already
 * guarantees it, matching this codebase's defense-in-depth convention.
 *
 * `dim.select`/`measureDef.expr` strings are embedded via db.unsafe() —
 * verified safe here because they are ALWAYS selected from the hardcoded
 * MEASURES/DIMENSIONS objects below, never derived from filters or any
 * other LLM-supplied text. Every actual VALUE (dates, filter text, n) still
 * goes through normal tagged-template parameterization.
 */

const { getSql, assertOrgId } = require('./db');

const round = (n, d = 2) => {
  if (n == null) return null;
  const m = 10 ** d;
  return Math.round(Number(n) * m) / m;
};

// Cost-coverage floor for profit/margin_pct — same threshold and reasoning
// as analytics.js::profitLeakage and db.js::queryAnalytics: a handful of
// cost-tagged rows shouldn't produce a confident-looking figure.
const MIN_COST_COVERAGE_PCT = 20;
// A text filter matching under this share of the org's total rows is
// treated as a likely near-miss (wrong case, singular/plural, typo) rather
// than a genuine zero — the response includes real distinct values so the
// model can self-correct on its next call instead of concluding "you have
// none of that."
const NEAR_MISS_THRESHOLD_PCT = 5;

const MEASURES = {
  revenue: { expr: 'sum(s.unit_price * s.quantity)', label: 'Revenue', format: 'currency', costAware: false },
  quantity: { expr: 'sum(s.quantity)', label: 'Quantity', format: 'number', costAware: false },
  transaction_count: { expr: 'count(*)', label: 'Transaction count', format: 'number', costAware: false },
  average_transaction_value: {
    expr: 'coalesce(sum(s.unit_price * s.quantity) / nullif(count(*), 0), 0)',
    label: 'Average transaction value', format: 'currency', costAware: false,
  },
  distinct_product_count: { expr: 'count(distinct s.product_id)', label: 'Distinct product count', format: 'number', costAware: false },
  distinct_customer_count: { expr: 'count(distinct s.customer_id)', label: 'Distinct customer count', format: 'number', costAware: false },
  profit: {
    expr: 'sum((s.unit_price - s.unit_cost) * s.quantity)',
    label: 'Profit', format: 'currency', costAware: true,
  },
  margin_pct: {
    // Numerator AND denominator both restricted to cost-known rows — a
    // plain profit/revenue division would silently deflate the figure by
    // dividing known profit by ALL revenue (including cost-unknown rows),
    // the exact bug fixed this session in analytics.js and queryAnalytics.
    expr: `case when sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null) > 0
      then round((sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null)
        / sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null)) * 100, 2)
      else null end`,
    label: 'Margin %', format: 'percent', costAware: true,
  },
};

const DIMENSIONS = {
  category: { select: "coalesce(p.category, 'Uncategorized')", label: 'Category' },
  product: { select: 'p.name', label: 'Product' },
  branch: { select: "coalesce(b.name, 'Default Branch')", label: 'Branch' },
  customer_type: { select: "coalesce(c.type, 'walk-in')", label: 'Customer type', nullGuardField: 'rowsWithCustomer' },
  payment_method: { select: "coalesce(s.payment_method, 'Unknown')", label: 'Payment method', nullGuardField: 'rowsWithPaymentMethod' },
  day: { select: "to_char(s.sale_date, 'YYYY-MM-DD')", label: 'Day' },
  week: { select: "cal.year || '-W' || lpad(cal.week::text, 2, '0')", label: 'Week' },
  month: { select: "to_char(s.sale_date, 'YYYY-MM')", label: 'Month' },
  quarter: { select: "cal.year || '-Q' || cal.quarter", label: 'Quarter' },
  day_of_week: { select: 'cal.day_name', label: 'Day of week' },
  is_weekend: { select: "case when cal.is_weekend then 'Weekend' else 'Weekday' end", label: 'Weekend vs weekday' },
};

// Text filters whose values feed the near-miss/zero-match distinct-value
// fallback. `column` is always one of these 5 hardcoded literals — never
// derived from `filters` itself.
const TEXT_FILTERS = {
  category: { column: 'p.category', label: 'category' },
  product: { column: 'p.name', label: 'product name' },
  branch: { column: 'b.name', label: 'branch' },
  paymentMethod: { column: 's.payment_method', label: 'payment method' },
  customerType: { column: 'c.type', label: 'customer type' },
};

// Fixed FROM/JOIN — always joined regardless of which dimension/filter is
// active. Simpler and safer than conditionally composing joins per call;
// all four FK columns are indexed (idx_sale_org_product/branch/customer,
// calendar_id is the PK join), so the extra joins are cheap even when unused.
function fromJoin(db, organizationId) {
  return db`
    from sale s
    left join product p on p.id = s.product_id and p.organization_id = ${organizationId}
    left join branch b on b.id = s.branch_id and b.organization_id = ${organizationId}
    left join customer c on c.id = s.customer_id and c.organization_id = ${organizationId}
    left join calendar cal on cal.id = s.calendar_id
  `;
}

function buildWhereClause(db, organizationId, filters, datasetId) {
  let where = db`s.organization_id = ${organizationId}`;
  if (datasetId) where = db`${where} and s.dataset_id = ${datasetId}`;
  if (filters.dateFrom) where = db`${where} and s.sale_date >= ${filters.dateFrom}`;
  if (filters.dateTo) where = db`${where} and s.sale_date <= ${filters.dateTo}`;
  if (filters.category) where = db`${where} and p.category ilike ${'%' + filters.category + '%'}`;
  if (filters.product) where = db`${where} and p.name ilike ${'%' + filters.product + '%'}`;
  if (filters.branch) where = db`${where} and b.name ilike ${'%' + filters.branch + '%'}`;
  if (filters.paymentMethod) where = db`${where} and s.payment_method ilike ${'%' + filters.paymentMethod + '%'}`;
  if (filters.customerType) where = db`${where} and c.type ilike ${'%' + filters.customerType + '%'}`;
  return where;
}

async function findAvailableValues(db, organizationId, activeTextFilterKeys) {
  const availableValues = {};
  for (const key of activeTextFilterKeys) {
    const { column } = TEXT_FILTERS[key];
    const rows = await db`
      select distinct ${db.unsafe(column)} as value
      ${fromJoin(db, organizationId)}
      where s.organization_id = ${organizationId} and ${db.unsafe(column)} is not null
      order by 1
      limit 15
    `;
    availableValues[key] = rows.map((r) => r.value).filter((v) => v != null && v !== '');
  }
  return availableValues;
}

async function computeItemsPerTransaction(db, organizationId, where, dim, cappedN, scope, scopeNote) {
  const invoiceCountRow = await db`
    select count(*)::int as cnt from (
      select s.invoice_ref
      ${fromJoin(db, organizationId)}
      where ${where} and s.invoice_ref is not null and s.invoice_ref != ''
      group by s.invoice_ref
    ) t
  `;
  if (Number(invoiceCountRow[0]?.cnt || 0) === 0) {
    return { available: false, reason: 'No invoice/transaction-grouping data (invoice_ref) in this dataset — cannot compute items per transaction.' };
  }

  if (!dim) {
    const [row] = await db`
      with basket as (
        select s.invoice_ref, count(*) as items
        ${fromJoin(db, organizationId)}
        where ${where} and s.invoice_ref is not null and s.invoice_ref != ''
        group by s.invoice_ref
      )
      select avg(items) as value, count(*)::int as "invoiceCount" from basket
    `;
    return {
      measure: 'items_per_transaction', groupBy: null, scope, scopeNote,
      value: round(Number(row.value), 2),
      invoiceCount: Number(row.invoiceCount || 0),
    };
  }

  const groupedRows = await db`
    with basket as (
      select s.invoice_ref, ${db.unsafe(dim.select)} as grp, count(*) as items
      ${fromJoin(db, organizationId)}
      where ${where} and s.invoice_ref is not null and s.invoice_ref != ''
      group by s.invoice_ref, grp
    )
    select grp, avg(items) as value, count(*)::int as "invoiceCount"
    from basket
    group by grp
    order by value desc
  `;
  const totalGroups = groupedRows.length;
  const rows = groupedRows.slice(0, cappedN).map((r) => ({
    group: r.grp, value: round(Number(r.value), 2), invoiceCount: Number(r.invoiceCount || 0),
  }));
  return {
    measure: 'items_per_transaction', groupBy: dim.label, scope, scopeNote,
    rows, totalGroups,
    ...(totalGroups > rows.length ? { note: `Showing top ${rows.length} of ${totalGroups} groups, ranked by items per transaction.` } : {}),
  };
}

/**
 * @param {string} organizationId
 * @param {{measure: string, groupBy?: string|null, filters?: object, n?: number}} params
 */
async function computeBusinessMetric(organizationId, params = {}) {
  assertOrgId(organizationId);
  const {
    measure, groupBy = null, filters = {}, n = 20, scope = 'current',
    offset = 0, sortDir = 'desc', minValue = null, maxValue = null,
  } = params;

  // Validate the enums BEFORE touching the database. These messages exist so
  // the model can correct its own call on the next turn, so they must not be
  // reachable only when a connection happens to be available — otherwise a
  // mistyped measure surfaces as whatever the driver failed with instead of
  // the list of measures that would have worked.
  const measureDef = MEASURES[measure];
  if (!measureDef && measure !== 'items_per_transaction') {
    return { error: `Unknown measure '${measure}'. Supported measures: ${[...Object.keys(MEASURES), 'items_per_transaction'].join(', ')}.` };
  }
  const dim = groupBy ? DIMENSIONS[groupBy] : null;
  if (groupBy && !dim) {
    return { error: `Unknown groupBy '${groupBy}'. Supported: ${Object.keys(DIMENSIONS).join(', ')}.` };
  }

  const db = getSql();

  const cappedN = Math.max(1, Math.min(100, Number(n) || 20));
  const cappedOffset = Math.max(0, Number(offset) || 0);
  const dir = String(sortDir).toLowerCase() === 'asc' ? 'asc' : 'desc';

  // "current" means the most recently uploaded file's own sale rows, not a
  // time window — uploads accumulate, so a profit/revenue question about
  // "my data" almost always means the file just given, not the org's whole
  // history. Mirrors advisorQueries.js's getScopedRecords convention for the
  // inventory tools.
  const datasetRegistry = require('./datasetRegistry');
  const latest = scope === 'all' ? null : await datasetRegistry.getLatest(organizationId);
  const datasetId = latest?.datasetId || null;

  const where = buildWhereClause(db, organizationId, filters, datasetId);

  // ---- base pass: shared row/revenue/coverage counts -------------------
  const [base] = await db`
    select
      count(*)::int as "totalRows",
      coalesce(sum(s.unit_price * s.quantity), 0) as "totalRevenue",
      count(*) filter (where s.unit_cost is not null)::int as "rowsWithCost",
      coalesce(sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null), 0) as "revenueWithCost",
      count(*) filter (where s.customer_id is not null)::int as "rowsWithCustomer",
      count(*) filter (where s.payment_method is not null)::int as "rowsWithPaymentMethod"
    ${fromJoin(db, organizationId)}
    where ${where}
  `;
  const totalRows = Number(base.totalRows || 0);

  // ---- current-upload-empty gate ----------------------------------------
  // This upload has no sale rows matching the question at all (e.g. it's an
  // inventory-only file with no transactions) — check whether the
  // organization's history has any before silently answering from a
  // different file than the one just given. Same asymmetry as the
  // inventory tools' checkScopeCoverage: say so and let the model ask,
  // rather than falling back on its own initiative.
  if (datasetId && totalRows === 0) {
    const whereAllData = buildWhereClause(db, organizationId, filters);
    const [allCheck] = await db`select count(*)::int as "totalRows" ${fromJoin(db, organizationId)} where ${whereAllData}`;
    if (Number(allCheck.totalRows || 0) > 0) {
      return {
        availableInCurrentUpload: false,
        availableHistorically: true,
        currentUpload: latest?.filename || null,
        reason: `The current upload${latest?.filename ? ` (${latest.filename})` : ''} has no sales rows matching this question. An earlier upload does — ask the user whether to check the organization's historical data before answering from it.`,
      };
    }
  }

  // ---- zero/near-miss filter self-correction ---------------------------
  const activeTextFilters = Object.keys(TEXT_FILTERS).filter((k) => filters[k]);
  if (activeTextFilters.length > 0) {
    const scopeWhere = datasetId ? db`organization_id = ${organizationId} and dataset_id = ${datasetId}` : db`organization_id = ${organizationId}`;
    const [orgTotal] = await db`select count(*)::int as "totalRows" from sale where ${scopeWhere}`;
    const orgTotalRows = Number(orgTotal.totalRows || 0);
    const matchRatePct = orgTotalRows > 0 ? (totalRows / orgTotalRows) * 100 : 0;
    if (totalRows === 0 || matchRatePct < NEAR_MISS_THRESHOLD_PCT) {
      const availableValues = await findAvailableValues(db, organizationId, activeTextFilters);
      return {
        measure, groupBy, filters,
        rows: [], totalGroups: 0, matchedRows: totalRows,
        note: totalRows === 0
          ? 'No rows matched the given filters — the filter value may not match exactly. See availableValues for the real values on record.'
          : `Only ${totalRows} row(s) matched (${round(matchRatePct, 1)}% of all records) — the filter value may not match exactly. See availableValues for the real values on record.`,
        availableValues,
      };
    }
  }

  if (totalRows === 0) {
    return { available: false, reason: 'No sales rows match the given filters.' };
  }

  if (measure === 'items_per_transaction') {
    const scopeNote = scope === 'all'
      ? 'Covers all uploaded datasets combined.'
      : `Covers the current upload${latest?.filename ? ` (${latest.filename})` : ''} only.`;
    return computeItemsPerTransaction(db, organizationId, where, dim, cappedN, scope, scopeNote);
  }

  // ---- cost-coverage gate (profit / margin_pct only) --------------------
  if (measureDef.costAware) {
    const rowsWithCost = Number(base.rowsWithCost || 0);
    const revenueWithCost = Number(base.revenueWithCost || 0);
    const totalRevenue = Number(base.totalRevenue || 0);
    const rowsPct = totalRows > 0 ? round((rowsWithCost / totalRows) * 100, 1) : 0;
    const revenuePct = totalRevenue > 0 ? round((revenueWithCost / totalRevenue) * 100, 1) : 0;
    if (rowsPct < MIN_COST_COVERAGE_PCT || revenuePct < MIN_COST_COVERAGE_PCT) {
      return {
        available: false,
        reason: `Cost price is only available for ${rowsWithCost} of ${totalRows} matched rows (${revenuePct}% of revenue) — not enough to compute ${measureDef.label.toLowerCase()} reliably.`,
        rowsWithCost, totalRows, revenuePct,
      };
    }
  }

  // ---- null-join guard for optional dimensions ---------------------------
  if (dim && dim.nullGuardField && Number(base[dim.nullGuardField] || 0) === 0) {
    return { available: false, reason: `No ${dim.label.toLowerCase()} data is linked to any matched sale — cannot group by ${dim.label.toLowerCase()}.` };
  }

  const scopeNote = scope === 'all'
    ? 'Covers all uploaded datasets combined.'
    : `Covers the current upload${latest?.filename ? ` (${latest.filename})` : ''} only.`;

  // ---- single total (no groupBy) -----------------------------------------
  if (!dim) {
    const [row] = await db`
      select ${db.unsafe(measureDef.expr)} as value
      ${fromJoin(db, organizationId)}
      where ${where}
    `;
    return { measure, filters, scope, scopeNote, value: row.value != null ? round(Number(row.value), 2) : null, label: measureDef.label };
  }

  // ---- grouped ------------------------------------------------------------
  // Sorted/paged/thresholded in JS rather than SQL: `value` is a computed
  // aggregate, so a LIMIT/OFFSET or HAVING against it would need the whole
  // expression repeated in three places. Group counts are bounded by
  // distinct dimension values (products, categories, weeks), not row count.
  const groupedRows = await db`
    select ${db.unsafe(dim.select)} as grp, ${db.unsafe(measureDef.expr)} as value
    ${fromJoin(db, organizationId)}
    where ${where}
    group by grp
  `;
  let all = groupedRows.map((r) => ({
    group: r.grp, value: r.value != null ? round(Number(r.value), 2) : null,
  }));

  const groupsBeforeThreshold = all.length;
  if (minValue != null) all = all.filter((g) => g.value != null && g.value >= Number(minValue));
  if (maxValue != null) all = all.filter((g) => g.value != null && g.value <= Number(maxValue));

  // Nulls mean "not available", never "lowest" — they sort last either way.
  all.sort((a, b) => {
    if (a.value == null && b.value == null) return 0;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return dir === 'asc' ? a.value - b.value : b.value - a.value;
  });

  const totalGroups = all.length;
  const rows = all.slice(cappedOffset, cappedOffset + cappedN);

  const notes = [];
  if (totalGroups > rows.length) {
    notes.push(`Showing ${rows.length} of ${totalGroups} groups (positions ${cappedOffset + 1}-${cappedOffset + rows.length}), ranked ${dir === 'asc' ? 'lowest' : 'highest'} first by ${measureDef.label.toLowerCase()} — the list is NOT complete.`);
  }
  if ((minValue != null || maxValue != null) && groupsBeforeThreshold > totalGroups) {
    notes.push(`${totalGroups} of ${groupsBeforeThreshold} groups met the value threshold.`);
  }

  return {
    measure, groupBy: dim.label, filters, scope, scopeNote, label: measureDef.label,
    sortDir: dir, offset: cappedOffset,
    rows, totalGroups,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

module.exports = { computeBusinessMetric, MEASURES, DIMENSIONS };
