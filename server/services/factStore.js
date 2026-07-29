/**
 * Fact Store — accumulates normalized fact records across all uploads.
 *
 * Each dataset processor writes normalized facts into dedicated tables.
 * Re-processing a dataset REPLACES that dataset's own rows (keyed by
 * assetId) and leaves every other dataset untouched — so the store still
 * accumulates across different uploads, but never double-counts the same
 * one. The Widget Engine reads ALL facts from the store.
 *
 * Tables (logical, not separate Postgres tables — see below):
 *   FactSales     — rows from sales processor (transactions)
 *   FactInventory — rows from inventory processor (stock snapshots)
 *   DimProduct / DimCustomer / DimSupplier / DimDate — dimension rows
 *
 * Persistence: Postgres `widget_fact` table (was a shared JSON file). The
 * six logical tables above were always schema-less arrays of arbitrary JS
 * objects, so rather than forcing six rigid Postgres tables, every row
 * lives in one org-scoped table with a `table_name` discriminator and a
 * JSONB payload column — preserving the original flexibility.
 */

const { getSql, assertOrgId } = require('./db');

/**
 * Write normalized records into a fact table for ONE dataset.
 *
 * Replace semantics, scoped to the dataset (assetId) — not append. This
 * used to be a bare insert loop, so re-processing the same file stacked a
 * second full copy of its rows on top of the first and every dashboard
 * number reading from this store grew on each re-process. The star schema
 * (loadFactRecords in db.js) has always replaced its rows; this store
 * silently accumulated, so the two disagreed. Scoping the delete to the
 * assetId keeps OTHER datasets intact, which is the whole point of the
 * multi-dataset fact store.
 */
async function append(organizationId, tableName, records, assetId) {
  assertOrgId(organizationId);
  if (!Array.isArray(records) || records.length === 0) return 0;
  const db = getSql();

  if (assetId) {
    await db`
      delete from widget_fact
      where organization_id = ${organizationId} and table_name = ${tableName} and dataset_id = ${assetId}
    `;
  }

  // One multi-row insert per chunk instead of a query per record — the old
  // row-at-a-time loop took minutes on a real file over a network round
  // trip each time (~1,200 rows spanned ~4.5 minutes of ingest timestamps).
  const ingestedAt = new Date().toISOString();
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const rows = records.slice(i, i + CHUNK).map((rec) => ({
      organization_id: organizationId,
      table_name: tableName,
      dataset_id: assetId || null,
      payload: db.json({ ...rec, assetId, _ingestedAt: ingestedAt }),
    }));
    await db`insert into widget_fact ${db(rows, 'organization_id', 'table_name', 'dataset_id', 'payload')}`;
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Return all records from a fact table.
 */
async function query(organizationId, tableName) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select payload from widget_fact where organization_id = ${organizationId} and table_name = ${tableName}
  `;
  return rows.map((r) => r.payload);
}

/**
 * Return combined records from ALL fact tables (for widget engine).
 */
async function queryAll(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select payload from widget_fact where organization_id = ${organizationId}
  `;
  return rows.map((r) => r.payload);
}

/**
 * Return a summary of what's in the store.
 */
async function summary(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = await db`
    select table_name, count(*) as cnt from widget_fact
    where organization_id = ${organizationId}
    group by table_name
  `;
  const byTable = {};
  let totalRecords = 0;
  for (const r of rows) {
    byTable[r.table_name] = Number(r.cnt);
    totalRecords += Number(r.cnt);
  }
  return {
    FactSales: byTable.FactSales || 0,
    FactInventory: byTable.FactInventory || 0,
    totalRecords,
  };
}

/**
 * Get count of records in a table.
 */
async function count(organizationId, tableName) {
  assertOrgId(organizationId);
  const db = getSql();
  const [row] = await db`
    select count(*) as cnt from widget_fact where organization_id = ${organizationId} and table_name = ${tableName}
  `;
  return Number(row.cnt);
}

/**
 * Clear a table or all tables (for testing).
 */
async function clear(organizationId, tableName) {
  assertOrgId(organizationId);
  const db = getSql();
  if (tableName) {
    await db`delete from widget_fact where organization_id = ${organizationId} and table_name = ${tableName}`;
  } else {
    await db`delete from widget_fact where organization_id = ${organizationId}`;
  }
}

/**
 * Upsert a row into a dimension table, keyed by naturalKey (stored inside
 * the JSONB payload — Postgres's ->> operator extracts it for the match).
 * Repeated uploads with the same natural key update the record rather
 * than duplicating.
 */
async function upsertDimension(organizationId, tableName, record, naturalKey) {
  assertOrgId(organizationId);
  const db = getSql();
  const payload = { ...record, naturalKey, _ingestedAt: new Date().toISOString() };

  const [existing] = await db`
    select id from widget_fact
    where organization_id = ${organizationId} and table_name = ${tableName} and payload->>'naturalKey' = ${naturalKey}
  `;

  if (existing) {
    await db`update widget_fact set payload = ${db.json(payload)} where id = ${existing.id}`;
  } else {
    await db`
      insert into widget_fact (organization_id, table_name, payload)
      values (${organizationId}, ${tableName}, ${db.json(payload)})
    `;
  }
}

/**
 * Remove FactSales records for datasets where the classifier
 * (or hasTransactionCapability) says sales is NOT a capability.
 * Called on server startup and before multi-dataset widget evaluation.
 */
async function purgeStaleFactSales(organizationId) {
  assertOrgId(organizationId);
  try {
    const registry = require('./datasetRegistry');
    const db = getSql();

    const rows = await db`
      select id, payload->>'assetId' as "assetId" from widget_fact
      where organization_id = ${organizationId} and table_name = 'FactSales'
    `;
    const allIds = new Set(rows.map((r) => r.assetId).filter(Boolean));

    const nonSalesIds = new Set();
    for (const id of allIds) {
      const entry = await registry.get(organizationId, id);
      if (entry && entry.capabilities && entry.capabilities.sales === false) {
        nonSalesIds.add(id);
      }
    }

    if (nonSalesIds.size > 0) {
      const idsToRemove = rows.filter((r) => nonSalesIds.has(r.assetId)).map((r) => r.id);
      if (idsToRemove.length > 0) {
        await db`delete from widget_fact where id in ${db(idsToRemove)}`;
        console.log(`[factStore] purged ${idsToRemove.length} stale FactSales records`);
      }
    }
  } catch (_) { /* non-fatal */ }
}

module.exports = { append, query, queryAll, summary, count, clear, upsertDimension, purgeStaleFactSales };
