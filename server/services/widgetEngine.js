/**
 * Widget Engine — evaluates which widgets can run against a dataset, executes
 * them, and returns a manifest.
 *
 * Flow:
 *   1. Read available canonical fields from the records.
 *   2. For every widget in the registry, check if required fields are present.
 *   3. Execute widgets whose requirements are satisfied.
 *   4. Return a manifest grouped by dashboard with available/unavailable lists.
 */

const widgetRegistry = require('./widgetRegistry');

// ---- canonical field aliases (legacy backward compatibility) ----------------

const FIELD_ALIASES = {
  product_name: ['product', 'productname', 'product_name', 'product name'],
  quantity: ['quantity', 'qty', 'units', 'unitssold', 'units_sold', 'units sold'],
  selling_price: ['selling_price', 'sellingprice', 'price', 'unit_price', 'unitprice', 'unit price'],
  cost_price: ['cost_price', 'costprice', 'cost', 'unit_cost', 'unitcost', 'unit cost'],
  revenue: ['revenue', 'amount', 'total', 'revenueeur', 'revenue eur'],
  transaction_date: ['date', 'datekey', 'date_key', 'date key', 'transaction_date'],
  day: ['day', 'day_of_month', 'dayofmonth', 'day of month'],
  week: ['week', 'week_number', 'weeknumber', 'week number', 'iso_week', 'isoweek'],
  payment_method: ['payment_method', 'paymentmethod', 'payment', 'tender', 'payment method', 'mode of payment'],
  customer: ['customer', 'patient', 'client', 'customer_name', 'patient_name', 'customer name', 'patient name'],
  cashier: ['cashier', 'attendant', 'staff', 'dispenser', 'pharmacist', 'seller', 'served by'],
  supplier: ['supplier', 'vendor', 'manufacturer', 'source'],
  current_stock: ['current_stock', 'stock', 'closing_stock', 'closing', 'available', 'stock_level', 'stock level'],
  reorder_level: ['reorder_level', 'reorder', 'reorder_point', 'reorder point', 'minimum', 'min'],
  expiry_date: ['expiry_date', 'expiry', 'expiration', 'exp', 'best_before', 'use_by', 'expiry date'],
  category: ['category', 'product_category', 'productcategory', 'product category', 'subcategory', 'sub_category'],
};

/**
 * Build a set of available canonical field names from the records.
 *
 * A field is "available" only if (a) its key exists AND (b) at least one
 * record has a non-null, non-empty value for it. This prevents widgets
 * from running against fields that exist as null-initialized placeholders
 * (e.g., stock fields in a sales-only dataset).
 */
function detectAvailableFields(records) {
  if (!Array.isArray(records) || records.length === 0) return new Set();

  // Scan ALL records for keys — in multi-dataset mode, different rows may
  // have different columns (e.g. FactSales vs FactInventory fields).
  const allKeys = new Set();
  const keysWithData = new Set();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      const normKey = String(key).toLowerCase().trim();
      allKeys.add(normKey);
      // Only mark a key as "having data" if the value is not null/undefined/empty
      const val = rec[key];
      if (val != null && val !== '' && !(typeof val === 'number' && Number.isNaN(val))) {
        keysWithData.add(normKey);
      }
    }
  }
  const rawLower = [...allKeys];
  const available = new Set();

  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      // Field must both exist as a key AND have non-null data in at least one record
      if (rawLower.includes(alias) && keysWithData.has(alias)) {
        available.add(canonical);
        break;
      }
    }
  }

  return available;
}

/**
 * Check if ALL required fields are present in the available set.
 */
function meetsRequirements(widget, availableFields) {
  return widget.requiredFields.every((f) => availableFields.has(f));
}

/**
 * Safely execute a widget's compute function.
 */
function executeWidget(widget, records) {
  try {
    return widget.compute(records);
  } catch (err) {
    return { error: `Widget execution failed: ${err.message}` };
  }
}

/**
 * Evaluate all widgets against a dataset.
 *
 * @param {object[]} records — normalized record set
 * @returns {object} manifest
 */
function evaluate(records, options = {}) {
  const { dashboards: dashFilter } = options;
  const availableFields = detectAvailableFields(records);
  const allWidgets = widgetRegistry.getAll();
  let dashboards = widgetRegistry.getDashboards();
  // If the caller specifies which dashboards to activate, only evaluate those
  if (dashFilter && Array.isArray(dashFilter) && dashFilter.length > 0) {
    dashboards = dashboards.filter((d) => dashFilter.includes(d));
  }

  const manifest = {
    availableFields: [...availableFields],
    dashboards: {},
    summary: {
      totalWidgets: allWidgets.length,
      availableWidgets: 0,
      unavailableWidgets: 0,
    },
  };

  for (const dashboard of dashboards) {
    const dashWidgets = widgetRegistry.getByDashboard(dashboard);
    const available = [];
    const unavailable = [];

    for (const widget of dashWidgets) {
      const canRun = meetsRequirements(widget, availableFields);
      if (canRun) {
        const result = executeWidget(widget, records);
        available.push({
          id: widget.id,
          title: widget.title,
          description: widget.description || null,
          category: widget.category,
          priority: widget.priority,
          chartType: widget.chartType,
          format: widget.format || null,
          result,
        });
      } else {
        unavailable.push({
          id: widget.id,
          title: widget.title,
          description: widget.description || null,
          category: widget.category,
          priority: widget.priority,
          chartType: widget.chartType,
          missingFields: widget.requiredFields.filter((f) => !availableFields.has(f)),
        });
      }
    }

    // Sort available widgets by priority
    available.sort((a, b) => a.priority - b.priority);
    unavailable.sort((a, b) => a.priority - b.priority);

    manifest.dashboards[dashboard] = { available, unavailable };
    manifest.summary.availableWidgets += available.length;
    manifest.summary.unavailableWidgets += unavailable.length;
  }

  return manifest;
}

/**
 * Evaluate all widgets against ALL datasets currently in the Fact Store.
 * This enables multi-file intelligence — activating widgets whenever
 * required data exists across any registered dataset.
 */
async function evaluateFromStore(organizationId, options = {}) {
  const factStore = require('./factStore');
  // Purge stale FactSales records from datasets that are not sales-capable
  await factStore.purgeStaleFactSales(organizationId);
  const records = await factStore.queryAll(organizationId);
  return evaluate(records, options);
}

/**
 * Evaluate widgets from the Fact Store, filtered by dataset ID(s).
 */
async function evaluateFromDatasets(organizationId, datasetIds, options = {}) {
  const factStore = require('./factStore');
  const allRecords = await factStore.queryAll(organizationId);
  if (!Array.isArray(datasetIds) || datasetIds.length === 0) return evaluate(allRecords, options);
  const records = allRecords.filter((r) => datasetIds.includes(r.assetId));
  return evaluate(records, options);
}

module.exports = { evaluate, evaluateFromStore, evaluateFromDatasets, detectAvailableFields };
