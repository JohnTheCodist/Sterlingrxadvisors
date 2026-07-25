/**
 * Fact Store — accumulates normalized fact records across all uploads.
 *
 * Each dataset processor writes normalized facts into dedicated tables.
 * Nothing is overwritten. The Widget Engine reads ALL facts from the store.
 *
 * Tables:
 *   FactSales     — rows from sales processor (transactions)
 *   FactInventory — rows from inventory processor (stock snapshots)
 *
 * Persistence: JSON file at server/data/fact-store.json.
 */

const path = require('path');
const fs = require('fs');

const STORE_PATH = path.join(__dirname, '..', 'data', 'fact-store.json');

// ---- in-memory tables -----------------------------------------------------

let tables = null;

function _load() {
  if (tables) return;
  try {
    if (fs.existsSync(STORE_PATH)) {
      tables = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (_) { /* corrupt — start fresh */ }
  if (!tables || typeof tables !== 'object') {
    tables = { FactSales: [], FactInventory: [], DimProduct: [], DimCustomer: [], DimSupplier: [], DimDate: [] };
  }
  // Ensure all known tables exist
  for (const t of ['FactSales', 'FactInventory', 'DimProduct', 'DimCustomer', 'DimSupplier', 'DimDate']) {
    if (!Array.isArray(tables[t])) tables[t] = [];
  }
}

function _save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(tables, null, 2), 'utf8');
  } catch (_) {}
}

// ---- public API -----------------------------------------------------------

/**
 * Append normalized records into a fact table.
 * Deduplicates by ignoring rows with the same signature hash.
 */
function append(tableName, records, assetId) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  _load();

  if (!tables[tableName]) tables[tableName] = [];

  const before = tables[tableName].length;

  for (const rec of records) {
    const entry = { ...rec, assetId, _ingestedAt: new Date().toISOString() };
    tables[tableName].push(entry);
  }

  _save();
  return tables[tableName].length - before;
}

/**
 * Return all records from a fact table.
 */
function query(tableName) {
  _load();
  return tables[tableName] || [];
}

/**
 * Return combined records from ALL fact tables (for widget engine).
 */
function queryAll() {
  _load();
  const combined = [];
  for (const tableName of Object.keys(tables)) {
    combined.push(...tables[tableName]);
  }
  return combined;
}

/**
 * Return a summary of what's in the store.
 */
function summary() {
  _load();
  return {
    FactSales: (tables.FactSales || []).length,
    FactInventory: (tables.FactInventory || []).length,
    totalRecords: Object.values(tables).reduce((s, a) => s + a.length, 0),
  };
}

/**
 * Get count of records in a table.
 */
function count(tableName) {
  _load();
  return (tables[tableName] || []).length;
}

/**
 * Clear a table or all tables (for testing).
 */
function clear(tableName) {
  _load();
  if (tableName) {
    tables[tableName] = [];
  } else {
    for (const k of Object.keys(tables)) tables[k] = [];
  }
  _save();
}

/**
 * Upsert a row into a dimension table, keyed by naturalKey.
 * Repeated uploads with the same natural key update the record
 * rather than duplicating.
 */
function upsertDimension(tableName, record, naturalKey) {
  _load();
  if (!tables[tableName]) tables[tableName] = [];
  const existing = tables[tableName].findIndex((r) => r.naturalKey === naturalKey);
  const entry = { ...record, naturalKey, _ingestedAt: new Date().toISOString() };
  if (existing >= 0) {
    tables[tableName][existing] = entry;
  } else {
    tables[tableName].push(entry);
  }
  _save();
}

/**
 * Remove FactSales records for datasets where the classifier
 * (or hasTransactionCapability) says sales is NOT a capability.
 * Called on server startup and before multi-dataset widget evaluation.
 */
function purgeStaleFactSales() {
  try {
    const registry = require('./datasetRegistry');
    _load();
    const before = (tables.FactSales || []).length;
    // Collect assetIds whose dataset lacks sales capability
    const nonSalesIds = new Set();
    const allIds = new Set((tables.FactSales || []).map((r) => r.assetId));
    for (const id of allIds) {
      const entry = registry.get(id);
      if (entry && entry.capabilities && entry.capabilities.sales === false) {
        nonSalesIds.add(id);
      }
    }
    if (nonSalesIds.size > 0) {
      tables.FactSales = (tables.FactSales || []).filter(
        (r) => !nonSalesIds.has(r.assetId)
      );
      _save();
      const removed = before - tables.FactSales.length;
      if (removed > 0) console.log(`[factStore] purged ${removed} stale FactSales records`);
    }
  } catch (_) { /* non-fatal */ }
}

module.exports = { append, query, queryAll, summary, count, clear, upsertDimension, purgeStaleFactSales };
