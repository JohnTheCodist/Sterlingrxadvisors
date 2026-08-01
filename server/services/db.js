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

/**
 * The same resolution upsertProduct performs, for many products at once.
 *
 * upsertProduct costs two sequential round-trips per product (a SELECT, then
 * an INSERT or UPDATE). That is fine for one product and ruinous for a file:
 * a 6,000-line inventory sheet is mostly *distinct* products, so the per-row
 * path spent ~12,000 round-trips resolving names before a single sale row was
 * written. Over a pooled connection to a hosted database that is measured in
 * tens of minutes, not seconds.
 *
 * This resolves the whole set in three statements per chunk regardless of how
 * many products the chunk holds. The semantics are deliberately identical to
 * upsertProduct, including the two places it treats new and existing rows
 * differently:
 *   - a NEW product falls back to classifyProduct(name) when the file carries
 *     no category, and (as before) does not persist resolved_* identity;
 *   - an EXISTING product keeps every value it already had unless the file
 *     supplies a non-empty replacement, and is never handed the classified
 *     fallback, so re-uploading a file cannot overwrite a real category with
 *     a guessed one.
 *
 * Existing rows are updated through INSERT ... ON CONFLICT DO UPDATE rather
 * than a bare UPDATE: the row is known to exist, so the conflict branch is
 * the one that always runs, and it lets the whole set travel as one statement
 * instead of one per product.
 *
 * @param  {Array<{name: string, attrs: object}>} items — one entry per
 *         product; duplicates by natural key must already be collapsed by the
 *         caller, first occurrence winning, which is what the per-row cache
 *         in loadFactRecords did.
 * @return {Map<string, number>} natural key -> product id, for every input.
 */
async function resolveProductIds(organizationId, items, dbClient = null) {
  assertOrgId(organizationId);
  const db = dbClient || getSql();
  const ids = new Map();
  if (!items || items.length === 0) return ids;

  // Postgres caps a statement at 65,535 bind parameters. The widest statement
  // below carries 21 columns, so 500 rows (10,500 parameters) stays clear of
  // the ceiling with room to spare.
  const CHUNK = 500;

  const norm = (n) => (!n || n === 'Unknown' ? 'Unknown' : n);
  const text = (v) => (v == null || v === '' ? null : v);
  const ingredients = (v) => (Array.isArray(v) ? v.join(', ') : text(v));

  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const keys = chunk.map((it) => computeProductNaturalKey(norm(it.name)));

    const found = await db`
      select id, natural_key from product
      where organization_id = ${organizationId} and natural_key in ${db(keys)}
    `;
    const existing = new Map(found.map((r) => [r.natural_key, r.id]));

    const fresh = [];
    const stale = [];
    chunk.forEach((it, idx) => {
      const key = keys[idx];
      const a = it.attrs || {};
      if (existing.has(key)) {
        ids.set(key, existing.get(key));
        // Mirrors upsertProduct: an existing row is only rewritten when the
        // file actually carries something to write.
        const hasNewAttrs = a.category || a.brand || a.list_price || a.standard_cost || a.launch_date
          || a.resolved_brand || a.resolved_generic || a.resolved_manufacturer;
        if (hasNewAttrs) stale.push({ key, name: norm(it.name), a });
        return;
      }
      // A file can name the same product twice with different spellings that
      // normalize to one key; keep the first, exactly as the old cache did.
      if (!fresh.some((f) => f.key === key)) fresh.push({ key, name: norm(it.name), a });
    });

    if (fresh.length > 0) {
      const rows = fresh.map(({ key, name, a }) => ({
        organization_id: organizationId,
        natural_key: key,
        name,
        category: a.category || classifyProduct(name),
        brand: text(a.brand),
        is_generic: text(a.is_generic),
        pack_size: text(a.pack_size),
        list_price: a.list_price ?? null,
        standard_cost: a.standard_cost ?? null,
        launch_date: text(a.launch_date),
        is_discontinued: text(a.is_discontinued),
        discontinued_date: text(a.discontinued_date),
      }));
      const created = await db`
        insert into product ${db(rows,
          'organization_id', 'natural_key', 'name', 'category', 'brand', 'is_generic',
          'pack_size', 'list_price', 'standard_cost', 'launch_date', 'is_discontinued',
          'discontinued_date')}
        returning id, natural_key
      `;
      for (const r of created) ids.set(r.natural_key, r.id);
    }

    if (stale.length > 0) {
      const rows = stale.map(({ key, name, a }) => ({
        organization_id: organizationId,
        natural_key: key,
        name,
        // Raw, never the classified fallback — see the note above.
        category: text(a.category),
        brand: text(a.brand),
        is_generic: text(a.is_generic),
        pack_size: text(a.pack_size),
        list_price: a.list_price ?? null,
        standard_cost: a.standard_cost ?? null,
        launch_date: text(a.launch_date),
        is_discontinued: text(a.is_discontinued),
        discontinued_date: text(a.discontinued_date),
        resolved_brand: text(a.resolved_brand),
        resolved_generic: text(a.resolved_generic),
        resolved_manufacturer: text(a.resolved_manufacturer),
        resolved_strength: text(a.resolved_strength),
        resolved_form: text(a.resolved_form),
        resolved_nafdac_no: text(a.resolved_nafdac_no),
        resolution_status: text(a.resolution_status),
        clinical_product_id: text(a.clinical_product_id),
        therapeutic_class: text(a.therapeutic_class),
        active_ingredients: ingredients(a.active_ingredients),
        resolution_tier: text(a.resolution_tier),
      }));
      await db`
        insert into product ${db(rows,
          'organization_id', 'natural_key', 'name', 'category', 'brand', 'is_generic',
          'pack_size', 'list_price', 'standard_cost', 'launch_date', 'is_discontinued',
          'discontinued_date', 'resolved_brand', 'resolved_generic', 'resolved_manufacturer',
          'resolved_strength', 'resolved_form', 'resolved_nafdac_no', 'resolution_status',
          'clinical_product_id', 'therapeutic_class', 'active_ingredients', 'resolution_tier')}
        on conflict (organization_id, natural_key) do update set
          category = coalesce(excluded.category, product.category),
          brand = coalesce(excluded.brand, product.brand),
          is_generic = coalesce(excluded.is_generic, product.is_generic),
          pack_size = coalesce(excluded.pack_size, product.pack_size),
          list_price = coalesce(excluded.list_price, product.list_price),
          standard_cost = coalesce(excluded.standard_cost, product.standard_cost),
          launch_date = coalesce(excluded.launch_date, product.launch_date),
          is_discontinued = coalesce(excluded.is_discontinued, product.is_discontinued),
          discontinued_date = coalesce(excluded.discontinued_date, product.discontinued_date),
          resolved_brand = coalesce(excluded.resolved_brand, product.resolved_brand),
          resolved_generic = coalesce(excluded.resolved_generic, product.resolved_generic),
          resolved_manufacturer = coalesce(excluded.resolved_manufacturer, product.resolved_manufacturer),
          resolved_strength = coalesce(excluded.resolved_strength, product.resolved_strength),
          resolved_form = coalesce(excluded.resolved_form, product.resolved_form),
          resolved_nafdac_no = coalesce(excluded.resolved_nafdac_no, product.resolved_nafdac_no),
          resolution_status = coalesce(excluded.resolution_status, product.resolution_status),
          clinical_product_id = coalesce(excluded.clinical_product_id, product.clinical_product_id),
          therapeutic_class = coalesce(excluded.therapeutic_class, product.therapeutic_class),
          active_ingredients = coalesce(excluded.active_ingredients, product.active_ingredients),
          resolution_tier = coalesce(excluded.resolution_tier, product.resolution_tier)
      `;
    }
  }

  return ids;
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

  // One statement per product meant one network round-trip per product, run
  // in sequence — on a file with thousands of distinct products that alone
  // cost more wall-clock time than every other stage of the upload combined.
  // The statement was already an upsert, so batching it changes nothing about
  // what is written, only how many trips it takes to write it.
  //
  // Two rows in ONE insert that collide on the conflict target make Postgres
  // raise "ON CONFLICT DO UPDATE command cannot affect row a second time", so
  // the batch has to be unique by natural key. The per-row loop never hit
  // this: each statement committed before the next one ran, with later values
  // winning wherever they were non-empty. Merging duplicates the same way —
  // later non-empty value wins — keeps that outcome intact. It matters
  // because the key lowercases the name, so "Panadol" and "panadol" arrive as
  // two products and leave as one.
  const merged = new Map();
  for (const p of products) {
    const naturalKey = p.name.toLowerCase().trim();
    const prev = merged.get(naturalKey);
    if (!prev) { merged.set(naturalKey, { ...p, naturalKey }); continue; }
    for (const [k, v] of Object.entries(p)) {
      if (v !== null && v !== undefined && v !== '') prev[k] = v;
    }
  }

  // 12 columns, so 500 rows is 6,000 bind parameters — well inside Postgres's
  // 65,535 ceiling.
  const CHUNK = 500;
  const rows = [...merged.values()].map((p) => ({
    organization_id: organizationId,
    natural_key: p.naturalKey,
    name: p.name,
    category: p.category ?? null,
    brand: p.brand ?? null,
    is_generic: p.is_generic ?? null,
    pack_size: p.pack_size ?? null,
    list_price: p.list_price ?? null,
    standard_cost: p.standard_cost ?? null,
    launch_date: p.launch_date ?? null,
    is_discontinued: p.is_discontinued ?? null,
    discontinued_date: p.discontinued_date ?? null,
  }));

  for (let i = 0; i < rows.length; i += CHUNK) {
    await db`
      insert into product ${db(rows.slice(i, i + CHUNK),
        'organization_id', 'natural_key', 'name', 'category', 'brand', 'is_generic',
        'pack_size', 'list_price', 'standard_cost', 'launch_date', 'is_discontinued',
        'discontinued_date')}
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

/**
 * Remove everything one dataset wrote into the star schema and the fact store.
 *
 * Used when a re-upload is recognised as the same data arriving under a
 * different file: the previous copy has to go, or both are counted and every
 * total is inflated. Scoped to one organization and one dataset — it can never
 * reach another tenant's rows, and never touches a sibling upload.
 *
 * Products are intentionally left alone. They are shared dimension rows that
 * other datasets may still reference, and loadFactRecords already prunes the
 * ones no sale points at.
 */
async function purgeDataset(organizationId, datasetId) {
  assertOrgId(organizationId);
  if (!datasetId) return { sales: 0, facts: 0 };
  const db = getSql();

  const sales = await db`
    delete from sale where organization_id = ${organizationId} and dataset_id = ${datasetId}
    returning 1
  `;
  const facts = await db`
    delete from widget_fact where organization_id = ${organizationId} and dataset_id = ${datasetId}
    returning 1
  `;
  return { sales: sales.length, facts: facts.length };
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

    // Every product in the file is resolved up front, in bulk. The old code
    // resolved them one at a time inside the row loop, which on a file whose
    // rows are mostly distinct products meant two network round-trips per row
    // before any sale row could be written. First occurrence of a natural key
    // wins, which is what the per-row cache did.
    const productOrder = [];
    for (const rec of records) {
      const productName = rec.product_name || rec.product;
      const key = computeProductNaturalKey(productName || 'Unknown');
      if (productCache.has(key)) continue;
      productCache.set(key, null); // placeholder; real id filled in below
      productOrder.push({
        name: productName,
        attrs: {
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
        },
      });
    }
    const productIds = await resolveProductIds(organizationId, productOrder, tx);
    for (const [key] of productCache) productCache.set(key, productIds.get(key) ?? null);

    // Rows are shaped first and sent in batches. The dimension lookups below
    // still run in order, but each one is served from the caches above after
    // its first miss, so they cost round-trips per distinct branch/employee/
    // customer/date rather than per row.
    const pending = [];
    for (const rec of records) {
      const productName = rec.product_name || rec.product;
      const price = rec.selling_price != null ? rec.selling_price : rec.price;
      const qty = rec.quantity;
      const rawCost = rec.cost_price != null ? rec.cost_price : rec.cost;
      const cost = rec._cost_is_total === true && qty > 0 ? rawCost / qty : rawCost;
      const date = rec.transaction_date;

      const productId = productCache.get(computeProductNaturalKey(productName || 'Unknown'));

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

      pending.push({
        organization_id: organizationId,
        dataset_id: datasetId,
        product_id: productId,
        branch_id: branchId,
        employee_id: employeeId,
        customer_id: customerId,
        calendar_id: calendarId,
        sale_date: date.substring(0, 10),
        quantity: qty || 1,
        unit_price: price || 0,
        unit_cost: cost ?? null,
        payment_method: rec.payment_method || null,
        // The normalizer names this field invoice_number; only the sale table
        // calls it invoice_ref. Reading just invoice_ref meant every receipt
        // number a file carried was parsed, mapped, and then silently dropped
        // at the last step — which is why the column was empty everywhere and
        // "transactions" could only ever mean "rows".
        invoice_ref: rec.invoice_ref || rec.invoice_number || null,
      });
    }

    // 13 columns, so 1,000 rows is 13,000 bind parameters — inside Postgres's
    // 65,535 ceiling, and few enough statements that a large file finishes
    // well within the statement timeout set above.
    const SALE_CHUNK = 1000;
    for (let i = 0; i < pending.length; i += SALE_CHUNK) {
      const chunk = pending.slice(i, i + SALE_CHUNK);
      await tx`
        insert into sale ${tx(chunk,
          'organization_id', 'dataset_id', 'product_id', 'branch_id', 'employee_id',
          'customer_id', 'calendar_id', 'sale_date', 'quantity', 'unit_price',
          'unit_cost', 'payment_method', 'invoice_ref')}
      `;
      inserted += chunk.length;
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

// A handful of cost-tagged rows shouldn't produce a confident-looking profit
// or margin — for the org as a whole, for one month, or for one product.
// Same floor and reasoning as analytics.js::profitLeakage,
// insights.js::profitByCategory and advisorQueries.js::getWeeklyRevenue.
const MIN_COST_COVERAGE_PCT = 20;

/**
 * Query analytics from the star schema for one organization.
 * Returns the same JSON shape the dashboard has always expected.
 */
async function queryAnalytics(organizationId, options = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  const { startDate, endDate, branchId, datasetId } = options;

  const dateConds = db`s.organization_id = ${organizationId}`;
  const extra = [];
  if (startDate) extra.push(db`s.sale_date >= ${startDate}`);
  if (endDate) extra.push(db`s.sale_date <= ${endDate}`);
  if (branchId) extra.push(db`s.branch_id = ${branchId}`);
  if (datasetId) extra.push(db`s.dataset_id = ${datasetId}`);
  const whereClause = extra.reduce((acc, cond) => db`${acc} and ${cond}`, dateConds);

  const [metrics] = await db`
    select
      coalesce(sum(s.unit_price * s.quantity), 0) as "totalRevenue",
      coalesce(sum(s.quantity), 0) as "totalQuantitySold",
      coalesce(sum(s.unit_price * s.quantity) / nullif(sum(s.quantity), 0), 0) as "averageSellingPrice",
      sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null) as "grossProfit",
      -- Numerator and denominator MUST share one basis. grossProfit only sums
      -- rows that have a unit_cost, so dividing it by revenue across ALL rows
      -- deflates the margin by exactly the share of revenue lacking cost data
      -- — a business with a real 30% margin on its cost-tagged rows reported
      -- 3% when only a tenth of revenue carried a cost price.
      case when sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null) > 0
           then round((sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null)
             / sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null)) * 100, 2)
           else null end as "grossMargin",
      -- Receipts where the file carried them, rows where it did not — the same
      -- rule analytics.js uses, so the figure means the same thing whether the
      -- dashboard was handed it by an upload or fetched it back afterwards.
      (count(distinct case when nullif(btrim(s.invoice_ref), '') is not null
                           then btrim(s.invoice_ref) || '|' || s.sale_date::text end)
       + count(*) filter (where nullif(btrim(s.invoice_ref), '') is null))::int as "transactionCount",
      coalesce(sum(s.unit_price * s.quantity) / nullif(
        (count(distinct case when nullif(btrim(s.invoice_ref), '') is not null
                             then btrim(s.invoice_ref) || '|' || s.sale_date::text end)
         + count(*) filter (where nullif(btrim(s.invoice_ref), '') is null)), 0), 0) as "averageTransactionValue",
      sum(s.unit_cost * s.quantity) as "totalCost",
      count(*) as "recordCount",
      count(*) filter (where s.unit_cost is not null)::int as "rowsWithCost",
      coalesce(sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null), 0) as "revenueWithCost"
    from sale s
    where ${whereClause}
  `;

  // A handful of cost-tagged rows out of hundreds shouldn't produce a
  // confident-looking margin — grossProfit above is already only summed
  // over rows that HAVE unit_cost, but the revenue it's divided against
  // (grossMargin) and totalRevenue itself cover every row, so partial
  // coverage silently deflates the figure with no disclosure. Require both
  // a minimum share of rows AND of revenue to have cost data before trusting
  // it — same floor and reasoning as analytics.js::profitLeakage.
  const totalRevenueNum = Number(metrics.totalRevenue || 0);
  const revenueWithCostNum = Number(metrics.revenueWithCost || 0);
  const rowsWithCost = Number(metrics.rowsWithCost || 0);
  const totalRows = Number(metrics.recordCount || 0);
  const costCoverageRevenuePct = totalRevenueNum > 0 ? Math.round((revenueWithCostNum / totalRevenueNum) * 1000) / 10 : 0;
  const costCoverageRowsPct = totalRows > 0 ? Math.round((rowsWithCost / totalRows) * 1000) / 10 : 0;
  const hasReliableCostCoverage = costCoverageRowsPct >= MIN_COST_COVERAGE_PCT && costCoverageRevenuePct >= MIN_COST_COVERAGE_PCT;

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
           count(*)::int as "rowCount",
           count(*) filter (where s.unit_cost is not null)::int as "rowsWithCost",
           coalesce(sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null), 0) as "revenueWithCost",
           sum(s.unit_cost * s.quantity) filter (where s.unit_cost is not null) as cost,
           sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null) as profit
    from sale s
    where ${whereClause}
    group by to_char(s.sale_date, 'YYYY-MM')
    order by month
  `;
  // cost/profit cover only cost-known rows while revenue covers every row, so
  // a month whose cost data is sparse would show a real-looking profit beside
  // a much larger revenue — reading as a collapsed margin for that month
  // rather than as missing data. Gate per month on the same floor the
  // org-wide figures use.
  const monthlyProfit = monthlyProfitRaw.map((r) => {
    const revenue = Number(r.revenue) || 0;
    const rowCount = Number(r.rowCount) || 0;
    const rowsWithCost = Number(r.rowsWithCost) || 0;
    const revenueWithCost = Number(r.revenueWithCost) || 0;
    const rowsPct = rowCount > 0 ? Math.round((rowsWithCost / rowCount) * 1000) / 10 : 0;
    const revenuePct = revenue > 0 ? Math.round((revenueWithCost / revenue) * 1000) / 10 : 0;
    const reliable = rowsPct >= MIN_COST_COVERAGE_PCT && revenuePct >= MIN_COST_COVERAGE_PCT;
    return {
      month: r.month,
      revenue: Math.round(revenue * 100) / 100,
      cost: reliable && r.cost != null ? Math.round(Number(r.cost) * 100) / 100 : null,
      profit: reliable && r.profit != null ? Math.round(Number(r.profit) * 100) / 100 : null,
      costCoverage: { hasReliableCostCoverage: reliable, rowsWithCost, rowCount, revenuePct, rowsPct },
    };
  });

  const topProductsRaw = await db`
    select p.name,
           sum(s.unit_price * s.quantity) as revenue,
           sum(s.quantity) as quantity,
           count(*)::int as "rowCount",
           count(*) filter (where s.unit_cost is not null)::int as "rowsWithCost",
           coalesce(sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null), 0) as "revenueWithCost",
           sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null) as profit,
           -- Same shared-basis rule as the org-wide grossMargin: divide
           -- cost-known profit by cost-known revenue, never by all revenue.
           case when sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null) > 0
                then round((sum((s.unit_price - s.unit_cost) * s.quantity) filter (where s.unit_cost is not null)
                  / sum(s.unit_price * s.quantity) filter (where s.unit_cost is not null)) * 100, 2)
                else null end as margin
    from sale s
    join product p on s.product_id = p.id
    where ${whereClause}
    group by p.id, p.name
    order by revenue desc
    limit 100
  `;
  const topProducts = topProductsRaw.map((r) => {
    const revenue = Number(r.revenue) || 0;
    const rowCount = Number(r.rowCount) || 0;
    const rowsWithCost = Number(r.rowsWithCost) || 0;
    const revenueWithCost = Number(r.revenueWithCost) || 0;
    const rowsPct = rowCount > 0 ? Math.round((rowsWithCost / rowCount) * 1000) / 10 : 0;
    const revenuePct = revenue > 0 ? Math.round((revenueWithCost / revenue) * 1000) / 10 : 0;
    const reliable = rowsPct >= MIN_COST_COVERAGE_PCT && revenuePct >= MIN_COST_COVERAGE_PCT;
    return {
      name: r.name,
      revenue: Math.round(revenue * 100) / 100,
      quantity: Math.round(Number(r.quantity) * 100) / 100,
      profit: reliable && r.profit != null ? Math.round(Number(r.profit) * 100) / 100 : null,
      margin: reliable && r.margin != null ? Number(r.margin) : null,
      costCoverage: { hasReliableCostCoverage: reliable, rowsWithCost, rowCount, revenuePct, rowsPct },
    };
  });

  return {
    metrics: {
      totalRevenue: Math.round(Number(metrics.totalRevenue || 0) * 100) / 100,
      totalQuantitySold: Math.round(Number(metrics.totalQuantitySold || 0) * 100) / 100,
      averageSellingPrice: Math.round(Number(metrics.averageSellingPrice || 0) * 100) / 100,
      grossProfit: hasReliableCostCoverage && metrics.grossProfit != null ? Math.round(Number(metrics.grossProfit) * 100) / 100 : null,
      grossMargin: hasReliableCostCoverage && metrics.grossMargin != null ? Number(metrics.grossMargin) : null,
      totalCost: hasReliableCostCoverage && metrics.totalCost != null ? Math.round(Number(metrics.totalCost) * 100) / 100 : null,
      recordCount: Number(metrics.recordCount || 0),
      // recordCount is rows; transactionCount is sales. They differ whenever a
      // file writes one line per item, and the dashboard's "Transactions" KPI
      // reads this one — it was absent here, so the card rendered blank on any
      // dashboard restored from the database rather than handed data by an
      // upload.
      transactionCount: Number(metrics.transactionCount || 0),
      averageTransactionValue: Math.round(Number(metrics.averageTransactionValue || 0) * 100) / 100,
    },
    // Lets callers (getRevenueProfitSummary's evidence-shaping) disclose
    // WHY grossProfit/grossMargin/totalCost came back null when it isn't
    // simply "no cost data at all" — e.g. "cost data covers 8% of revenue,
    // not enough to calculate a reliable margin" vs. "no cost data uploaded."
    costCoverage: {
      hasReliableCostCoverage,
      rowsWithCost,
      totalRows,
      revenuePct: costCoverageRevenuePct,
      rowsPct: costCoverageRowsPct,
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
  resolveProductIds,
  populateProductAttributes,
  upsertBranch,
  upsertEmployee,
  upsertCustomer,
  getCalendarId,
  purgeDataset,
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
