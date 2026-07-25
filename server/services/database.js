/**
 * SQLite-backed star schema for RxNaija Analytics.
 *
 * Schema:
 *
 *   DimProduct      DimBranch      DimEmployee      DimCustomer      DimCalendar
 *       │               │               │               │               │
 *       └───────────────┴───────────────┴───────────────┴───────────────┘
 *                                       │
 *                                    FactSales
 *
 * Every dimension has:
 *   - id (INTEGER PRIMARY KEY) — surrogate key
 *   - natural_key (TEXT) — business key for upsert dedup
 *   - Additional attribute columns
 *
 * FactSales has foreign keys to all dimensions.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'rxnaija.db');

let db = null;

// ---- schema ------------------------------------------------------------

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dim_product (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_key     TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  category        TEXT,
  brand           TEXT,
  is_generic      TEXT    DEFAULT 'No',
  pack_size       TEXT,
  list_price      REAL,
  standard_cost   REAL,
  launch_date     TEXT,
  is_discontinued TEXT    DEFAULT 'No',
  discontinued_date TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Resolved identity (NAFDAC enrichment, added in Phase 2)
  resolved_brand           TEXT,
  resolved_generic         TEXT,
  resolved_manufacturer    TEXT,
  resolved_strength        TEXT,
  resolved_form            TEXT,
  resolved_nafdac_no       TEXT,
  resolution_status        TEXT
);

CREATE TABLE IF NOT EXISTS dim_branch (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_key TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  location    TEXT,
  pharmacy_id TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dim_employee (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_key TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  role        TEXT,
  branch_id   INTEGER REFERENCES dim_branch(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dim_customer (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_key TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  type        TEXT    CHECK(type IN ('walk-in','hmo','corporate','nhis','family')),
  hmo_code    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dim_calendar (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT    NOT NULL UNIQUE,
  year          INTEGER NOT NULL,
  quarter       INTEGER NOT NULL CHECK(quarter BETWEEN 1 AND 4),
  month         INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  week          INTEGER NOT NULL CHECK(week BETWEEN 1 AND 53),
  day           INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31),
  day_of_week   INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  month_name    TEXT    NOT NULL,
  day_name      TEXT    NOT NULL,
  is_weekend    INTEGER NOT NULL DEFAULT 0,
  is_holiday    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fact_sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES dim_product(id),
  branch_id       INTEGER DEFAULT 1  REFERENCES dim_branch(id),
  employee_id     INTEGER            REFERENCES dim_employee(id),
  customer_id     INTEGER DEFAULT 1  REFERENCES dim_customer(id),
  calendar_id     INTEGER NOT NULL REFERENCES dim_calendar(id),
  quantity        REAL    NOT NULL DEFAULT 1,
  unit_price      REAL    NOT NULL DEFAULT 0,
  unit_cost       REAL,
  payment_method  TEXT    CHECK(payment_method IN ('Cash','Transfer','POS','Insurance','Credit')),
  invoice_ref     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_fact_sales_calendar  ON fact_sales(calendar_id);
CREATE INDEX IF NOT EXISTS idx_fact_sales_product   ON fact_sales(product_id);
CREATE INDEX IF NOT EXISTS idx_fact_sales_branch    ON fact_sales(branch_id);
CREATE INDEX IF NOT EXISTS idx_fact_sales_employee  ON fact_sales(employee_id);
CREATE INDEX IF NOT EXISTS idx_fact_sales_customer  ON fact_sales(customer_id);
`;

// ---- init ------------------------------------------------------------

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  ensureDefaults();
  return db;
}

/**
 * Run additive migrations — add columns that may not exist in older databases.
 * Uses ALTER TABLE IF NOT EXISTS pattern (SQLite doesn't support IF NOT EXISTS
 * for ALTER, so we check pragma table_info first).
 */
function runMigrations(database) {
  const addColumnIfMissing = (table, column, type) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  };

  // Phase 2: resolved identity columns (dual identity — enrichment only)
  addColumnIfMissing('dim_product', 'resolved_brand', 'TEXT');
  addColumnIfMissing('dim_product', 'resolved_generic', 'TEXT');
  addColumnIfMissing('dim_product', 'resolved_manufacturer', 'TEXT');
  addColumnIfMissing('dim_product', 'resolved_strength', 'TEXT');
  addColumnIfMissing('dim_product', 'resolved_form', 'TEXT');
  addColumnIfMissing('dim_product', 'resolved_nafdac_no', 'TEXT');
  addColumnIfMissing('dim_product', 'resolution_status', 'TEXT');
  // Layer 3: clinical identity columns
  addColumnIfMissing('dim_product', 'clinical_product_id', 'TEXT');
  addColumnIfMissing('dim_product', 'therapeutic_class', 'TEXT');
  addColumnIfMissing('dim_product', 'active_ingredients', 'TEXT');
  addColumnIfMissing('dim_product', 'resolution_tier', 'TEXT');
}

function ensureDefaults() {
  // Ensure default rows exist so FKs never fail
  const stmts = [
    `INSERT OR IGNORE INTO dim_branch    (id, natural_key, name) VALUES (1, 'default', 'Default Branch')`,
    `INSERT OR IGNORE INTO dim_customer  (id, natural_key, name, type) VALUES (1, 'walk-in', 'Walk-in Customer', 'walk-in')`,
  ];
  for (const sql of stmts) {
    db.prepare(sql).run();
  }
}

// ---- calendar generation ----------------------------------------------

/**
 * Populate dim_calendar for a given date range.
 * Idempotent — skips dates already present.
 */
function generateCalendar(startDate, endDate) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO dim_calendar
      (date, year, quarter, month, week, day, day_of_week, month_name, day_name, is_weekend)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const start = new Date(startDate);
  const end = new Date(endDate);
  const insertMany = db.transaction(() => {
    const d = new Date(start);
    while (d <= end) {
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const quarter = Math.ceil(month / 3);
      const dayOfWeek = d.getDay();
      // ISO week number
      const jan1 = new Date(year, 0, 1);
      const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);

      insert.run(dateStr, year, quarter, month, week, day, dayOfWeek, MONTH_NAMES[month-1], DAY_NAMES[dayOfWeek], dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0);

      d.setDate(d.getDate() + 1);
    }
  });
  insertMany();
}

// ---- dimension lookups ------------------------------------------------

/**
 * Look up or create a dimension row.
 * Accepts optional attributes from a DimProduct sheet (brand, cost, launch date, etc.)
 * Returns the surrogate key id.
 */
function upsertProduct(name, attrs = {}) {
  const db = getDb();
  if (!name || name === 'Unknown') name = 'Unknown';
  const naturalKey = name.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM dim_product WHERE natural_key = ?').get(naturalKey);
  if (existing) {
    // Update attributes if we now have richer data
    const hasNewAttrs = attrs.category || attrs.brand || attrs.list_price || attrs.standard_cost || attrs.launch_date
      || attrs.resolved_brand || attrs.resolved_generic || attrs.resolved_manufacturer;
    if (hasNewAttrs) {
      db.prepare(`UPDATE dim_product SET
        category = COALESCE(NULLIF(?, ''), category),
        brand = COALESCE(NULLIF(?, ''), brand),
        is_generic = COALESCE(NULLIF(?, ''), is_generic),
        pack_size = COALESCE(NULLIF(?, ''), pack_size),
        list_price = COALESCE(?, list_price),
        standard_cost = COALESCE(?, standard_cost),
        launch_date = COALESCE(NULLIF(?, ''), launch_date),
        is_discontinued = COALESCE(NULLIF(?, ''), is_discontinued),
        discontinued_date = COALESCE(NULLIF(?, ''), discontinued_date),
        resolved_brand = COALESCE(NULLIF(?, ''), resolved_brand),
        resolved_generic = COALESCE(NULLIF(?, ''), resolved_generic),
        resolved_manufacturer = COALESCE(NULLIF(?, ''), resolved_manufacturer),
        resolved_strength = COALESCE(NULLIF(?, ''), resolved_strength),
        resolved_form = COALESCE(NULLIF(?, ''), resolved_form),
        resolved_nafdac_no = COALESCE(NULLIF(?, ''), resolved_nafdac_no),
        resolution_status = COALESCE(NULLIF(?, ''), resolution_status),
        clinical_product_id = COALESCE(NULLIF(?, ''), clinical_product_id),
        therapeutic_class = COALESCE(NULLIF(?, ''), therapeutic_class),
        active_ingredients = COALESCE(NULLIF(?, ''), active_ingredients),
        resolution_tier = COALESCE(NULLIF(?, ''), resolution_tier)
        WHERE id = ?`).run(
          attrs.category || null,
          attrs.brand || null,
          attrs.is_generic || null,
          attrs.pack_size || null,
          attrs.list_price || null,
          attrs.standard_cost || null,
          attrs.launch_date || null,
          attrs.is_discontinued || null,
          attrs.discontinued_date || null,
          attrs.resolved_brand || null,
          attrs.resolved_generic || null,
          attrs.resolved_manufacturer || null,
          attrs.resolved_strength || null,
          attrs.resolved_form || null,
          attrs.resolved_nafdac_no || null,
          attrs.resolution_status || null,
          attrs.clinical_product_id || null,
          attrs.therapeutic_class || null,
          Array.isArray(attrs.active_ingredients) ? attrs.active_ingredients.join(', ') : (attrs.active_ingredients || null),
          attrs.resolution_tier || null,
          existing.id
        );
    }
    return existing.id;
  }
  // Insert with all available attributes
  const category = attrs.category || classifyProduct(name);
  return db.prepare(`INSERT INTO dim_product
    (natural_key, name, category, brand, is_generic, pack_size, list_price, standard_cost, launch_date, is_discontinued, discontinued_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      naturalKey, name, category,
      attrs.brand || null,
      attrs.is_generic || null,
      attrs.pack_size || null,
      attrs.list_price || null,
      attrs.standard_cost || null,
      attrs.launch_date || null,
      attrs.is_discontinued || null,
      attrs.discontinued_date || null
    ).lastInsertRowid;
}

function classifyProduct(name) {
  const n = name.toLowerCase();
  if (/paracetamol|pcm/.test(n)) return 'Analgesic';
  if (/ibuprofen|diclofenac|piroxicam/.test(n)) return 'NSAID';
  if (/amoxicillin|ampicillin|augmentin|ciprofloxacin|metronidazole/.test(n)) return 'Antibiotic';
  if (/artemether|lumefantrine|coartem|amodiaquine/.test(n)) return 'Antimalarial';
  if (/vitamin|multivitamin|vit c/.test(n)) return 'Vitamin/Supplement';
  if (/omeprazole|ranitidine/.test(n)) return 'GI';
  if (/metformin|glibenclamide/.test(n)) return 'Antidiabetic';
  return null;
}

function upsertBranch(name, location, pharmacyId) {
  const db = getDb();
  if (!name) name = 'Default Branch';
  const naturalKey = (pharmacyId ? pharmacyId + '::' : '') + name.toLowerCase().trim();
  const result = db.prepare('SELECT id FROM dim_branch WHERE natural_key = ?').get(naturalKey);
  if (result) return result.id;
  return db.prepare('INSERT INTO dim_branch (natural_key, name, location, pharmacy_id) VALUES (?, ?, ?, ?)').run(naturalKey, name, location || null, pharmacyId || null).lastInsertRowid;
}

function upsertEmployee(name, role, branchId) {
  const db = getDb();
  if (!name) return null;
  const naturalKey = name.toLowerCase().trim();
  const result = db.prepare('SELECT id FROM dim_employee WHERE natural_key = ?').get(naturalKey);
  if (result) return result.id;
  return db.prepare('INSERT INTO dim_employee (natural_key, name, role, branch_id) VALUES (?, ?, ?, ?)').run(naturalKey, name, role || null, branchId || null).lastInsertRowid;
}

function upsertCustomer(name, type, hmo_code) {
  const db = getDb();
  if (!name) name = 'Walk-in Customer';
  const naturalKey = name.toLowerCase().trim();
  const result = db.prepare('SELECT id FROM dim_customer WHERE natural_key = ?').get(naturalKey);
  if (result) return result.id;
  return db.prepare('INSERT INTO dim_customer (natural_key, name, type, hmo_code) VALUES (?, ?, ?, ?)').run(naturalKey, name, type || 'walk-in', hmo_code || null).lastInsertRowid;
}

function getCalendarId(dateStr) {
  const db = getDb();
  if (!dateStr) return null;
  const result = db.prepare('SELECT id FROM dim_calendar WHERE date = ?').get(dateStr.substring(0, 10));
  return result ? result.id : null;
}

// ---- product attribute population -------------------------------------

/**
 * Bulk-populate dim_product attributes from sheet-joined enrichment columns.
 * Reads columns like _product_Brand, _product_Category, _product_ListPriceEUR
 * from joined rows and upserts them into dim_product.
 */
function populateProductAttributes(joinedRows) {
  const db = getDb();
  if (!joinedRows || joinedRows.length === 0) return;

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
      launch_date: row['_product_LaunchDate'],
      is_discontinued: row['_product_IsDiscontinued'],
      discontinued_date: row['_product_DiscontinuedDate'],
    });
  }

  const upsert = db.prepare(`INSERT INTO dim_product
    (natural_key, name, category, brand, is_generic, pack_size, list_price, standard_cost, launch_date, is_discontinued, discontinued_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(natural_key) DO UPDATE SET
      category = COALESCE(NULLIF(excluded.category, ''), dim_product.category),
      brand = COALESCE(NULLIF(excluded.brand, ''), dim_product.brand),
      is_generic = COALESCE(NULLIF(excluded.is_generic, ''), dim_product.is_generic),
      pack_size = COALESCE(NULLIF(excluded.pack_size, ''), dim_product.pack_size),
      list_price = COALESCE(excluded.list_price, dim_product.list_price),
      standard_cost = COALESCE(excluded.standard_cost, dim_product.standard_cost),
      launch_date = COALESCE(NULLIF(excluded.launch_date, ''), dim_product.launch_date),
      is_discontinued = COALESCE(NULLIF(excluded.is_discontinued, ''), dim_product.is_discontinued),
      discontinued_date = COALESCE(NULLIF(excluded.discontinued_date, ''), dim_product.discontinued_date)
  `);

  const populate = db.transaction(() => {
    for (const p of products) {
      upsert.run(
        p.name.toLowerCase().trim(), p.name, p.category, p.brand,
        p.is_generic, p.pack_size, p.list_price, p.standard_cost,
        p.launch_date, p.is_discontinued, p.discontinued_date
      );
    }
  });
  populate();
}

// ---- transaction loading ----------------------------------------------

/**
 * Load normalized records into the star schema.
 *
 * Uses "replace" semantics: when branchId is provided, all existing records
 * for that branch are deleted before inserting the new batch. This prevents
 * duplicate data on re-upload of the same file.
 *
 * @param {object[]} records — normalized [{product, quantity, price, cost, date, payment_method, branch, employee, customer}]
 * @param {object} [options]
 * @param {number} [options.branchId] — if provided, delete existing records for this branch first
 * @returns {number} rows inserted
 */
function loadFactRecords(records, options = {}) {
  const db = getDb();

  // Determine date range and ensure calendar covers it
  const dates = records.map((r) => r.transaction_date).filter(Boolean).sort();
  if (dates.length > 0) {
    const min = dates[0];
    const max = dates[dates.length - 1];
    generateCalendar(min, max);
  }

  const insertFact = db.prepare(`
    INSERT INTO fact_sales
      (product_id, branch_id, employee_id, customer_id, calendar_id, quantity, unit_price, unit_cost, payment_method, invoice_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const { branchId: targetBranchId } = options;

  const load = db.transaction(() => {
    // Resolve the branch ID from the first record (all records in a batch share the same branch).
    // Fall back to the default branch (1) so we always have a branch to scope the DELETE to.
    let resolvedBranchId = targetBranchId || 1;
    if (records.length > 0 && records[0].branch) {
      resolvedBranchId = upsertBranch(
        records[0].branch,
        records[0].branch_location,
        records[0].pharmacy_id
      );
    }

    // Replace: when no explicit targetBranchId is provided, wipe ALL fact_sales.
    // This makes each upload a full replacement (idempotent re-upload of the same file).
    // When a targetBranchId is explicitly passed, only wipe that branch's records.
    if (targetBranchId) {
      db.prepare('DELETE FROM fact_sales WHERE branch_id = ?').run(targetBranchId);
    } else {
      db.prepare('DELETE FROM fact_sales').run();
    }

    for (const rec of records) {
      // Support both new canonical names and legacy field names
      const productName = rec.product_name || rec.product;
      const price = rec.selling_price != null ? rec.selling_price : rec.price;
      const qty = rec.quantity;
      // Normalize cost to per-unit when _cost_is_total is set
      const rawCost = rec.cost_price != null ? rec.cost_price : rec.cost;
      const cost = rec._cost_is_total === true && qty > 0
        ? rawCost / qty
        : rawCost;
      const date = rec.transaction_date;

      const productId = upsertProduct(productName, {
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
      });
      const calendarId = getCalendarId(date);
      if (!calendarId) continue;

      const branchId = rec.branch
        ? upsertBranch(rec.branch, rec.branch_location, rec.pharmacy_id)
        : resolvedBranchId;

      const employeeId = rec.employee
        ? upsertEmployee(rec.employee, rec.employee_role, branchId)
        : null;

      const customerId = rec.customer
        ? upsertCustomer(rec.customer, rec.customer_type, rec.hmo_code)
        : 1;

      insertFact.run(
        productId,
        branchId,
        employeeId,
        customerId,
        calendarId,
        qty || 1,
        price || 0,
        cost || null,
        rec.payment_method || null,
        rec.invoice_ref || null
      );
      inserted++;
    }
  });

  load();

  // Clean up orphaned dimension rows — products with no fact_sales rows
  // keep the dimensional model consistent after a full replacement.
  db.prepare(`
    DELETE FROM dim_product WHERE id NOT IN (
      SELECT DISTINCT product_id FROM fact_sales
    )
  `).run();
  // Compact: remove calendar dates that no fact references
  db.prepare(`
    DELETE FROM dim_calendar WHERE id NOT IN (
      SELECT DISTINCT calendar_id FROM fact_sales
    )
  `).run();

  return inserted;
}

// ---- analytics queries ------------------------------------------------

/**
 * Query analytics from the star schema.
 * Returns the same JSON shape the dashboard expects.
 */
function queryAnalytics(options = {}) {
  const db = getDb();
  const { startDate, endDate, branchId } = options;

  let dateFilter = '';
  const params = {};
  if (startDate) { dateFilter += ' AND c.date >= @startDate'; params.startDate = startDate; }
  if (endDate)   { dateFilter += ' AND c.date <= @endDate';   params.endDate = endDate; }
  if (branchId)  { dateFilter += ' AND f.branch_id = @branchId'; params.branchId = branchId; }

  // Top-level metrics
  const metricsSql = `
    SELECT
      COALESCE(SUM(f.unit_price * f.quantity), 0)          AS totalRevenue,
      COALESCE(SUM(f.quantity), 0)                         AS totalQuantitySold,
      COALESCE(SUM(f.unit_price * f.quantity) / NULLIF(SUM(f.quantity), 0), 0) AS averageSellingPrice,
      COALESCE(SUM((f.unit_price - f.unit_cost) * f.quantity), NULL) AS grossProfit,
      CASE WHEN SUM(f.unit_price * f.quantity) > 0
           THEN ROUND((SUM((f.unit_price - f.unit_cost) * f.quantity) / SUM(f.unit_price * f.quantity)) * 100, 2)
           ELSE NULL END                                   AS grossMargin,
      COALESCE(SUM(f.unit_price * f.quantity) / NULLIF(COUNT(*), 0), 0) AS averageTransactionValue,
      COALESCE(SUM(f.unit_cost * f.quantity), 0)           AS totalCost,
      COUNT(*)                                              AS recordCount
    FROM fact_sales f
    JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE 1=1 ${dateFilter}
  `;
  const metrics = db.prepare(metricsSql).get(params);

  // Monthly revenue
  const monthlyRevenueSql = `
    SELECT c.date AS month, SUM(f.unit_price * f.quantity) AS revenue
    FROM fact_sales f
    JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE 1=1 ${dateFilter}
    GROUP BY strftime('%Y-%m', c.date)
    ORDER BY month
  `;
  const monthlyRevenueRaw = db.prepare(monthlyRevenueSql).all(params);
  const monthlyRevenue = monthlyRevenueRaw.map((r) => ({
    month: r.month.substring(0, 7),
    revenue: Math.round(r.revenue * 100) / 100,
  }));

  // Monthly profit
  const monthlyProfitSql = `
    SELECT strftime('%Y-%m', c.date) AS month,
           SUM(f.unit_price * f.quantity) AS revenue,
           SUM(f.unit_cost * f.quantity) AS cost,
           SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit
    FROM fact_sales f
    JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE 1=1 ${dateFilter}
    GROUP BY strftime('%Y-%m', c.date)
    ORDER BY month
  `;
  const monthlyProfit = db.prepare(monthlyProfitSql).all(params).map((r) => ({
    month: r.month,
    revenue: Math.round(r.revenue * 100) / 100,
    cost: r.cost != null ? Math.round(r.cost * 100) / 100 : null,
    profit: r.profit != null ? Math.round(r.profit * 100) / 100 : null,
  }));

  // Top products
  const topProductsSql = `
    SELECT p.name,
           SUM(f.unit_price * f.quantity) AS revenue,
           SUM(f.quantity) AS quantity,
           SUM((f.unit_price - f.unit_cost) * f.quantity) AS profit,
           CASE WHEN SUM(f.unit_price * f.quantity) > 0
                THEN ROUND((SUM((f.unit_price - f.unit_cost) * f.quantity) / SUM(f.unit_price * f.quantity)) * 100, 2)
                ELSE NULL END AS margin
    FROM fact_sales f
    JOIN dim_product p ON f.product_id = p.id
    JOIN dim_calendar c ON f.calendar_id = c.id
    WHERE 1=1 ${dateFilter}
    GROUP BY p.id
    ORDER BY revenue DESC
    LIMIT 10
  `;
  const topProducts = db.prepare(topProductsSql).all(params).map((r) => ({
    name: r.name,
    revenue: Math.round(r.revenue * 100) / 100,
    quantity: Math.round(r.quantity * 100) / 100,
    profit: r.profit != null ? Math.round(r.profit * 100) / 100 : null,
    margin: r.margin,
  }));

  return {
    metrics: {
      totalRevenue: Math.round((metrics.totalRevenue || 0) * 100) / 100,
      totalQuantitySold: Math.round((metrics.totalQuantitySold || 0) * 100) / 100,
      averageSellingPrice: Math.round((metrics.averageSellingPrice || 0) * 100) / 100,
      grossProfit: metrics.grossProfit != null ? Math.round(metrics.grossProfit * 100) / 100 : null,
      grossMargin: metrics.grossMargin,
      totalCost: Math.round((metrics.totalCost || 0) * 100) / 100,
      recordCount: metrics.recordCount || 0,
      averageTransactionValue: Math.round((metrics.averageTransactionValue || 0) * 100) / 100,
    },
    monthlyRevenue,
    monthlyProfit,
    topProducts,
  };
}

// ---- maintenance -------------------------------------------------------

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  generateCalendar,
  upsertProduct,
  populateProductAttributes,
  upsertBranch,
  upsertEmployee,
  upsertCustomer,
  getCalendarId,
  loadFactRecords,
  queryAnalytics,
  closeDb,
};
