/**
 * AI Advisor — data layer.
 *
 * Every function here takes organizationId as its first argument and is
 * async — Postgres via db.js is promise-based. Every function returns
 * plain data (numbers/strings/arrays) — no prose. The advisor agent is
 * responsible for turning this into an answer, and must never state a
 * number that didn't come from one of these functions.
 */

const { getSql, assertOrgId, queryAnalytics } = require('./db');
const { computeHealthStats } = require('./businessHealthData');
const { scoreBusinessHealth } = require('./businessHealth');
const { generateInsights } = require('./recommendations');
const { profitByCategory, fastSlowMovers } = require('./insights');

const round = (n, d = 2) => {
  if (n == null) return null;
  const m = 10 ** d;
  return Math.round(Number(n) * m) / m;
};

// ── Levenshtein distance — local copy for typo-tolerant product lookup.
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

async function getRevenueProfitSummary(organizationId) {
  const a = await queryAnalytics(organizationId);
  const db = getSql();

  // These totals span EVERY dataset the pharmacy has uploaded, not just the
  // most recent one — that's deliberate (uploads accumulate into sales
  // history), but stating a bare total invites the owner to compare it
  // against the dashboard's KPI cards, which show only the file they just
  // uploaded, and conclude one of them is broken. Return the real coverage
  // so the answer can say what it actually covers.
  const [span] = await db`
    select min(sale_date)::text as "periodStart",
           max(sale_date)::text as "periodEnd",
           count(distinct dataset_id)::int as "datasetCount"
    from sale where organization_id = ${organizationId}
  `;

  const sources = await db`
    select coalesce(d.filename, 'Unknown file') as filename,
           count(*)::int as "transactionCount",
           min(s.sale_date)::text as "from",
           max(s.sale_date)::text as "to"
    from sale s left join dataset_registry d on d.id = s.dataset_id
    where s.organization_id = ${organizationId}
    group by d.filename
    order by count(*) desc
  `;

  return {
    scope: 'All uploaded datasets combined — not a single file.',
    totalRevenue: a.metrics.totalRevenue,
    grossProfit: a.metrics.grossProfit,
    grossMargin: a.metrics.grossMargin,
    totalQuantitySold: a.metrics.totalQuantitySold,
    transactionCount: a.metrics.recordCount,
    averageTransactionValue: a.metrics.averageTransactionValue,
    periodStart: span?.periodStart || null,
    periodEnd: span?.periodEnd || null,
    // Months that CONTAIN data — not necessarily consecutive. Reporting this
    // as "N months of data" overstates coverage when the months are scattered.
    monthsWithData: a.monthlyRevenue.length,
    datasetCount: span?.datasetCount || 0,
    sources,
  };
}

async function getWeeklyRevenue(organizationId, { weeks = 8 } = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select c.year as year, c.week as week,
           min(c.date) as "weekStart", max(c.date) as "weekEnd",
           sum(s.unit_price * s.quantity) as revenue,
           sum((s.unit_price - s.unit_cost) * s.quantity) as profit,
           count(*) as transactions
    from sale s
    join calendar c on s.calendar_id = c.id
    where s.organization_id = ${organizationId}
    group by c.year, c.week
    order by c.year desc, c.week desc
    limit ${weeks}
  `;
  return rows.reverse().map((r) => ({
    year: r.year,
    week: r.week,
    weekStart: r.weekStart,
    weekEnd: r.weekEnd,
    revenue: round(r.revenue),
    profit: r.profit != null ? round(r.profit) : null,
    transactions: Number(r.transactions),
  }));
}

async function getGrowthTrend(organizationId) {
  const a = await queryAnalytics(organizationId);
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

async function getTopProducts(organizationId, { sortBy = 'revenue', n = 10 } = {}) {
  const a = await queryAnalytics(organizationId);
  const key = sortBy === 'profit' ? 'profit' : 'revenue';
  return [...a.topProducts]
    .filter((p) => p[key] != null)
    .sort((x, y) => y[key] - x[key])
    .slice(0, n);
}

async function getCategoryPerformance(organizationId) {
  assertOrgId(organizationId);
  const categories = await profitByCategory(organizationId);

  // profitByCategory correctly returns null profit/margin per category when
  // that category has no cost data — but a model reading a list where every
  // row says profit: null could still read that as "margin data exists and
  // happens to be exactly zero everywhere" rather than "no cost data was
  // uploaded at all." One org-wide flag removes the ambiguity.
  const db = getSql();
  const [costCheck] = await db`
    select count(*) filter (where unit_cost is not null)::int as "withCost"
    from sale where organization_id = ${organizationId}
  `;

  return { hasCostData: (costCheck?.withCost || 0) > 0, categories };
}

async function getSlowMovers(organizationId, { n = 15 } = {}) {
  const items = await fastSlowMovers(organizationId);
  return items.filter((i) => i.classification === 'Slow').slice(0, n);
}

async function getProfitLeakage(organizationId, { marginThreshold = 15, n = 10 } = {}) {
  assertOrgId(organizationId);
  const db = getSql();

  // The query below filters on `unit_cost is not null` to compute real
  // margins. If NO row in this org has cost data at all, that filter alone
  // makes the query return zero rows — identical to "we checked every
  // product and none has a leaky margin." Those are opposite conclusions,
  // so they must be distinguished before running the real query.
  const [costCheck] = await db`
    select count(*) filter (where unit_cost is not null)::int as "withCost"
    from sale where organization_id = ${organizationId}
  `;
  if (!costCheck || costCheck.withCost === 0) {
    return {
      available: false,
      reason: 'No cost-price data uploaded — profit leakage requires cost price, gross profit, or margin data.',
    };
  }

  const rows = await db`
    select p.name, coalesce(p.category, 'Uncategorised') as category,
           sum(s.unit_price * s.quantity) as revenue,
           sum((s.unit_price - s.unit_cost) * s.quantity) as profit,
           case when sum(s.unit_price * s.quantity) > 0
                then round((sum((s.unit_price - s.unit_cost) * s.quantity) / sum(s.unit_price * s.quantity) * 100)::numeric, 2)
                else null end as margin
    from sale s
    join product p on s.product_id = p.id
    where s.organization_id = ${organizationId} and s.unit_cost is not null
    group by p.id, p.name, p.category
    having (case when sum(s.unit_price * s.quantity) > 0
                 then round((sum((s.unit_price - s.unit_cost) * s.quantity) / sum(s.unit_price * s.quantity) * 100)::numeric, 2)
                 else null end) < ${marginThreshold}
    order by revenue desc
    limit ${n}
  `;
  return {
    available: true,
    products: rows.map((r) => ({ ...r, revenue: round(r.revenue), profit: round(r.profit), margin: r.margin != null ? Number(r.margin) : null })),
  };
}

/**
 * Fuzzy product lookup: normalized substring match first, Levenshtein
 * fallback second. Returns { match } | { candidates } | { notFound: true }.
 */
async function findProduct(organizationId, query) {
  assertOrgId(organizationId);
  const db = getSql();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { notFound: true };

  const all = await db`
    select id, name, category, resolved_brand, resolved_generic
    from product
    where organization_id = ${organizationId}
  `;

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

async function getProductProfile(organizationId, { query } = {}) {
  assertOrgId(organizationId);
  const found = await findProduct(organizationId, query);
  if (found.notFound) return { found: false, query };
  if (found.candidates) return { found: false, ambiguous: true, candidates: found.candidates.map((c) => c.name) };

  const db = getSql();
  const product = found.match;

  const [stats] = await db`
    select sum(s.unit_price * s.quantity) as revenue,
           sum(s.quantity) as quantity,
           sum((s.unit_price - s.unit_cost) * s.quantity) as profit,
           avg(s.unit_price) as "avgPrice",
           count(*) as transactions
    from sale s where s.organization_id = ${organizationId} and s.product_id = ${product.id}
  `;

  const [totalRevRow] = await db`
    select sum(unit_price * quantity) as total from sale where organization_id = ${organizationId}
  `;
  const totalRevenue = Number(totalRevRow?.total || 0);

  const [rankRow] = await db`
    select count(*) + 1 as rank from (
      select product_id, sum(unit_price * quantity) as rev from sale
      where organization_id = ${organizationId}
      group by product_id
      having sum(unit_price * quantity) > (
        select sum(unit_price * quantity) from sale where organization_id = ${organizationId} and product_id = ${product.id}
      )
    ) t
  `;

  const monthly = await db`
    select to_char(s.sale_date, 'YYYY-MM') as month, sum(s.unit_price * s.quantity) as revenue, sum(s.quantity) as quantity
    from sale s
    where s.organization_id = ${organizationId} and s.product_id = ${product.id}
    group by month order by month
  `;

  if (!stats || !stats.revenue) {
    return { found: true, product: product.name, category: product.category, noSalesRecorded: true };
  }

  const revenue = Number(stats.revenue);
  const profit = stats.profit != null ? Number(stats.profit) : null;

  return {
    found: true,
    product: product.name,
    category: product.category,
    genericName: product.resolved_generic || null,
    revenue: round(revenue),
    quantitySold: round(stats.quantity),
    profit: profit != null ? round(profit) : null,
    margin: revenue > 0 && profit != null ? round((profit / revenue) * 100) : null,
    averagePrice: round(stats.avgPrice),
    transactions: Number(stats.transactions),
    shareOfTotalRevenuePct: totalRevenue > 0 ? round((revenue / totalRevenue) * 100) : null,
    revenueRank: rankRow?.rank ? Number(rankRow.rank) : null,
    monthlyTrend: monthly.map((m) => ({ month: m.month, revenue: round(m.revenue), quantity: round(m.quantity) })),
  };
}

/**
 * Constant-quantity price simulation. Conservative baseline: assumes
 * quantity sold is unaffected by the price change, and says so.
 */
async function simulatePriceChange(organizationId, { query, priceChangePct } = {}) {
  assertOrgId(organizationId);
  const profile = await getProductProfile(organizationId, { query });
  if (!profile.found) return profile;
  if (profile.noSalesRecorded) return profile;

  const currentPrice = profile.averagePrice;
  const currentQty = profile.quantitySold;
  const newPrice = round(currentPrice * (1 + priceChangePct / 100));
  const projectedProductRevenue = round(newPrice * currentQty);
  const revenueDelta = round(projectedProductRevenue - profile.revenue);

  const db = getSql();
  const [totalRevRow] = await db`
    select sum(unit_price * quantity) as total from sale where organization_id = ${organizationId}
  `;
  const totalRevenue = Number(totalRevRow?.total || 0);
  const overallImpactPct = totalRevenue > 0 ? round((revenueDelta / totalRevenue) * 100) : null;

  const priceHistory = await db`
    select to_char(s.sale_date, 'YYYY-MM') as month, avg(s.unit_price) as "avgPrice", sum(s.quantity) as qty
    from sale s
    join product p on s.product_id = p.id
    where s.organization_id = ${organizationId} and p.organization_id = ${organizationId} and p.name = ${profile.product}
    group by month order by month
  `;

  let historicalElasticitySignal = null;
  const distinctPrices = new Set(priceHistory.map((r) => round(r.avgPrice, 1)));
  if (distinctPrices.size >= 2) {
    const first = priceHistory[0];
    const last = priceHistory[priceHistory.length - 1];
    const firstAvgPrice = Number(first.avgPrice);
    const firstQty = Number(first.qty);
    if (firstAvgPrice > 0 && firstQty > 0) {
      const priceChangeSeen = ((Number(last.avgPrice) - firstAvgPrice) / firstAvgPrice) * 100;
      const qtyChangeSeen = ((Number(last.qty) - firstQty) / firstQty) * 100;
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

async function getTopCustomers(organizationId, { n = 10 } = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select c.name, c.type,
           sum(s.unit_price * s.quantity) as "totalSpend",
           count(*) as transactions
    from sale s
    join customer c on s.customer_id = c.id
    where s.organization_id = ${organizationId} and c.organization_id = ${organizationId}
    group by c.id, c.name, c.type
    order by "totalSpend" desc
    limit ${n}
  `;
  if (rows.length === 0) {
    return { available: false, reason: 'No named-customer data in this dataset (sales are attributed to walk-in only).' };
  }
  return { available: true, customers: rows.map((r) => ({ ...r, totalSpend: round(r.totalSpend), transactions: Number(r.transactions) })) };
}

async function getFrequentlyBoughtTogether(organizationId, { product, n = 10 } = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  let productId = null;
  if (product) {
    const found = await findProduct(organizationId, product);
    if (found.notFound) return { available: false, reason: `No product matching "${product}".` };
    if (found.candidates) return { available: false, ambiguous: true, candidates: found.candidates.map((c) => c.name) };
    productId = found.match.id;
  }

  const [multiLine] = await db`
    select count(*) as cnt from (
      select invoice_ref from sale
      where organization_id = ${organizationId} and invoice_ref is not null and invoice_ref != ''
      group by invoice_ref having count(*) > 1
    ) t
  `;
  if (Number(multiLine.cnt) < 3) {
    return { available: false, reason: 'Not enough multi-item invoices in this dataset to detect real product pairings.' };
  }

  const pairs = productId
    ? await db`
        select p1.name as "productA", p2.name as "productB", count(*) as "timesTogether"
        from sale s1
        join sale s2 on s1.invoice_ref = s2.invoice_ref and s1.product_id < s2.product_id and s1.organization_id = s2.organization_id
        join product p1 on s1.product_id = p1.id
        join product p2 on s2.product_id = p2.id
        where s1.organization_id = ${organizationId}
          and s1.invoice_ref is not null and s1.invoice_ref != ''
          and (s1.product_id = ${productId} or s2.product_id = ${productId})
        group by p1.id, p1.name, p2.id, p2.name
        order by "timesTogether" desc
        limit ${n}
      `
    : await db`
        select p1.name as "productA", p2.name as "productB", count(*) as "timesTogether"
        from sale s1
        join sale s2 on s1.invoice_ref = s2.invoice_ref and s1.product_id < s2.product_id and s1.organization_id = s2.organization_id
        join product p1 on s1.product_id = p1.id
        join product p2 on s2.product_id = p2.id
        where s1.organization_id = ${organizationId}
          and s1.invoice_ref is not null and s1.invoice_ref != ''
        group by p1.id, p1.name, p2.id, p2.name
        order by "timesTogether" desc
        limit ${n}
      `;

  return { available: true, pairs: pairs.map((p) => ({ ...p, timesTogether: Number(p.timesTogether) })) };
}

// ── Inventory / supplier / expiry ─────────────────────────────────────────
//
// These all answer questions about what the pharmacy HAS, which is only
// meaningful relative to a particular upload. Uploads accumulate, so reading
// org-wide (the old behaviour) meant a pharmacy that uploaded inventory data
// once, months ago, kept getting inventory answers forever — even right after
// uploading a sales-only file with no stock columns in it, and with no hint
// that the answer described a different file. Default to the current upload,
// and when it can't answer, say so and offer history rather than silently
// substituting it.

/**
 * Splits the fact store into "what the current upload contains" and "what the
 * organization has ever uploaded", plus which canonical fields each covers.
 * Field detection reuses widgetEngine's own detectAvailableFields, so
 * "does this dataset have stock data" means exactly what it means to the
 * widget that would render it — not a second, drifting definition.
 */
/**
 * Reads a canonical field off a record via the same alias list
 * detectAvailableFields matches on. Without this the two disagree: a dataset
 * whose supplier column is empty but whose `manufacturer` column is full
 * counts as having supplier data (manufacturer is a supplier alias), yet a
 * plain rec.supplier read returns nothing — reporting "0 suppliers" for a
 * dataset that demonstrably has them.
 */
function readField(rec, canonical) {
  const { FIELD_ALIASES } = require('./widgetEngine');
  const direct = rec[canonical];
  if (direct != null && direct !== '') return direct;
  for (const alias of FIELD_ALIASES[canonical] || []) {
    const v = rec[alias];
    if (v != null && v !== '') return v;
  }
  return null;
}

async function getScopedRecords(organizationId, scope = 'current') {
  assertOrgId(organizationId);
  const factStore = require('./factStore');
  const { detectAvailableFields } = require('./widgetEngine');
  const datasetRegistry = require('./datasetRegistry');

  const allRecords = await factStore.queryAll(organizationId);
  const latest = await datasetRegistry.getLatest(organizationId);

  // No registry entry (nothing uploaded through the normal path) — there is
  // no "current upload" to scope to, so org-wide is the only honest answer.
  const currentRecords = latest
    ? allRecords.filter((r) => r.assetId === latest.datasetId)
    : allRecords;

  return {
    allRecords,
    currentRecords,
    records: scope === 'all' ? allRecords : currentRecords,
    currentFields: detectAvailableFields(currentRecords),
    allFields: detectAvailableFields(allRecords),
    currentFilename: latest?.filename || null,
    scope,
  };
}

/**
 * Shared gate: does the requested scope actually carry the fields this
 * question needs? Returns null when it does (caller proceeds), or the
 * caller's whole response when it doesn't.
 */
function checkScopeCoverage(ctx, requiredFields, dataLabel) {
  const has = (fields) => requiredFields.every((f) => fields.has(f));
  if (ctx.scope === 'all') {
    return has(ctx.allFields)
      ? null
      : { available: false, reason: `No ${dataLabel} data has been uploaded in any dataset.` };
  }
  if (has(ctx.currentFields)) return null;
  if (has(ctx.allFields)) {
    return {
      availableInCurrentUpload: false,
      availableHistorically: true,
      currentUpload: ctx.currentFilename,
      reason: `The current upload${ctx.currentFilename ? ` (${ctx.currentFilename})` : ''} does not include ${dataLabel} data. An earlier upload does — ask the user whether to check the organization's historical data before answering from it.`,
    };
  }
  return { available: false, reason: `No ${dataLabel} data has been uploaded in any dataset.` };
}

async function getLowStock(organizationId, { scope = 'current' } = {}) {
  const ctx = await getScopedRecords(organizationId, scope);
  const gap = checkScopeCoverage(ctx, ['current_stock', 'reorder_level'], 'stock-level / reorder-level');
  if (gap) return gap;

  // Count and list come from ONE pass over the same rows, using the same
  // stock <= reorder rule the low-stock-alert widget uses. Previously the
  // count came from a KPI widget and any list came from a different, 20-row
  // capped table widget — which is how "45 low stock" could be followed by a
  // list of 20 and read as a contradiction.
  const products = [];
  let totalWithStock = 0;
  for (const rec of ctx.records) {
    const rawStock = readField(rec, 'current_stock');
    if (rawStock == null) continue;
    const stock = Number(rawStock);
    const reorder = Number(readField(rec, 'reorder_level'));
    if (!Number.isFinite(stock) || stock < 0) continue;
    totalWithStock++;
    if (Number.isFinite(reorder) && reorder >= 0 && stock <= reorder) {
      products.push({
        name: readField(rec, 'product_name') ? String(readField(rec, 'product_name')).trim() : 'Unknown',
        stock,
        reorderLevel: reorder,
      });
    }
  }

  products.sort((a, b) => a.stock - b.stock);
  return {
    estimated: false,
    scope,
    scopeNote: scope === 'all'
      ? 'Covers all uploaded datasets combined.'
      : `Covers the current upload${ctx.currentFilename ? ` (${ctx.currentFilename})` : ''} only.`,
    lowStockCount: products.length,
    totalProductsWithStockData: totalWithStock,
    products,
  };
}

async function getOverstock(organizationId, { scope = 'current' } = {}) {
  const ctx = await getScopedRecords(organizationId, scope);
  const gap = checkScopeCoverage(ctx, ['current_stock'], 'stock-level');
  if (gap) return gap;

  // Overstock needs stock on hand relative to how fast it sells. Quantity
  // sold may not be in the same upload as stock levels, so it's optional
  // here — without it, report stock on hand and say the velocity half is
  // missing rather than inventing a turnover figure.
  const byProduct = new Map();
  for (const rec of ctx.records) {
    const rawStock = readField(rec, 'current_stock');
    if (rawStock == null) continue;
    const stock = Number(rawStock);
    if (!Number.isFinite(stock) || stock < 0) continue;
    const rawName = readField(rec, 'product_name');
    const name = rawName ? String(rawName).trim() : 'Unknown';
    const entry = byProduct.get(name) || { name, stock: 0, unitsSold: 0 };
    entry.stock = Math.max(entry.stock, stock);
    const qty = Number(readField(rec, 'quantity'));
    if (Number.isFinite(qty) && qty > 0) entry.unitsSold += qty;
    byProduct.set(name, entry);
  }

  const parsed = [...byProduct.values()];
  const hasSalesVelocity = parsed.some((p) => p.unitsSold > 0);
  const withCoverage = parsed.map((p) => ({
    name: p.name,
    stock: p.stock,
    unitsSold: p.unitsSold,
    // Stock relative to what actually sold. High ratio = sitting stock.
    stockToSalesRatio: p.unitsSold > 0 ? round(p.stock / p.unitsSold, 2) : null,
  }));

  const overstocked = hasSalesVelocity
    ? withCoverage.filter((p) => p.stockToSalesRatio != null && p.stockToSalesRatio >= 3)
        .sort((a, b) => b.stockToSalesRatio - a.stockToSalesRatio)
    : withCoverage.filter((p) => p.stock > 0).sort((a, b) => b.stock - a.stock);

  return {
    estimated: !hasSalesVelocity,
    scope,
    scopeNote: scope === 'all'
      ? 'Covers all uploaded datasets combined.'
      : `Covers the current upload${ctx.currentFilename ? ` (${ctx.currentFilename})` : ''} only.`,
    ...(hasSalesVelocity
      ? { basis: 'Products holding at least 3x the stock of what actually sold in this data.' }
      : { note: 'This upload has stock levels but no quantity-sold data, so these are simply the largest stock holdings — not confirmed overstock.' }),
    overstockCount: overstocked.length,
    products: overstocked,
  };
}

async function getExpirySummary(organizationId, { scope = 'current' } = {}) {
  const ctx = await getScopedRecords(organizationId, scope);
  const gap = checkScopeCoverage(ctx, ['expiry_date'], 'expiry-date');
  if (gap) return gap;

  const today = new Date();
  const items = [];
  for (const rec of ctx.records) {
    const rawExpiry = readField(rec, 'expiry_date');
    if (!rawExpiry) continue;
    const expiry = new Date(rawExpiry);
    if (Number.isNaN(expiry.getTime())) continue;
    const daysRemaining = Math.floor((expiry - today) / 86400000);
    const rawName = readField(rec, 'product_name');
    const rawStock = readField(rec, 'current_stock');
    items.push({
      name: rawName ? String(rawName).trim() : 'Unknown',
      expiryDate: String(rawExpiry).substring(0, 10),
      daysRemaining,
      stock: rawStock != null && Number.isFinite(Number(rawStock)) ? Number(rawStock) : null,
    });
  }

  items.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return {
    estimated: false,
    scope,
    scopeNote: scope === 'all'
      ? 'Covers all uploaded datasets combined.'
      : `Covers the current upload${ctx.currentFilename ? ` (${ctx.currentFilename})` : ''} only.`,
    expiredCount: items.filter((i) => i.daysRemaining < 0).length,
    expiringWithin90DaysCount: items.filter((i) => i.daysRemaining >= 0 && i.daysRemaining <= 90).length,
    totalWithExpiryData: items.length,
    items,
  };
}

async function getSupplierBreakdown(organizationId, { scope = 'current' } = {}) {
  const ctx = await getScopedRecords(organizationId, scope);
  const gap = checkScopeCoverage(ctx, ['supplier'], 'supplier');
  if (gap) return gap;

  const map = new Map();
  for (const rec of ctx.records) {
    const rawSupplier = readField(rec, 'supplier');
    const supplier = rawSupplier ? String(rawSupplier).trim() : '';
    if (!supplier) continue;
    const entry = map.get(supplier) || { supplier, products: new Set(), stockTotal: 0, unitsSold: 0 };
    const rawName = readField(rec, 'product_name');
    if (rawName) entry.products.add(String(rawName).trim());
    const stock = Number(readField(rec, 'current_stock'));
    if (Number.isFinite(stock) && stock > 0) entry.stockTotal += stock;
    const qty = Number(readField(rec, 'quantity'));
    if (Number.isFinite(qty) && qty > 0) entry.unitsSold += qty;
    map.set(supplier, entry);
  }

  const suppliers = [...map.values()]
    .map((e) => ({ supplier: e.supplier, productCount: e.products.size, stockTotal: e.stockTotal, unitsSold: e.unitsSold }))
    .sort((a, b) => b.productCount - a.productCount);

  return {
    scope,
    scopeNote: scope === 'all'
      ? 'Covers all uploaded datasets combined.'
      : `Covers the current upload${ctx.currentFilename ? ` (${ctx.currentFilename})` : ''} only.`,
    supplierCount: suppliers.length,
    suppliers,
  };
}

// ── Business health / priorities / risks / "why" ────────────────────────

/**
 * Rebuilds the same business-health bundle as GET /api/business-health,
 * as independent code (not by calling or modifying that route/handler).
 */
async function getBusinessHealthBundle(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const analytics = await queryAnalytics(organizationId);
  const { inventoryStats, customerStats } = await computeHealthStats(organizationId);
  const a = analytics.metrics || {};

  const monthlyTxs = await db`
    select to_char(s.sale_date, 'YYYY-MM') as month, count(*) as transactions
    from sale s where s.organization_id = ${organizationId}
    group by month order by month
  `;
  const txMap = {};
  monthlyTxs.forEach((r) => { txMap[r.month] = Number(r.transactions); });
  const months = (analytics.monthlyProfit || analytics.monthlyRevenue || []).map((m) => ({
    month: m.month, revenue: m.revenue || 0, transactions: txMap[m.month] || 0, profit: m.profit ?? null,
  }));

  const [totalDistinctRow] = await db`
    select count(distinct product_id) as cnt from sale where organization_id = ${organizationId}
  `;
  const totalDistinct = Number(totalDistinctRow.cnt);
  const topProducts = (analytics.topProducts || []).map((p) => ({ name: p.name, revenue: p.revenue, margin: p.margin }));

  const allProductRevs = await db`
    select sum(unit_price * quantity) as revenue from sale
    where organization_id = ${organizationId}
    group by product_id order by revenue desc
  `;
  const totalRev = allProductRevs.reduce((s, r) => s + Number(r.revenue || 0), 0);
  const top1 = totalRev > 0 && allProductRevs.length > 0 ? (Number(allProductRevs[0].revenue) / totalRev) * 100 : 0;

  const [totalFactsRow] = await db`select count(*) as cnt from sale where organization_id = ${organizationId}`;
  const totalFacts = Number(totalFactsRow.cnt);
  const [productsWithSalesRow] = await db`
    select count(distinct product_id) as cnt from sale where organization_id = ${organizationId}
  `;
  const productsWithSales = Number(productsWithSalesRow.cnt);
  const [totalProductsRow] = await db`select count(*) as cnt from product where organization_id = ${organizationId}`;
  const totalProducts = Number(totalProductsRow.cnt);

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

  // Weather signal is fully optional — isolated so a fetch/config problem
  // never breaks the advisor (same pattern as index.js's two call sites).
  try {
    const { state } = await require('./pharmacyProfile').get(organizationId);
    if (state) {
      const weatherSignal = await require('./weather/weatherCache').getOrFetch(organizationId, state);
      if (weatherSignal) {
        const demandRules = await require('./weatherDecisionRules').evaluateWeatherDemandRules(organizationId, weatherSignal);
        opts.weatherSignals = { ...weatherSignal, demandRules };
      }
    }
  } catch (weatherErr) {
    console.warn('[advisor] weather signal unavailable:', weatherErr.message);
  }

  // Calendar signal — same read-only, no-external-dependency wiring as the
  // dashboard's two call sites in index.js.
  try {
    opts.calendarSignals = require('./calendar/calendarService').getCalendarSignals(new Date());
  } catch (calendarErr) {
    console.warn('[advisor] calendar signal unavailable:', calendarErr.message);
  }

  const healthResult = scoreBusinessHealth(metrics, opts);
  const insights = generateInsights(healthResult, metrics, opts);
  return {
    health: healthResult,
    insights,
    topPriorities: insights.slice(0, 3),
    weatherSignals: opts.weatherSignals || null,
    calendarSignals: opts.calendarSignals || null,
    externalSignals: opts.externalSignals || null,
  };
}

async function getBusinessHealth(organizationId) {
  const { health } = await getBusinessHealthBundle(organizationId);
  return health;
}

async function getTopPriorities(organizationId, { n = 5 } = {}) {
  const { insights } = await getBusinessHealthBundle(organizationId);
  return insights.slice(0, n);
}

async function getRevenueTrendDrivers(organizationId) {
  const { insights } = await getBusinessHealthBundle(organizationId);
  const driverInsights = insights.filter((i) => i.metric === 'Revenue Growth' || i.pillar === 'Sales Performance');
  if (driverInsights.length === 0) {
    return { available: false, reason: 'No significant revenue swings detected in the current data.' };
  }
  return { available: true, insights: driverInsights };
}

/**
 * Direct weather-outlook lookup — independent of getTopPriorities, which
 * only surfaces weather-driven insights if they happen to rank in the top
 * few.
 */
async function getWeatherOutlook(organizationId) {
  const { state } = await require('./pharmacyProfile').get(organizationId);
  if (!state) {
    return { available: false, reason: 'No pharmacy state set — set it under Settings to enable weather insights.' };
  }

  let weatherSignal;
  try {
    weatherSignal = await require('./weather/weatherCache').getOrFetch(organizationId, state);
  } catch (err) {
    return { available: false, reason: `Weather lookup failed: ${err.message}` };
  }
  if (!weatherSignal) {
    return { available: false, reason: 'Weather data unavailable — the weather provider may not be configured.' };
  }

  const demandRules = await require('./weatherDecisionRules').evaluateWeatherDemandRules(organizationId, weatherSignal);
  return {
    available: true,
    state,
    rainfallRisk: weatherSignal.rainfallRisk,
    humidityRisk: weatherSignal.humidityRisk,
    heatwaveRisk: weatherSignal.heatwaveRisk,
    harmattanRisk: weatherSignal.harmattanRisk,
    coldRisk: weatherSignal.coldRisk,
    qualifyingDemandRules: demandRules.map(({ rule, evidence }) => ({
      weatherSignal: rule.weatherSignal,
      category: rule.category,
      expectedDemand: rule.expectedDemand,
      rationale: rule.rationale,
      confirmedByYourData: evidence.available ? evidence.pctIncrease > 0 : null,
      pctChangeInYourData: evidence.available ? evidence.pctIncrease : null,
    })),
  };
}

/**
 * Ranked business opportunities/risks — combines internal analytics with
 * external intelligence (Weather/Calendar/Disease) via the Decision
 * Intelligence Engine. Structured findings only.
 */
async function getDecisionOpportunities(organizationId) {
  const { generateDecisionOpportunities } = require('./decision/decisionIntelligenceEngine');
  return generateDecisionOpportunities(organizationId);
}

// A recommendation tells the owner to take a specific action, unlike a raw
// DecisionOpportunity (getDecisionOpportunities), which is allowed to surface
// a low-confidence hypothesis as long as it's labeled as one. Below this
// floor there isn't enough support to responsibly tell someone what to do —
// filtered out here rather than left to the model to judge, so the answer
// doesn't depend on the model noticing a low number. Not the same axis as
// decisionIntelligenceEngine.js's PRIORITY_BANDS (that ranks a composite
// priority score); this is a floor on the recommendation's own raw
// `confidence` field specifically.
const MIN_RECOMMENDATION_CONFIDENCE = 0.35;

function splitByConfidence(recommendations) {
  const kept = recommendations.filter((r) => (r.confidence ?? 0) >= MIN_RECOMMENDATION_CONFIDENCE);
  const filteredCount = recommendations.length - kept.length;
  return { kept, filteredCount };
}

/**
 * Concrete, evidence-derived recommended actions — each number traces
 * back to its source DecisionOpportunity's own evidence.
 */
async function getRecommendations(organizationId) {
  const { generateDecisionOpportunities } = require('./decision/decisionIntelligenceEngine');
  const { generateRecommendations } = require('./recommendation/recommendationEngine');
  const opportunities = await generateDecisionOpportunities(organizationId);
  const all = generateRecommendations(opportunities);
  const { kept, filteredCount } = splitByConfidence(all);
  return {
    recommendations: kept,
    ...(filteredCount > 0 ? {
      filteredCount,
      filteredReason: `${filteredCount} additional finding${filteredCount === 1 ? '' : 's'} existed but fell below the minimum confidence to recommend as an action — mention only if asked why so few recommendations appeared.`,
    } : {}),
  };
}

/**
 * The single consolidated executive summary — business health score,
 * overall assessment, key evidence, financial opportunity, and the
 * highest-priority action.
 */
async function getExecutiveBrief(organizationId) {
  const { generateDecisionOpportunities } = require('./decision/decisionIntelligenceEngine');
  const { generateRecommendations } = require('./recommendation/recommendationEngine');
  const { generateExecutiveBrief } = require('./brief/executiveBriefGenerator');
  const opportunities = await generateDecisionOpportunities(organizationId);
  const all = generateRecommendations(opportunities);
  const { kept, filteredCount } = splitByConfidence(all);
  const health = await getBusinessHealth(organizationId);
  const brief = generateExecutiveBrief(opportunities, kept, health);
  return filteredCount > 0
    ? { ...brief, filteredCount, filteredReason: `${filteredCount} additional finding${filteredCount === 1 ? '' : 's'} fell below the minimum confidence to recommend as an action.` }
    : brief;
}

module.exports = {
  getWeatherOutlook,
  getDecisionOpportunities,
  getRecommendations,
  getExecutiveBrief,
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
  getSupplierBreakdown,
  getBusinessHealth,
  getTopPriorities,
  getRevenueTrendDrivers,
  findProduct,
  getBusinessHealthBundle,
};
