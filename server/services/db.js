/**
 * Postgres-backed (Supabase) star schema for RxNaija Analytics — multi-tenant
 * replacement for the old SQLite-backed database.js.
 *
 * Every table is scoped by organization_id (see supabase/migrations/0001_init.sql).
 * Every exported function here takes organizationId as its first argument and
 * is async — Postgres via the `postgres` package is promise-based, unlike
 * better-sqlite3's synchronous API. Row-Level Security is configured on every
 * table as defense-in-depth, but this module connects with the service_role
 * key (bypasses RLS) — so organizationId filtering in every query here is the
 * real enforcement, not optional.
 *
 * Schema:
 *
 *   product      branch      employee      customer      calendar (shared)
 *       │           │            │             │              │
 *       └───────────┴────────────┴─────────────┴──────────────┘
 *                                │
 *                              sale
 */

const postgres = require('postgres');

let sql = null;

/**
 * The `postgres` package's own connection-string parser mishandles
 * Supavisor's dotted usernames (postgres.<project-ref>) — confirmed via
 * direct testing: it silently drops everything after the first ".",
 * authenticating as "postgres" instead and failing. Node's native URL
 * parser handles it correctly, so decompose the URL ourselves and pass
 * explicit connection params instead of a raw string.
 */
function getSql() {
  if (sql) return sql;
  const url = new URL(process.env.DATABASE_URL);
  sql = postgres({
    host: url.hostname,
    port: Number(url.port) || 5432,
    database: url.pathname.slice(1) || 'postgres',
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: 'require',
  });
  return sql;
}

/**
 * Cheap, greppable safety net — every function below must be given a real
 * organization id. There's no ORM here to enforce this structurally, so
 * fail loudly instead of silently querying with an undefined/null scope.
 */
function assertOrgId(organizationId) {
  if (!organizationId || typeof organizationId !== 'string') {
    throw new Error('assertOrgId: a valid organizationId is required');
  }
}

// ---- dimension lookups --------------------------------------------------

const CATEGORY_RULES = [
  [/paracetamol|pcm/, 'Analgesic'],
  [/ibuprofen|diclofenac|piroxicam/, 'NSAID'],
  [/amoxicillin|ampicillin|augmentin|ciprofloxacin|metronidazole/, 'Antibiotic'],
  [/artemether|lumefantrine|coartem|amodiaquine/, 'Antimalarial'],
  [/vitamin|multivitamin|vit c/, 'Vitamin/Supplement'],
  [/omeprazole|ranitidine/, 'GI'],
  [/metformin|glibenclamide/, 'Antidiabetic'],
];

function classifyProduct(name) {
  const n = name.toLowerCase();
  const hit = CATEGORY_RULES.find(([re]) => re.test(n));
  return hit ? hit[1] : null;
}

/**
 * Builds the internal matching key used to decide "is this the same
 * product I've already seen" — completely separate from the displayed
 * product name, which always stays exactly what the pharmacy typed.
 *
 * Only fixes pure FORMATTING noise, never guesses facts:
 *   - case ("PANADOL" / "Panadol")
 *   - spacing ("Panadol500mg" / "Panadol 500mg" / "Panadol  500mg")
 *   - gram/milligram unit notation ("Augmentin 1g" / "Augmentin 1000mg")
 * It deliberately does NOT touch brand-vs-generic naming (e.g. "Flagyl"
 * vs "Metronidazole") or inject any strength/brand that isn't already in
 * the text — that would be exactly the kind of NAFDAC-driven identity
 * change this was built to avoid. Two products with genuinely different
 * strengths (625mg vs 1g) always stay different; this only collapses
 * different-looking text that represents the identical dose.
 */
function computeProductNaturalKey(name) {
  let key = String(name).toLowerCase().trim();
  // Attach any unit to its number ("500 mg" -> "500mg", "2 g" -> "2g") so
  // spacing before the unit can't split a product. Do this FIRST: the
  // gram conversion below needs "2 g" already joined to see it as a unit.
  key = key.replace(/(\d+(?:\.\d+)?)\s+(mg|g|ml|mcg|iu|l)\b/g, '$1$2');
  // Gram -> milligram, so "1g" and "1000mg" compare equal. No leading \b:
  // real data glues the number onto the brand name ("augmentin1g"). Safe
  // against "500mg" misreads — the "m" sits between the digits and the
  // "g", so this pattern (digits immediately followed by "g") can't match
  // there.
  key = key.replace(/(\d+(?:\.\d+)?)g\b/g, (_, num) => `${Math.round(parseFloat(num) * 1000)}mg`);
  // Split a letter run from a following digit run ("panadol500mg" ->
  // "panadol 500mg"). Digit-into-unit-letters is untouched, so "500mg"
  // never becomes "500 mg".
  key = key.replace(/([a-z])(\d)/g, '$1 $2');
  // Normalize single-letter qualifiers that follow a known vitamin-style
  // word ("vitamin c 1000mg" / "vitaminc1000mg" / "vitamin c1000mg" all
  // converge). Scoped to an explicit prefix rather than any word, because
  // a general "split the last letter off" rule would mangle every product
  // name ("panadol 500mg" -> "panado l500mg") — consistent enough to still
  // match, but wrong and confusing to anyone reading the stored key.
  key = key.replace(/\b(vitamin|vit)\s*([a-z])\s*(?=\d)/g, '$1 $2');
  // Collapse any whitespace run (original double-spaces, or ones just
  // introduced above) down to one, so spacing differences can never be
  // the reason two rows are treated as different products.
  key = key.replace(/\s+/g, ' ').trim();
  return key;
}

/**
 * Look up or create a dimension row, scoped to one organization.
 * Returns the surrogate key id.
 */
async function upsertProduct(organizationId, name, attrs = {}, dbClient = null) {
  assertOrgId(organizationId);
  const db = dbClient || getSql();
  if (!name || name === 'Unknown') name = 'Unknown';
  const naturalKey = computeProductNaturalKey(name);

  const [existing] = await db`
    select id from product where organization_id = ${organizationId} and natural_key = ${naturalKey}
  `;

  if (existing) {
    const hasNewAttrs = attrs.category || attrs.brand || attrs.list_price || attrs.standard_cost || attrs.launch_date
      || attrs.resolved_brand || attrs.resolved_generic || attrs.resolved_manufacturer;
    if (hasNewAttrs) {
      await db`
        update product set
          category = coalesce(nullif(${attrs.category || null}, ''), category),
          brand = coalesce(nullif(${attrs.brand || null}, ''), brand),
          is_generic = coalesce(nullif(${attrs.is_generic || null}, ''), is_generic),
          pack_size = coalesce(nullif(${attrs.pack_size || null}, ''), pack_size),
          list_price = coalesce(${attrs.list_price ?? null}, list_price),
          standard_cost = coalesce(${attrs.standard_cost ?? null}, standard_cost),
          launch_date = coalesce(${attrs.launch_date || null}, launch_date),
          is_discontinued = coalesce(nullif(${attrs.is_discontinued || null}, ''), is_discontinued),
          discontinued_date = coalesce(${attrs.discontinued_date || null}, discontinued_date),
          resolved_brand = coalesce(nullif(${attrs.resolved_brand || null}, ''), resolved_brand),
          resolved_generic = coalesce(nullif(${attrs.resolved_generic || null}, ''), resolved_generic),
          resolved_manufacturer = coalesce(nullif(${attrs.resolved_manufacturer || null}, ''), resolved_manufacturer),
          resolved_strength = coalesce(nullif(${attrs.resolved_strength || null}, ''), resolved_strength),
          resolved_form = coalesce(nullif(${attrs.resolved_form || null}, ''), resolved_form),
          resolved_nafdac_no = coalesce(nullif(${attrs.resolved_nafdac_no || null}, ''), resolved_nafdac_no),
          resolution_status = coalesce(nullif(${attrs.resolution_status || null}, ''), resolution_status),
          clinical_product_id = coalesce(nullif(${attrs.clinical_product_id || null}, ''), clinical_product_id),
          therapeutic_class = coalesce(nullif(${attrs.therapeutic_class || null}, ''), therapeutic_class),
          active_ingredients = coalesce(nullif(${Array.isArray(attrs.active_ingredients) ? attrs.active_ingredients.join(', ') : (attrs.active_ingredients || null)}, ''), active_ingredients),
          resolution_tier = coalesce(nullif(${attrs.resolution_tier || null}, ''), resolution_tier)
        where id = ${existing.id}
      `;
    }
    return existing.id;
  }

  const category = attrs.category || classifyProduct(name);
  const [inserted] = await db`
    insert into product
      (organization_id, natural_key, name, category, brand, is_generic, pack_size, list_price, standard_cost, launch_date, is_discontinued, discontinued_date)
    values (
      ${organizationId}, ${naturalKey}, ${name}, ${category}, ${attrs.brand || null}, ${attrs.is_generic || null},
      ${attrs.pack_size || null}, ${attrs.list_price ?? null}, ${attrs.standard_cost ?? null}, ${attrs.launch_date || null},
      ${attrs.is_discontinued || null}, ${attrs.discontinued_date || null}
    )
    returning id
  `;
  return inserted.id;
}

async function upsertBranch(organizationId, name, location, dbClient = null) {
  assertOrgId(organizationId);
  const db = dbClient || getSql();
  if (!name) name = 'Default Branch';
  const naturalKey = name.toLowerCase().trim();

  const [existing] = await db`
    select id from branch where organization_id = ${organizationId} and natural_key = ${naturalKey}
  `;
  if (existing) return existing.id;

  const [inserted] = await db`
    insert into branch (organization_id, natural_key, name, location)
    values (${organizationId}, ${naturalKey}, ${name}, ${location || null})
    returning id
  `;
  return inserted.id;
}

async function upsertEmployee(organizationId, name, role, branchId, dbClient = null) {
  assertOrgId(organizationId);
  const db = dbClient || getSql();
  if (!name) return null;
  const naturalKey = name.toLowerCase().trim();

  const [existing] = await db`
    select id from employee where organization_id = ${organizationId} and natural_key = ${naturalKey}
  `;
  if (existing) return existing.id;

  const [inserted] = await db`
    insert into employee (organization_id, natural_key, name, role, branch_id)
    values (${organizationId}, ${naturalKey}, ${name}, ${role || null}, ${branchId || null})
    returning id
  `;
  return inserted.id;
}

async function upsertCustomer(organizationId, name, type, hmoCode, dbClient = null) {
  assertOrgId(organizationId);
  const db = dbClient || getSql();
  if (!name) name = 'Walk-in Customer';
  const naturalKey = name.toLowerCase().trim();

  const [existing] = await db`
    select id from customer where organization_id = ${organizationId} and natural_key = ${naturalKey}
  `;
  if (existing) return existing.id;

  const [inserted] = await db`
    insert into customer (organization_id, natural_key, name, type, hmo_code)
    values (${organizationId}, ${naturalKey}, ${name}, ${type || 'walk-in'}, ${hmoCode || null})
    returning id
  `;
  return inserted.id;
}

/**
 * The calendar table is global/shared (not org-scoped) and pre-seeded
 * 2015-01-01 through 2035-12-31 by the migration — no dynamic generation
 * needed for realistic pharmacy transaction dates.
 */
async function getCalendarId(dateStr, dbClient = null) {
  if (!dateStr) return null;
  const db = dbClient || getSql();
  const [row] = await db`select id from calendar where date = ${dateStr.substring(0, 10)}`;
  return row ? row.id : null;
}

// ---- product attribute population ---------------------------------------

/**
 * Bulk-populate product attributes from sheet-joined enrichment columns.
 */
async function populateProductAttributes(organizationId, joinedRows) {
  assertOrgId(organizationId);
  if (!joinedRows || joinedRows.length === 0) return;
  const db = getSql();

  const seen = new Set();
  const products = [];
  for (const row of joinedRows) {
    const name = row['_productName'];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    products.push({
      name,
      category: row['_product_Category'],
      brand: row['_product_Brand'],
      is_generic: row['_product_IsGeneric'],
      pack_size: row['_product_PackSize'],
      list_price: row['_product_ListPriceEUR'] != null ? Number(row['_product_ListPriceEUR']) : null,
      standard_cost: row['_product_StandardCostEUR'] != null ? Number(row['_product_StandardCostEUR']) : null,
      launch_date: row['_product_LaunchDate'] || null,
      is_discontinued: row['_product_IsDiscontinued'],
      discontinued_date: row['_product_DiscontinuedDate'] || null,
    });
  }

  for (const p of products) {
    const naturalKey = p.name.toLowerCase().trim();
    await db`
      insert into product
        (organization_id, natural_key, name, category, brand, is_generic, pack_size, list_price, standard_cost, launch_date, is_discontinued, discontinued_date)
      values (
        ${organizationId}, ${naturalKey}, ${p.name}, ${p.category}, ${p.brand}, ${p.is_generic},
        ${p.pack_size}, ${p.list_price}, ${p.standard_cost}, ${p.launch_date}, ${p.is_discontinued}, ${p.discontinued_date}
      )
      on conflict (organization_id, natural_key) do update set
        category = coalesce(nullif(excluded.category, ''), product.category),
        brand = coalesce(nullif(excluded.brand, ''), product.brand),
        is_generic = coalesce(nullif(excluded.is_generic, ''), product.is_generic),
        pack_size = coalesce(nullif(excluded.pack_size, ''), product.pack_size),
        list_price = coalesce(excluded.list_price, product.list_price),
        standard_cost = coalesce(excluded.standard_cost, product.standard_cost),
        launch_date = coalesce(excluded.launch_date, product.launch_date),
        is_discontinued = coalesce(nullif(excluded.is_discontinued, ''), product.is_discontinued),
        discontinued_date = coalesce(excluded.discontinued_date, product.discontinued_date)
    `;
  }
}

// ---- transaction loading --------------------------------------------------

/**
 * Load normalized records into the star schema for one organization.
 *
 * "Replace" semantics, scoped to the organization (not global — the old
 * single-tenant version wiped ALL fact_sales; here it only ever wipes this
 * org's own sale rows before inserting the new batch, exactly like before
 * but correctly isolated).
 *
 * @param {string} organizationId
 * @param {object[]} records — normalized [{product, quantity, price, cost, date, payment_method, branch, employee, customer}]
 * @param {object} [options]
 * @param {number} [options.branchId] — if provided, only wipe this branch's existing rows instead of the whole org
 * @param {string} [options.datasetId] — the dataset these records came from. Re-loading the
 *   same dataset replaces its own rows instead of duplicating them; other
 *   datasets are untouched. Omit only for callers with no registry entry,
 *   which keeps the old append-everything behaviour.
 * @returns {Promise<number>} rows inserted
 */
async function loadFactRecords(organizationId, records, options = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  const { branchId: targetBranchId, datasetId = null } = options;

  let inserted = 0;

  // Real sales files repeat the same handful of products/branches/employees/
  // customers across hundreds or thousands of rows. Without this cache, every
  // single row re-queries Postgres for entities already resolved earlier in
  // this same batch — over a real network that easily exceeds Supabase's
  // pooler-enforced statement timeout on anything but a tiny file. Keyed by
  // the same natural_key each upsert function already normalizes on.
  const productCache = new Map();
  const branchCache = new Map();
  const employeeCache = new Map();
  const customerCache = new Map();
  const calendarCache = new Map();

  async function cachedCalendarId(date, tx) {
    if (!date) return null;
    const key = date.substring(0, 10);
    if (calendarCache.has(key)) return calendarCache.get(key);
    const id = await getCalendarId(date, tx);
    calendarCache.set(key, id);
    return id;
  }

  async function cachedBranchId(name, location, tx) {
    const key = (name || 'Default Branch').toLowerCase().trim();
    if (branchCache.has(key)) return branchCache.get(key);
    const id = await upsertBranch(organizationId, name, location, tx);
    branchCache.set(key, id);
    return id;
  }

  async function cachedEmployeeId(name, role, branchId, tx) {
    const key = name.toLowerCase().trim();
    if (employeeCache.has(key)) return employeeCache.get(key);
    const id = await upsertEmployee(organizationId, name, role, branchId, tx);
    employeeCache.set(key, id);
    return id;
  }

  async function cachedCustomerId(name, type, hmoCode, tx) {
    const key = (name || 'Walk-in Customer').toLowerCase().trim();
    if (customerCache.has(key)) return customerCache.get(key);
    const id = await upsertCustomer(organizationId, name, type, hmoCode, tx);
    customerCache.set(key, id);
    return id;
  }

  await db.begin(async (tx) => {
    // Startup-packet connection params (postgres.js's `connection` option)
    // are silently ignored by Supabase's Supavisor pooler — confirmed via
    // `SHOW statement_timeout` returning the platform default (2min)
    // regardless of what we requested. SET LOCAL is a real SQL statement
    // sent over the live connection, so the pooler can't drop it, and it
    // auto-reverts at commit/rollback. A full file upload with many rows
    // needs more headroom than a normal query, so extend rather than
    // shorten the platform default here.
    await tx`set local statement_timeout = '180s'`;
    await tx`set local idle_in_transaction_session_timeout = '60s'`;

    let resolvedBranchId = targetBranchId || null;
    if (records.length > 0 && records[0].branch) {
      resolvedBranchId = await cachedBranchId(records[0].branch, records[0].branch_location, tx);
    }
    if (!resolvedBranchId) {
      resolvedBranchId = await cachedBranchId('Default Branch', null, tx);
    }

    // Each upload ADDS to the organization's sales history — it never wipes
    // prior uploads. A pharmacy uploading this week's file shouldn't lose
    // every earlier week's data.
    //
    // But "the same file again" is not "a new week": without this delete,
    // re-processing one file stacked a second copy of its rows on top of the
    // first, inflating every total. Scoped to this dataset only, so other
    // uploads keep accumulating exactly as intended.
    if (datasetId) {
      await tx`delete from sale where organization_id = ${organizationId} and dataset_id = ${datasetId}`;
    }

    for (const rec of records) {
      const productName = rec.product_name || rec.product;
      const price = rec.selling_price != null ? rec.selling_price : rec.price;
      const qty = rec.quantity;
      const rawCost = rec.cost_price != null ? rec.cost_price : rec.cost;
      const cost = rec._cost_is_total === true && qty > 0 ? rawCost / qty : rawCost;
      const date = rec.transaction_date;

      const productKey = computeProductNaturalKey(productName || 'Unknown');
      let productId = productCache.get(productKey);
      if (productId === undefined) {
        productId = await upsertProduct(organizationId, productName, {
          category: rec.category,
          resolved_brand: rec.resolved_brand,
          resolved_generic: rec.resolved_generic,
          resolved_manufacturer: rec.resolved_manufacturer,
          resolved_strength: rec.resolved_strength,
          resolved_form: rec.resolved_form,
          resolved_nafdac_no: rec.resolved_nafdac_no,
          resolution_status: rec.resolution_status,
          clinical_product_id: rec.clinical_product_id,
          therapeutic_class: rec.therapeutic_class,
          active_ingredients: rec.active_ingredients,
          resolution_tier: rec.resolution_tier,
        }, tx);
        productCache.set(productKey, productId);
      }

      const calendarId = await cachedCalendarId(date, tx);
      if (!calendarId) continue;

      const branchId = rec.branch
        ? await cachedBranchId(rec.branch, rec.branch_location, tx)
        : resolvedBranchId;

      const employeeId = rec.employee
        ? await cachedEmployeeId(rec.employee, rec.employee_role, branchId, tx)
        : null;

      const customerId = rec.customer
        ? await cachedCustomerId(rec.customer, rec.customer_type, rec.hmo_code, tx)
        : null;

      await tx`
        insert into sale
          (organization_id, dataset_id, product_id, branch_id, employee_id, customer_id, calendar_id, sale_date, quantity, unit_price, unit_cost, payment_method, invoice_ref)
        values (
          ${organizationId}, ${datasetId}, ${productId}, ${branchId}, ${employeeId}, ${customerId}, ${calendarId}, ${date.substring(0, 10)},
          ${qty || 1}, ${price || 0}, ${cost ?? null}, ${rec.payment_method || null}, ${rec.invoice_ref || null}
        )
      `;
      inserted++;
    }

    // Clean up orphaned product rows for THIS org only — never touches
    // other tenants, and never touches the shared calendar table (it's
    // global and intentionally never pruned).
    await tx`
      delete from product
      where organization_id = ${organizationId}
        and id not in (select distinct product_id from sale where organization_id = ${organizationId})
    `;
  });

  return inserted;
}

// ---- analytics queries ------------------------------------------------

/**
 * Query analytics from the star schema for one organization.
 * Returns the same JSON shape the dashboard has always expected.
 */
async function queryAnalytics(organizationId, options = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  const { startDate, endDate, branchId } = options;

  const dateConds = db`s.organization_id = ${organizationId}`;
  const extra = [];
  if (startDate) extra.push(db`s.sale_date >= ${startDate}`);
  if (endDate) extra.push(db`s.sale_date <= ${endDate}`);
  if (branchId) extra.push(db`s.branch_id = ${branchId}`);
  const whereClause = extra.reduce((acc, cond) => db`${acc} and ${cond}`, dateConds);

  const [metrics] = await db`
    select
      coalesce(sum(s.unit_price * s.quantity), 0) as "totalRevenue",
      coalesce(sum(s.quantity), 0) as "totalQuantitySold",
      coalesce(sum(s.unit_price * s.quantity) / nullif(sum(s.quantity), 0), 0) as "averageSellingPrice",
      sum((s.unit_price - s.unit_cost) * s.quantity) as "grossProfit",
      case when sum(s.unit_price * s.quantity) > 0
           then round((sum((s.unit_price - s.unit_cost) * s.quantity) / sum(s.unit_price * s.quantity)) * 100, 2)
           else null end as "grossMargin",
      coalesce(sum(s.unit_price * s.quantity) / nullif(count(*), 0), 0) as "averageTransactionValue",
      coalesce(sum(s.unit_cost * s.quantity), 0) as "totalCost",
      count(*) as "recordCount"
    from sale s
    where ${whereClause}
  `;

  const monthlyRevenueRaw = await db`
    select to_char(s.sale_date, 'YYYY-MM') as month, sum(s.unit_price * s.quantity) as revenue
    from sale s
    where ${whereClause}
    group by to_char(s.sale_date, 'YYYY-MM')
    order by month
  `;
  const monthlyRevenue = monthlyRevenueRaw.map((r) => ({
    month: r.month,
    revenue: Math.round(Number(r.revenue) * 100) / 100,
  }));

  const monthlyProfitRaw = await db`
    select to_char(s.sale_date, 'YYYY-MM') as month,
           sum(s.unit_price * s.quantity) as revenue,
           sum(s.unit_cost * s.quantity) as cost,
           sum((s.unit_price - s.unit_cost) * s.quantity) as profit
    from sale s
    where ${whereClause}
    group by to_char(s.sale_date, 'YYYY-MM')
    order by month
  `;
  const monthlyProfit = monthlyProfitRaw.map((r) => ({
    month: r.month,
    revenue: Math.round(Number(r.revenue) * 100) / 100,
    cost: r.cost != null ? Math.round(Number(r.cost) * 100) / 100 : null,
    profit: r.profit != null ? Math.round(Number(r.profit) * 100) / 100 : null,
  }));

  const topProductsRaw = await db`
    select p.name,
           sum(s.unit_price * s.quantity) as revenue,
           sum(s.quantity) as quantity,
           sum((s.unit_price - s.unit_cost) * s.quantity) as profit,
           case when sum(s.unit_price * s.quantity) > 0
                then round((sum((s.unit_price - s.unit_cost) * s.quantity) / sum(s.unit_price * s.quantity)) * 100, 2)
                else null end as margin
    from sale s
    join product p on s.product_id = p.id
    where ${whereClause}
    group by p.id, p.name
    order by revenue desc
    limit 10
  `;
  const topProducts = topProductsRaw.map((r) => ({
    name: r.name,
    revenue: Math.round(Number(r.revenue) * 100) / 100,
    quantity: Math.round(Number(r.quantity) * 100) / 100,
    profit: r.profit != null ? Math.round(Number(r.profit) * 100) / 100 : null,
    margin: r.margin != null ? Number(r.margin) : null,
  }));

  return {
    metrics: {
      totalRevenue: Math.round(Number(metrics.totalRevenue || 0) * 100) / 100,
      totalQuantitySold: Math.round(Number(metrics.totalQuantitySold || 0) * 100) / 100,
      averageSellingPrice: Math.round(Number(metrics.averageSellingPrice || 0) * 100) / 100,
      grossProfit: metrics.grossProfit != null ? Math.round(Number(metrics.grossProfit) * 100) / 100 : null,
      grossMargin: metrics.grossMargin != null ? Number(metrics.grossMargin) : null,
      totalCost: Math.round(Number(metrics.totalCost || 0) * 100) / 100,
      recordCount: Number(metrics.recordCount || 0),
      averageTransactionValue: Math.round(Number(metrics.averageTransactionValue || 0) * 100) / 100,
    },
    monthlyRevenue,
    monthlyProfit,
    topProducts,
  };
}

// ---- AI Advisor chat history -----------------------------------------

/**
 * Web dashboard's Advisor conversation, persisted per organization so it
 * survives a page reload — previously it lived only in client React state.
 *
 * Split into bounded conversations (advisor_conversation), not one endless
 * lifetime thread: without a boundary, a question about a fresh upload
 * gets answered using context from an unrelated, older upload's analysis.
 * Exactly one conversation is "active" per organization at a time — that's
 * what a client sees/appends to by default; startNewConversation closes it
 * out and opens a fresh, empty one.
 */
async function getActiveConversationId(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const [existing] = await db`
    select id from advisor_conversation where organization_id = ${organizationId} and is_active = true
  `;
  if (existing) return existing.id;
  const [created] = await db`
    insert into advisor_conversation (organization_id, is_active) values (${organizationId}, true) returning id
  `;
  return created.id;
}

async function startNewConversation(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  return db.begin(async (tx) => {
    await tx`update advisor_conversation set is_active = false where organization_id = ${organizationId} and is_active = true`;
    const [created] = await tx`
      insert into advisor_conversation (organization_id, is_active) values (${organizationId}, true) returning id
    `;
    return created.id;
  });
}

/**
 * Conversation list for the history sidebar.
 *
 * The title is derived on read from the conversation's first user message
 * rather than stored — no column, no migration, and it can never drift out
 * of sync with the thread it labels.
 *
 * Empty conversations are hidden unless they're the active one. A new
 * conversation is opened automatically on every upload, so without this the
 * sidebar would fill with untitled blanks nobody ever typed into.
 */
async function listConversations(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select
      c.id,
      c.is_active,
      c.created_at,
      (select m.content from advisor_message m
        where m.conversation_id = c.id and m.role = 'user'
        order by m.created_at limit 1) as first_user_message,
      (select count(*)::int from advisor_message m where m.conversation_id = c.id) as message_count,
      (select max(m.created_at) from advisor_message m where m.conversation_id = c.id) as last_message_at
    from advisor_conversation c
    where c.organization_id = ${organizationId}
    order by coalesce(
      (select max(m.created_at) from advisor_message m where m.conversation_id = c.id),
      c.created_at
    ) desc
  `;

  return rows
    .filter((r) => r.message_count > 0 || r.is_active)
    .map((r) => ({
      id: r.id,
      title: buildConversationTitle(r.first_user_message),
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at || r.created_at,
      isActive: r.is_active,
    }));
}

function buildConversationTitle(firstUserMessage) {
  if (!firstUserMessage) return 'New conversation';
  const flat = String(firstUserMessage).replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  if (flat.length <= 48) return flat;
  // Prefer a word boundary so titles don't end mid-word.
  const cut = flat.slice(0, 48);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut) + '…';
}

async function getConversationMessages(conversationId, limit = 40) {
  const db = getSql();
  const rows = await db`
    select role, content from advisor_message
    where conversation_id = ${conversationId}
    order by created_at desc
    limit ${limit}
  `;
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

/**
 * Confirms a conversation really belongs to this organization.
 *
 * The history sidebar lets the client name a conversation id, and an id
 * from a request is never trustworthy on its own — without this check a
 * caller could read another pharmacy's advisor thread by guessing a uuid.
 * Returns the id when it checks out, null otherwise.
 */
async function resolveOwnedConversationId(organizationId, conversationId) {
  assertOrgId(organizationId);
  if (!conversationId) return null;
  const db = getSql();
  const [row] = await db`
    select id from advisor_conversation
    where id = ${conversationId} and organization_id = ${organizationId}
  `;
  return row ? row.id : null;
}

async function appendAdvisorMessage(organizationId, conversationId, role, content) {
  assertOrgId(organizationId);
  const db = getSql();
  await db`
    insert into advisor_message (organization_id, conversation_id, role, content)
    values (${organizationId}, ${conversationId}, ${role}, ${content})
  `;
}

// ---- organization membership --------------------------------------------

/**
 * Real membership rows for a verified user — the source of truth
 * requireAuth() cross-checks any client-supplied organization id against.
 * Never trust an organization id from a request header/body directly.
 *
 * Ordered oldest-first, deliberately: requireAuth picks memberships[0] as
 * the active organization, and an unordered query gives Postgres license
 * to return rows in any order it likes. If a user somehow ends up with
 * more than one membership, "which pharmacy am I looking at" must not
 * change between requests — oldest-first means they always land on their
 * original organization, the one holding their real data.
 */
async function getMembershipsForUser(userId) {
  if (!userId) return [];
  const db = getSql();
  return db`
    select om.organization_id, om.role
    from organization_members om
    join organizations o on o.id = om.organization_id
    where om.user_id = ${userId}
    order by o.created_at asc
  `;
}

// ---- maintenance ---------------------------------------------------------

async function closeSql() {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

module.exports = {
  getSql,
  assertOrgId,
  computeProductNaturalKey,
  upsertProduct,
  populateProductAttributes,
  upsertBranch,
  upsertEmployee,
  upsertCustomer,
  getCalendarId,
  loadFactRecords,
  queryAnalytics,
  getActiveConversationId,
  startNewConversation,
  listConversations,
  resolveOwnedConversationId,
  getConversationMessages,
  appendAdvisorMessage,
  getMembershipsForUser,
  closeSql,
};
