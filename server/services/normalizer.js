/**
 * Normalizer — orchestrates the full ingestion pipeline.
 *
 * Phase 2: Uses canonical field names:
 *   product_name, quantity, revenue, cost_price, selling_price, date
 *
 * Pipeline: Upload → Detection → LLM + Rule Mapping → Data Cleaning → Normalized Dataset → Analytics
 */

const { detectSchema, mergeLlmResults } = require('./schemaDetector');
const { resolveMapping, loadMapping, saveMapping, hasTransactionCapability } = require('./columnMapper');
const { cleanData, CleaningReport, parseCurrency, serialToDate, parseYYYYMMDD, parseDateString, normalizePaymentMethod } = require('./dataCleaner');
const { normalizeProductName, normalizeProductNames } = require('./productNormalizer');
const { joinSheets } = require('./sheetJoiner');
const { populateProductAttributes } = require('./database');
const { REQUIRED_FIELDS } = require('./dictionary');
const { structuralValidate, businessValidate } = require('./dataQuality');
const { resolveProductIdentities } = require('./productIdentityResolver');

/**
 * Convert a cleaned row into a normalized record using the resolved mapping.
 */
function normalizeRow(row, mapping, costMode, tiers) {
  const record = {
    // Core transaction fields
    product_name: null,
    source_product_name: null,
    canonical_product: null,
    display_product: null,
    quantity: null,
    revenue: null,
    cost_price: null,
    selling_price: null,
    date: null,
    payment_method: null,
    // Product detail fields (source — what pharmacy uploaded)
    supplier: null,
    manufacturer: null,
    brand: null,
    generic_name: null,
    category: null,
    subcategory: null,
    batch_number: null,
    expiry_date: null,
    // Phase 1: source product identity fields
    strength: null,
    dosage_form: null,
    pack_size: null,
    // Resolved identity fields (NAFDAC enrichment — never overwrites source)
    resolved_manufacturer: null,
    resolved_generic: null,
    resolved_brand: null,
    resolved_strength: null,
    resolved_form: null,
    resolved_nafdac_no: null,
    resolved_therapeutic_group: null,
    resolved_therapeutic_subgroup: null,
    resolution_confidence: null,
    resolution_tier: null,
    resolution_status: null,
    // Layer 3: Clinical identity
    clinical_product_id: null,
    therapeutic_class: null,
    active_ingredients: null,
    // Organizational fields
    branch: null,
    warehouse: null,
    sales_channel: null,
    customer: null,
    sales_representative: null,
    invoice_number: null,
    // Financial detail fields
    discount: null,
    tax: null,
    profit: null,
    margin: null,
    // Phase 1: inventory fields
    current_stock: null,
    reorder_level: null,
    min_stock: null,
    max_stock: null,
    opening_stock: null,
    // Phase 2: NAFDAC enrichment fields
    nafdac_no: null,
    therapeutic_group: null,
    therapeutic_subgroup: null,
    identity_confidence: null,
    // Columns from the uploaded file that didn't match any known category —
    // preserved rather than discarded (see collection logic below).
    extra_fields: null,
    // Cost-price attribution flag (per-file, set during cost-mode detection)
    _cost_is_total: costMode?.costIsTotal ?? null,
  };

  for (const [category, info] of Object.entries(mapping)) {
    if (!info || !info.rawHeader) continue;
    const rawVal = row[info.rawHeader];

    switch (category) {
      case 'product_name':
        // Phase 2: prefer resolved identity over raw value
        if (row['_resolved_product_name'] != null && row['_resolved_product_name'] !== '') {
          record.product_name = String(row['_resolved_product_name']).trim();
        } else if (row['_productName'] != null && row['_productName'] !== '') {
          record.product_name = String(row['_productName']).trim();
        } else if (rawVal != null) {
          record.product_name = String(rawVal).trim();
        }
        break;

      case 'quantity':
        record.quantity = parseQuantity(rawVal);
        break;

      case 'revenue':
        record.revenue = parseCurrency(rawVal);
        break;

      case 'selling_price':
        record.selling_price = parseCurrency(rawVal);
        break;

      case 'cost_price':
        record.cost_price = parseCurrency(rawVal);
        break;

      case 'date':              // legacy — canonical is now transaction_date
      case 'transaction_date':
        record.transaction_date = normalizeDate(rawVal);
        break;

      case 'payment_method':
        record.payment_method = rawVal != null ? String(rawVal).trim() : null;
        break;

      // ---- product detail fields ----

      case 'supplier':
        record.supplier = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'brand':
        record.brand = row['_resolved_brand'] != null ? String(row['_resolved_brand']).trim() : (rawVal != null ? String(rawVal).trim() : null);
        break;

      case 'generic_name':
        record.generic_name = row['_resolved_generic_name'] != null ? String(row['_resolved_generic_name']).trim() : (rawVal != null ? String(rawVal).trim() : null);
        break;

      case 'manufacturer':
        record.manufacturer = row['_resolved_manufacturer'] != null ? String(row['_resolved_manufacturer']).trim() : (rawVal != null ? String(rawVal).trim() : null);
        break;

      case 'strength':
        record.strength = row['_resolved_strength'] != null ? String(row['_resolved_strength']).trim() : (rawVal != null ? String(rawVal).trim() : null);
        break;

      case 'dosage_form':
        record.dosage_form = row['_resolved_dosage_form'] != null ? String(row['_resolved_dosage_form']).trim() : (rawVal != null ? String(rawVal).trim() : null);
        break;

      case 'pack_size':
        record.pack_size = parseQuantity(rawVal);
        break;

      case 'category':
        record.category = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'subcategory':
        record.subcategory = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'batch_number':
        record.batch_number = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'expiry_date':
        record.expiry_date = normalizeDate(rawVal);
        break;

      // ---- organizational fields ----

      case 'branch':
        record.branch = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'warehouse':
        record.warehouse = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'sales_channel':
        record.sales_channel = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'customer':
        record.customer = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'sales_representative':
        record.sales_representative = rawVal != null ? String(rawVal).trim() : null;
        break;

      case 'invoice_number':
        record.invoice_number = rawVal != null ? String(rawVal).trim() : null;
        break;

      // ---- financial detail fields ----

      case 'discount':
        record.discount = parseCurrency(rawVal);
        break;

      case 'tax':
        record.tax = parseCurrency(rawVal);
        break;

      case 'profit':
        record.profit = parseCurrency(rawVal);
        break;

      case 'margin':
        record.margin = parseCurrency(rawVal);
        break;

      // ---- Phase 1: inventory fields ----

      case 'current_stock':
        record.current_stock = parseQuantity(rawVal);
        break;

      case 'reorder_level':
        record.reorder_level = parseQuantity(rawVal);
        break;

      case 'min_stock':
        record.min_stock = parseQuantity(rawVal);
        break;

      case 'max_stock':
        record.max_stock = parseQuantity(rawVal);
        break;

      case 'opening_stock':
        record.opening_stock = parseQuantity(rawVal);
        break;
    }
  }

  // ---- Preserve unmapped columns — never silently discard uploaded data ----
  // Any raw column that didn't match a known category (novel field the
  // taxonomy doesn't cover yet, or a header phrasing the detector didn't
  // recognize) is kept here instead of being dropped, so nothing is lost
  // even before the taxonomy/synonyms catch up. Also gives the dedup step
  // above real signal to distinguish legitimate repeat sales from true
  // duplicate rows.
  {
    const mappedRawHeaders = new Set(
      Object.values(mapping).filter((info) => info && info.rawHeader).map((info) => info.rawHeader)
    );
    // Pipeline-internal keys added earlier (product identity resolution etc.)
    // that aren't "_"-prefixed but are already captured on the record via
    // the enrichment step in normalize() — exclude to avoid duplicating them.
    const INTERNAL_NON_UNDERSCORED = new Set([
      'source_product_name', 'canonical_product', 'display_product',
      'resolution_tier', 'resolution_confidence', 'resolution_source',
      'resolution_status', 'resolution_method', 'parser_confidence', 'lookup_confidence',
    ]);
    const extraFields = {};
    for (const [key, val] of Object.entries(row)) {
      if (key.startsWith('_')) continue; // internal enrichment metadata, not a source column
      if (INTERNAL_NON_UNDERSCORED.has(key)) continue;
      if (mappedRawHeaders.has(key)) continue; // already captured above
      if (val == null || val === '') continue; // skip genuinely empty cells
      extraFields[key] = val;
    }
    if (Object.keys(extraFields).length > 0) {
      record.extra_fields = extraFields;
    }
  }

  // If quantity is null but we have selling_price AND the mapping
  // confirms this is a transaction log (date column at a reliable tier),
  // assume qty=1 per row. Without a reliable date mapping this is
  // likely a catalog/snapshot — do not fabricate quantity.
  if (record.quantity == null && record.selling_price != null && hasTransactionCapability(mapping, tiers)) {
    record.quantity = 1;
  }

  // ---- discount adjustment — revenue must be net of discount BEFORE derivation ---
  if (record.discount != null && record.discount > 0 && record.revenue != null) {
    record.revenue = Math.max(0, Math.round((record.revenue - record.discount) * 100) / 100);
  }

  // ---- derived fields — compute from available base fields ----
  record._derived = {};

  // ---- Phase 1: Composite product identity ----
  // If no direct product_name column, compose from available identity fields.
  if (!record.product_name || record.product_name === 'Unknown') {
    const parts = [];
    if (record.generic_name) parts.push(record.generic_name);
    if (record.brand) parts.push(record.brand);
    if (record.strength) parts.push(record.strength);
    if (record.dosage_form) parts.push(record.dosage_form);

    if (parts.length > 0) {
      record.product_name = parts.join(' ');
      record._derived.product_name = {
        from: ['generic_name', 'brand', 'strength', 'dosage_form'].filter((f) => record[f] != null),
        formula: 'Composite product identity',
      };
    }
  }

  // Revenue = Selling Price × Quantity
  if (record.revenue == null && record.selling_price != null && record.quantity != null) {
    record.revenue = Math.round(record.selling_price * record.quantity * 100) / 100;
    record._derived.revenue = { from: ['selling_price', 'quantity'], formula: 'Selling Price × Quantity' };
  }

  // Selling Price = Revenue ÷ Quantity
  if (record.selling_price == null && record.revenue != null && record.quantity != null && record.quantity > 0) {
    record.selling_price = Math.round((record.revenue / record.quantity) * 100) / 100;
    record._derived.selling_price = { from: ['revenue', 'quantity'], formula: 'Revenue ÷ Quantity' };
  }

  // Profit = Revenue − Cost
  // When _cost_is_total is true, cost_price is already the per-row total (no × qty).
  if (record.profit == null && record.revenue != null && record.cost_price != null && record.quantity != null && record.quantity > 0) {
    const costIsTotal = record._cost_is_total === true;
    if (costIsTotal) {
      record.profit = Math.round((record.revenue - record.cost_price) * 100) / 100;
      record._derived.profit = { from: ['revenue', 'cost_price'], formula: 'Revenue − Cost Price (total-cost mode)' };
    } else {
      record.profit = Math.round((record.revenue - record.cost_price * record.quantity) * 100) / 100;
      record._derived.profit = { from: ['revenue', 'cost_price', 'quantity'], formula: 'Revenue − (Cost Price × Quantity)' };
    }
  }

  // Profit = (Selling Price − Cost Price) × Quantity
  // When _cost_is_total is true, cost_price is already the per-row total — use it directly.
  if (record.profit == null && record.selling_price != null && record.cost_price != null && record.quantity != null && record.quantity > 0) {
    const costIsTotal = record._cost_is_total === true;
    if (record.revenue != null && costIsTotal) {
      record.profit = Math.round((record.revenue - record.cost_price) * 100) / 100;
      record._derived.profit = { from: ['revenue', 'cost_price'], formula: 'Revenue − Cost Price (total-cost mode)' };
    } else if (record.revenue != null) {
      record.profit = Math.round((record.revenue - record.cost_price * record.quantity) * 100) / 100;
      record._derived.profit = { from: ['revenue', 'cost_price', 'quantity'], formula: 'Revenue − (Cost Price × Quantity)' };
    } else if (costIsTotal) {
      record.profit = Math.round((record.selling_price * record.quantity - record.cost_price) * 100) / 100;
      record._derived.profit = { from: ['selling_price', 'quantity', 'cost_price'], formula: '(Selling Price × Quantity) − Cost Price (total-cost mode)' };
    } else {
      record.profit = Math.round(((record.selling_price - record.cost_price) * record.quantity) * 100) / 100;
      record._derived.profit = { from: ['selling_price', 'cost_price', 'quantity'], formula: '(Selling Price − Cost Price) × Quantity' };
    }
  }

  // Margin (%) = Profit / Revenue × 100
  // When _cost_is_total is true, margin uses total values directly:
  //   Margin = (Revenue − Cost Price) / Revenue  (or equivalent with selling_price)
  if (record.margin == null && record.selling_price != null && record.cost_price != null && record.selling_price > 0) {
    const costIsTotal = record._cost_is_total === true;
    if (record.revenue != null && costIsTotal) {
      record.margin = record.revenue > 0
        ? Math.round(((record.revenue - record.cost_price) / record.revenue) * 10000) / 100
        : null;
      if (record.margin != null) {
        record._derived.margin = { from: ['revenue', 'cost_price'], formula: '((Revenue − Cost Price) ÷ Revenue) × 100 (total-cost mode)' };
      }
    } else {
      record.margin = Math.round(((record.selling_price - record.cost_price) / record.selling_price) * 10000) / 100;
      record._derived.margin = { from: ['selling_price', 'cost_price'], formula: '((Selling Price − Cost Price) ÷ Selling Price) × 100' };
    }
  }

  // Margin (%) = (Profit / Revenue) × 100
  if (record.margin == null && record.profit != null && record.revenue != null && record.revenue > 0) {
    record.margin = Math.round((record.profit / record.revenue) * 10000) / 100;
    record._derived.margin = { from: ['profit', 'revenue'], formula: '(Profit ÷ Revenue) × 100' };
  }

  // Cost Price = Selling Price − (Profit / Quantity)
  if (record.cost_price == null && record.selling_price != null && record.profit != null && record.quantity != null && record.quantity > 0) {
    record.cost_price = Math.round((record.selling_price - record.profit / record.quantity) * 100) / 100;
    record._derived.cost_price = { from: ['selling_price', 'profit', 'quantity'], formula: 'Selling Price − (Profit ÷ Quantity)' };
  }

  // Cost Price = (Revenue − Profit) / Quantity
  if (record.cost_price == null && record.revenue != null && record.profit != null && record.quantity != null && record.quantity > 0) {
    record.cost_price = Math.round(((record.revenue - record.profit) / record.quantity) * 100) / 100;
    record._derived.cost_price = { from: ['revenue', 'profit', 'quantity'], formula: '(Revenue − Profit) ÷ Quantity' };
  }

  return record;
}

function parseQuantity(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const n = Number(String(val).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeDate(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    // Check YYYYMMDD integer first (e.g., 20240715, 45412 is Excel serial)
    const ymd = parseYYYYMMDD(val);
    if (ymd) return ymd;
    // Excel serial date — accept any reasonable year (1900-2200)
    const serial = serialToDate(val);
    if (serial) {
      const year = parseInt(serial.substring(0, 4), 10);
      // Excel epoch is 1900; accept dates from 1900 onwards
      if (year >= 1900 && year <= 2200) return serial;
    }
    return null;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return null;
    // Delegate all string parsing to the enterprise date parser
    const parsed = parseDateString(s);
    if (parsed) {
      const year = parseInt(parsed.substring(0, 4), 10);
      // Accept dates from 1900 onwards (legacy data, Excel epoch, etc.)
      if (year >= 1900 && year <= 2200) return parsed;
    }
    return null;
  }
  return null;
}

// ---- derived metrics report --------------------------------------------

/**
 * Scan normalized records for auto-derived fields and produce a summary
 * report for the API response.
 */
function deriveMetricsReport(records) {
  if (!records || records.length === 0) return null;

  const derivations = {};
  let enrichedRows = 0;
  const sampleFormulas = {};

  for (const rec of records) {
    let enriched = false;
    if (rec._derived) {
      for (const [field, meta] of Object.entries(rec._derived)) {
        derivations[field] = (derivations[field] || 0) + 1;
        if (!sampleFormulas[field]) sampleFormulas[field] = meta.formula;
        enriched = true;
      }
    }
    if (enriched) enrichedRows++;
  }

  if (enrichedRows === 0) return null;

  return {
    totalRows: records.length,
    enrichedRows,
    derivations,
    formulas: sampleFormulas,
  };
}

// ---- main pipeline -----------------------------------------------------

/**
 * Determine whether cost_price values in a file are per-unit or already-total.
 *
 * Uses two strategies:
 *   1. If an explicit profit column exists, cross-check both interpretations
 *      against it and pick the one with the smaller total error.
 *   2. Otherwise, compute file-level gross margin under both interpretations;
 *      a margin in the 0–90% range is plausible.
 *
 * Returns { costIsTotal: true|false|null, confidence: 0–1, source: string }
 * where null = genuinely ambiguous (neither interpretation is plausible).
 */
function determineCostMode(cleanedRows, mapping) {
  const costInfo = mapping['cost_price'];
  if (!costInfo || !costInfo.rawHeader) return { costIsTotal: null, confidence: 0, source: 'no cost column mapped' };

  const costHeader = costInfo.rawHeader;
  const qtyInfo = mapping['quantity'];
  const revInfo = mapping['revenue'];
  const profitInfo = mapping['profit'];

  let hasExplicitProfit = false;
  let perUnitCostTotal = 0, asTotalCostTotal = 0;
  let perUnitError = 0, asTotalError = 0;
  let errorRows = 0;
  let validRows = 0;

  for (const row of cleanedRows) {
    const rawCost = Number(row[costHeader]);
    if (!Number.isFinite(rawCost) || rawCost <= 0) continue;

    const rawQty = qtyInfo ? Number(row[qtyInfo.rawHeader]) : 1;
    if (!Number.isFinite(rawQty) || rawQty <= 0) continue;

    const rawRevenue = revInfo ? Number(row[revInfo.rawHeader]) : null;

    validRows++;

    // Accumulate under both interpretations for margin check
    perUnitCostTotal += rawCost * rawQty;   // interpretation: per-unit
    asTotalCostTotal += rawCost;             // interpretation: already total

    // Cross-check with explicit profit if available
    if (profitInfo && profitInfo.rawHeader) {
      const rawProfit = Number(row[profitInfo.rawHeader]);
      if (Number.isFinite(rawProfit)) {
        hasExplicitProfit = true;
        if (rawRevenue != null && Number.isFinite(rawRevenue) && rawRevenue > 0) {
          const perUnitProfit = rawRevenue - (rawCost * rawQty);
          const asTotalProfit = rawRevenue - rawCost;
          perUnitError += Math.abs(perUnitProfit - rawProfit);
          asTotalError += Math.abs(asTotalProfit - rawProfit);
          errorRows++;
        }
      }
    }
  }

  if (validRows === 0) return { costIsTotal: null, confidence: 0, source: 'no valid cost/quantity rows' };

  // Strategy 1: explicit profit column → cross-check
  if (hasExplicitProfit && errorRows > 0) {
    // Use mean absolute error to avoid penalizing larger datasets
    const perUnitMAE = perUnitError / errorRows;
    const asTotalMAE = asTotalError / errorRows;

    if (perUnitMAE < asTotalMAE * 0.5) {
      return { costIsTotal: false, confidence: 0.9, source: `cross-checked against profit column (per-unit MAE=₦${Math.round(perUnitMAE)} vs total MAE=₦${Math.round(asTotalMAE)})` };
    }
    if (asTotalMAE < perUnitMAE * 0.5) {
      return { costIsTotal: true, confidence: 0.9, source: `cross-checked against profit column (total MAE=₦${Math.round(asTotalMAE)} vs per-unit MAE=₦${Math.round(perUnitMAE)})` };
    }
    // Close call — fall through to margin strategy
  }

  // Strategy 2: margin plausibility
  const totalRevenue = revInfo
    ? cleanedRows.reduce((s, r) => { const v = Number(r[revInfo.rawHeader]); return Number.isFinite(v) ? s + v : s; }, 0)
    : perUnitCostTotal; // no revenue column — can't compute margin

  if (totalRevenue <= 0) {
    return { costIsTotal: null, confidence: 0, source: 'no revenue column to compute margin' };
  }

  const marginPerUnit = ((totalRevenue - perUnitCostTotal) / totalRevenue) * 100;
  const marginAsTotal = ((totalRevenue - asTotalCostTotal) / totalRevenue) * 100;

  const plausiblePerUnit = marginPerUnit >= 0 && marginPerUnit <= 90;
  const plausibleAsTotal = marginAsTotal >= 0 && marginAsTotal <= 90;

  if (plausiblePerUnit && !plausibleAsTotal) {
    return { costIsTotal: false, confidence: 0.7, source: `per-unit margin ${marginPerUnit.toFixed(1)}% is plausible, total margin ${marginAsTotal.toFixed(1)}% is not` };
  }
  if (plausibleAsTotal && !plausiblePerUnit) {
    return { costIsTotal: true, confidence: 0.7, source: `total-cost margin ${marginAsTotal.toFixed(1)}% is plausible, per-unit margin ${marginPerUnit.toFixed(1)}% is not` };
  }
  if (plausiblePerUnit && plausibleAsTotal) {
    // Both plausible — prefer per-unit (safer default) but flag low confidence
    return { costIsTotal: false, confidence: 0.3, source: `both interpretations plausible (per-unit=${marginPerUnit.toFixed(1)}%, total=${marginAsTotal.toFixed(1)}%); defaulted to per-unit — review recommended` };
  }

  // Neither plausible — genuine ambiguity
  return { costIsTotal: null, confidence: 0, source: `neither interpretation produces a plausible margin (per-unit=${marginPerUnit.toFixed(1)}%, total=${marginAsTotal.toFixed(1)}%)` };
}

function normalize(rows, options = {}) {
  const { pharmacyId, userMapping, llmColumns } = options;

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      normalized: [], schema: [], mapping: {}, tiers: {},
      cleaningStats: { inputRows: 0, outputRows: 0 },
      cleaningReport: { summary: { totalRowsInput: 0, totalRowsOutput: 0, totalIssues: 0, totalTransformations: 0 } },
      productNormalizationStats: null,
      needsConfirmation: false,
    };
  }

  const rawHeaders = Object.keys(rows[0]);

  // Step 1: Rule-based schema detection
  let schema = detectSchema(rows);

  // Step 1.5: Merge LLM results if available
  if (llmColumns && llmColumns.length > 0) {
    schema = mergeLlmResults(schema, llmColumns);
  }

  // Step 2: Check saved mapping
  let savedMapping = null;
  if (pharmacyId) savedMapping = loadMapping(pharmacyId, rawHeaders);

  // Step 3: Resolve mapping
  let { mapping, tiers, unmapped, unmappedRequired, unmappedOptional, priceFulfilled } = resolveMapping(schema);

  // Step 4: Apply saved mapping as overrides
  if (savedMapping) {
    for (const [rawHeader, category] of Object.entries(savedMapping)) {
      const col = schema.find((c) => c.rawHeader === rawHeader);
      if (col) {
        const det = col.detections.find((d) => d.category === category);
        mapping[category] = {
          rawHeader, confidence: det ? det.confidence : 0.85,
          source: 'saved mapping', normalizedHeader: col.normalizedHeader,
        };
        tiers[category] = 'auto';
      }
    }
  }

  // Step 5: Apply user-provided overrides
  if (userMapping && Object.keys(userMapping).length > 0) {
    // 5a: Collect headers the user explicitly skipped (value === '')
    const skippedHeaders = new Set();
    for (const [rawHeader, userCat] of Object.entries(userMapping)) {
      if (userCat === '' || userCat == null) {
        skippedHeaders.add(rawHeader);
      }
    }

    // 5b: Remove auto-detected mappings for columns the user overrode OR skipped
    const userHeaders = new Set(Object.keys(userMapping));
    for (const [category, info] of Object.entries(mapping)) {
      if (userHeaders.has(info.rawHeader)) {
        delete mapping[category];
        delete tiers[category];
      }
    }

    // 5c: If user remapped to a category that was already auto-mapped, clear the old one
    for (const rawHeader of Object.keys(userMapping)) {
      const userCat = userMapping[rawHeader];
      if (userCat && mapping[userCat]) {
        delete mapping[userCat];
        delete tiers[userCat];
      }
    }

    // 5d: Apply user remappings (skip empty-string — those are deliberate skips)
    for (const [rawHeader, userCat] of Object.entries(userMapping)) {
      if (!userCat || skippedHeaders.has(rawHeader)) continue;
      const col = schema.find((c) => c.rawHeader === rawHeader);
      const det = col ? col.detections.find((d) => d.category === userCat) : null;
      mapping[userCat] = {
        rawHeader, confidence: det ? det.confidence : 0.85,
        source: 'user confirmed',
        normalizedHeader: col ? col.normalizedHeader : '',
      };
      tiers[userCat] = 'auto';
    }
  }

  // Step 6: Clean data
  const { records: cleanedRows, stats: cleaningStats, report: cleaningReport } = cleanData(rows, rawHeaders, { fileName: options.fileName });

  // Step 6.5: Normalize product names (Phase 4 — pharmacy knowledge engine)
  let productNormalizationStats = null;
  if (mapping['product_name']) {
    const rawHeader = mapping['product_name'].rawHeader;
    let recognized = 0, unknown = 0;
    const uniqueCanonical = new Set();
    const unknownNames = new Set();

    for (let i = 0; i < cleanedRows.length; i++) {
      const raw = cleanedRows[i][rawHeader];
      const result = normalizeProductName(raw);
      const normalized = result.normalized || raw || 'Unknown';

      if (result.recognized) {
        recognized++;
        if (result.canonicalId) uniqueCanonical.add(result.canonicalId);
      } else if (result.flag) {
        unknown++;
        if (result.normalized) unknownNames.add(result.normalized);
      }

      if (normalized !== raw) {
        cleaningReport.addTransformation(i, rawHeader, 'normalize_product',
          raw, normalized, `Standardized product name`);
      }
      cleanedRows[i][rawHeader] = normalized;
    }

    productNormalizationStats = {
      recognized,
      unknown,
      uniqueCanonicalDrugs: uniqueCanonical.size,
      unknownNames: [...unknownNames],
    };
  }

  // Step 6.6: Normalize payment method
  if (mapping['payment_method']) {
    for (const row of cleanedRows) {
      const raw = row[mapping['payment_method'].rawHeader];
      row[mapping['payment_method'].rawHeader] = normalizePaymentMethod(raw);
    }
  }

  // Step 6.7: Product Identity Resolution (Phase 2)
  // Runs after mapping is finalized, before row normalization.
  // Resolves canonical product identity regardless of spreadsheet structure.
  const identityResult = resolveProductIdentities(cleanedRows, mapping);

  // Apply resolved identity fields back to cleaned rows
  // (the resolver adds _resolved_* fields that normalizeRow will prefer)
  for (let i = 0; i < cleanedRows.length; i++) {
    Object.assign(cleanedRows[i], identityResult.records[i]);
  }

  // Step 6.9: Determine cost-price mode (per-unit vs per-total)
  // Must happen BEFORE normalizeRow so profit derivation uses the correct mode.
  const costMode = determineCostMode(cleanedRows, mapping);

  // Step 7: Normalize each row
  let normalized = cleanedRows.map((row) => normalizeRow(row, mapping, costMode, tiers));

  // Step 7.1: Apply enrichment fields to normalized records
  // Source identity is never modified — enrichment goes into resolved_* fields only
  for (let i = 0; i < normalized.length; i++) {
    const src = cleanedRows[i];
    const rec = normalized[i];
    // Source identity
    if (src.source_product_name) rec.source_product_name = src.source_product_name;
    if (src.canonical_product) rec.canonical_product = src.canonical_product;
    if (src.display_product) rec.display_product = src.display_product;
    // NAFDAC enrichment
    if (src._nafdac_no) rec.nafdac_no = src._nafdac_no;
    if (src._therapeutic_group) rec.therapeutic_group = src._therapeutic_group;
    if (src._therapeutic_subgroup) rec.therapeutic_subgroup = src._therapeutic_subgroup;
    // Category fallback: when the source file has no category column (or empty values),
    // use the NAFDAC therapeutic subgroup (more specific than the broad group, e.g.
    // "Hypertension" instead of "Cardiovascular") so analytics like "Top Revenue by
    // Category" don't show everything as "Uncategorised". Falls back to the broader
    // therapeutic group only if no subgroup was resolved.
    if (!rec.category && src._therapeutic_subgroup) rec.category = src._therapeutic_subgroup;
    else if (!rec.category && src._therapeutic_group) rec.category = src._therapeutic_group;
    if (src._identity_confidence) rec.identity_confidence = src._identity_confidence;
    if (src.resolution_confidence != null) rec.resolution_confidence = src.resolution_confidence;
    // Resolved identity (manufacturer, generic — enrichment only, never source)
    if (src._resolved_manufacturer) rec.resolved_manufacturer = src._resolved_manufacturer;
    if (src._resolved_generic_name) rec.resolved_generic = src._resolved_generic_name;
    if (src._resolved_brand) rec.resolved_brand = src._resolved_brand;
    if (src._resolved_strength) rec.resolved_strength = src._resolved_strength;
    if (src._resolved_dosage_form) rec.resolved_form = src._resolved_dosage_form;
    if (src._resolved_nafdac_no) rec.resolved_nafdac_no = src._resolved_nafdac_no;
    if (src._resolved_therapeutic_group) rec.resolved_therapeutic_group = src._resolved_therapeutic_group;
    if (src._resolved_therapeutic_subgroup) rec.resolved_therapeutic_subgroup = src._resolved_therapeutic_subgroup;
    if (src.resolution_status) rec.resolution_status = src.resolution_status;
    if (src.resolution_method) rec.resolution_method = src.resolution_method;
    if (src.parser_confidence != null) rec.parser_confidence = src.parser_confidence;
    if (src.lookup_confidence != null) rec.lookup_confidence = src.lookup_confidence;
    // Layer 3: Clinical identity
    if (src._clinical_product_id) rec.clinical_product_id = src._clinical_product_id;
    if (src._therapeutic_class) rec.therapeutic_class = src._therapeutic_class;
    if (src._active_ingredients) rec.active_ingredients = src._active_ingredients;
    if (src.resolution_tier) rec.resolution_tier = src.resolution_tier;
    // Backward compat: fill manufacturer/generic from resolved if not set from upload
    if (src._resolved_manufacturer && !rec.manufacturer) rec.manufacturer = src._resolved_manufacturer;
    if (src._resolved_generic_name && !rec.generic_name) rec.generic_name = src._resolved_generic_name;
    // Resolution metadata
    if (src._resolution_label) {
      rec._resolution_label = src._resolution_label;
      rec._resolution_rule = src._resolution_rule;
    }
  }

  // Step 7.5: Fill missing values (respects hasTransactionCapability for quantity default)
  normalized = fillMissingValuesV2(normalized, mapping, tiers);

  // Step 7.6: Deduplicate — hash the full original row (every uploaded
  // column, not just the handful mapped to known categories) so that
  // legitimate repeat sales sharing product/qty/price/date but differing
  // in some other column (branch, cashier, receipt no., row number, time)
  // aren't collapsed into one. If the file has no columns beyond the core
  // business fields already in the key, there is no reliable way to tell
  // a repeat sale from an accidental duplicate row — skip deduplication
  // rather than risk silently dropping real revenue.
  const CORE_DEDUPE_CATEGORIES = ['product_name', 'quantity', 'selling_price', 'revenue', 'cost_price', 'transaction_date', 'invoice_number', 'customer'];
  const coreMappedHeaders = new Set(
    CORE_DEDUPE_CATEGORIES.map((cat) => mapping[cat]?.rawHeader).filter(Boolean)
  );
  const hasExtraDistinguishingColumn = rawHeaders.some((h) => !coreMappedHeaders.has(h));

  let duplicatesRemoved = 0;
  if (hasExtraDistinguishingColumn) {
    const dedupResult = deduplicateTransactionsV2(normalized, cleanedRows);
    normalized = dedupResult.records;
    duplicatesRemoved = dedupResult.duplicatesRemoved;
  }

  // Step 7.7: Structural Validation — can values be parsed?
  const structResult = structuralValidate(normalized);
  normalized = structResult.records;

  // Step 7.8: Derive metrics AFTER structural validation so repaired
  // values (e.g., "12O0" → 1200) are used for derivation.
  const derivationReport = deriveMetricsReport(normalized);

  // Step 7.9: Business Validation — do parsed values make business sense?
  // Runs AFTER derivation so cross-field rules see derived fields.
  const bizResult = businessValidate(normalized);
  normalized = bizResult.records;
  const validForAnalytics = bizResult.businessValid;

  // Build combined quality report
  const qualityReport = {
    ...structResult.structuralReport,
    ...bizResult.businessReport,
    rowsUploaded: normalized.length,
    rowsParsed: normalized.length,
    rowsStructurallyValid: structResult.structuralReport.structurallyValid,
    rowsBusinessValid: bizResult.businessReport.businessValid,
    rowsUsedForAnalytics: validForAnalytics.length,
    rowsExcluded: normalized.length - validForAnalytics.length,
    structuralIssues: structResult.structuralReport.issueSummary,
    businessIssues: bizResult.businessReport.issueSummary,
    duplicatesRemoved,
  };

  // Strip internal metadata from records before persisting.
  for (const rec of normalized) {
    delete rec._derived;
    delete rec._structural;
    rec._quality = rec._quality ? {
      score: rec._quality.score,
      status: rec._quality.status,
      confidenceTier: rec._quality.confidenceTier,
      structurallyValid: rec._quality.structurallyValid,
      businessValid: rec._quality.businessValid,
      productClassification: rec._quality.productClassification,
      excludedMetrics: rec._quality.excludedMetrics,
      issues: rec._quality.issues,
    } : undefined;
  }

  // Step 8: Check confirmation need — only required fields block analysis.
  // Optional fields can be missing; the pipeline proceeds regardless.
  const requiredTiersIncomplete = Object.entries(tiers).some(
    ([cat, t]) => REQUIRED_FIELDS.has(cat) && t === 'confirm'
  );
  const missingRequired = unmappedRequired.length > 0;
  // Flag cost-mode ambiguity for user confirmation (like low-confidence column mappings)
  const costModeAmbiguous = costMode.costIsTotal === null || (costMode.confidence < 0.5 && costMode.costIsTotal != null);
  const needsConfirmation = requiredTiersIncomplete || missingRequired || costModeAmbiguous;

  // Step 9: Save mapping if auto-mapped
  if (pharmacyId && !needsConfirmation) {
    const mappingToSave = {};
    for (const [category, info] of Object.entries(mapping)) {
      mappingToSave[info.rawHeader] = category;
    }
    saveMapping(pharmacyId, rawHeaders, mappingToSave);
  }

  return {
    normalized, schema, mapping, tiers,
    unmapped: unmapped.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader })),
    unmappedRequired: unmappedRequired.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader })),
    unmappedOptional: unmappedOptional.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader })),
    mappedCategories: Object.keys(mapping),
    priceFulfilled,
    cleaningStats: {
      ...cleaningStats,
      duplicatesRemoved: (cleaningStats.duplicatesRemoved || 0) + duplicatesRemoved,
    },
    cleaningReport: cleaningReport.toJSON(),
    productNormalizationStats,
    needsConfirmation,
    derivationReport,
    qualityReport,
    identitySummary: identityResult.summary,
    costMode,
    validRecords: validForAnalytics,
    auditRecords: normalized.filter((r) => r._quality?.status === 'excluded'),
  };
}

/**
 * Full pipeline entry point for multi-sheet workbooks.
 */
function normalizeFromSheets(sheets, options = {}) {
  const { rows, meta: joinMeta } = joinSheets(sheets);

  if (joinMeta.joined && joinMeta.joined.includes('product')) {
    populateProductAttributes(rows);
  }

  if (rows.length === 0) {
    return {
      normalized: [], schema: [], mapping: {}, tiers: {},
      cleaningStats: { inputRows: 0, outputRows: 0 },
      cleaningReport: { summary: { totalRowsInput: 0, totalRowsOutput: 0 } },
      productNormalizationStats: null,
      needsConfirmation: false, joinMeta,
      validRecords: [], auditRecords: [],
    };
  }

  const result = normalize(rows, options);
  result.joinMeta = joinMeta;
  return result;
}

// ---- v2 helpers (use new canonical field names) -------------------------

function fillMissingValuesV2(records, mapping, tiers) {
  const canFabricateQty = hasTransactionCapability(mapping, tiers);
  return records.map((rec) => {
    const productName = rec.source_product_name || rec.product_name || 'Unknown';
    // Only default quantity to 1 when this is a confirmed transaction file
    // (date column at a reliable tier). Catalogs/snapshots keep null.
    const qty = rec.quantity != null ? rec.quantity : (canFabricateQty ? 1 : null);
    return {
      ...rec,
      source_product_name: rec.source_product_name || productName,
      product_name: productName,
      canonical_product: rec.canonical_product || productName,
      display_product: rec.display_product || rec.canonical_product || productName,
      quantity: qty,
    };
  });
}

function deduplicateTransactionsV2(records, rawRows) {
  const seen = new Set();
  const deduped = [];
  let duplicatesRemoved = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const raw = rawRows ? rawRows[i] : null;

    // Prefer hashing every column from the original uploaded row (minus
    // internal "_"-prefixed enrichment metadata added earlier in the
    // pipeline) — this naturally distinguishes real separate sales that
    // happen to share product/qty/price/date but differ in something else
    // in the row, from a genuinely duplicated row. Falls back to the
    // curated business-field key only if no raw row is available.
    const key = raw
      ? Object.keys(raw).sort().filter((k) => !k.startsWith('_')).map((k) => `${k}=${raw[k] ?? ''}`).join('|')
      : [
          rec.product_name ?? '',
          rec.quantity ?? '',
          rec.selling_price ?? '',
          rec.revenue ?? '',
          rec.cost_price ?? '',
          rec.transaction_date ?? '',
          rec.invoice_number ?? '',
          rec.customer ?? '',
        ].join('|');

    if (seen.has(key)) { duplicatesRemoved++; continue; }
    seen.add(key);
    deduped.push(rec);
  }
  return { records: deduped, duplicatesRemoved };
}

module.exports = { normalize, normalizeFromSheets };
