/**
 * Dataset Registry — persistent store for every uploaded dataset.
 *
 * Records metadata across the ingestion lifecycle:
 *   classified → schema_detected → mapped → processed
 *
 * Deduplication: SHA-256 fingerprint of first 64 KB + file size prevents
 * storing the same file twice, scoped per organization.
 *
 * Persistence: Postgres `dataset_registry` table (was a shared JSON file).
 * Well-known fields are real columns; anything else (e.g.
 * recommended_dashboards) lives in the schema-less `extra` JSONB column,
 * matching the flexibility the original spread-based JSON store had.
 */

const crypto = require('crypto');
const { getSql, assertOrgId } = require('./db');

const KNOWN_COLUMNS = new Set([
  'filename', 'mimeType', 'uploadTimestamp', 'capabilities', 'mappedColumns',
  'normalizedSchema', 'processingStatus', 'rowCount', 'sheetNames', 'fingerprint',
  'fileSize', 'mappingVersion', 'assetType', 'updatedAt',
]);

function computeFingerprint(buffer, filename) {
  const sampleSize = Math.min(buffer.length, 65536);
  const hash = crypto.createHash('sha256');
  hash.update(buffer.slice(0, sampleSize));
  hash.update(String(buffer.length));
  hash.update(filename);
  return hash.digest('hex').slice(0, 32);
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    datasetId: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    uploadTimestamp: row.upload_timestamp ? row.upload_timestamp.toISOString() : null,
    capabilities: row.capabilities,
    mappedColumns: row.mapped_columns,
    normalizedSchema: row.normalized_schema,
    processingStatus: row.processing_status,
    rowCount: row.row_count,
    sheetNames: row.sheet_names,
    fingerprint: row.fingerprint,
    fileSize: row.file_size != null ? Number(row.file_size) : null,
    mappingVersion: row.mapping_version,
    assetType: row.asset_type,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    ...(row.extra || {}),
  };
}

/**
 * Register a new dataset or return an existing one (for this organization)
 * if a duplicate is found.
 */
async function register(organizationId, { buffer, filename, mimeType }) {
  assertOrgId(organizationId);
  const db = getSql();
  const fingerprint = computeFingerprint(buffer, filename);

  const [existing] = await db`
    select * from dataset_registry where organization_id = ${organizationId} and fingerprint = ${fingerprint}
  `;
  if (existing) {
    return { ...rowToEntry(existing), isDuplicate: true };
  }

  const [inserted] = await db`
    insert into dataset_registry
      (organization_id, filename, mime_type, capabilities, mapped_columns, normalized_schema,
       processing_status, row_count, sheet_names, fingerprint, file_size, mapping_version, asset_type)
    values (
      ${organizationId}, ${filename}, ${mimeType}, null, null, null,
      'registered', null, ${db.json([])}, ${fingerprint}, ${buffer.length}, 1, null
    )
    returning *
  `;
  return { ...rowToEntry(inserted), isDuplicate: false };
}

/**
 * Update a registry entry — merges provided fields. Known fields map to
 * real columns; anything else is merged into the `extra` JSONB bucket.
 */
async function update(organizationId, datasetId, fields) {
  assertOrgId(organizationId);
  const db = getSql();

  const columnUpdates = {};
  const extraUpdates = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (KNOWN_COLUMNS.has(key)) columnUpdates[key] = value;
    else extraUpdates[key] = value;
  }

  const [row] = await db`
    update dataset_registry set
      filename = coalesce(${columnUpdates.filename ?? null}, filename),
      mime_type = coalesce(${columnUpdates.mimeType ?? null}, mime_type),
      capabilities = coalesce(${columnUpdates.capabilities ? db.json(columnUpdates.capabilities) : null}, capabilities),
      mapped_columns = coalesce(${columnUpdates.mappedColumns ? db.json(columnUpdates.mappedColumns) : null}, mapped_columns),
      normalized_schema = coalesce(${columnUpdates.normalizedSchema ? db.json(columnUpdates.normalizedSchema) : null}, normalized_schema),
      processing_status = coalesce(${columnUpdates.processingStatus ?? null}, processing_status),
      row_count = coalesce(${columnUpdates.rowCount ?? null}, row_count),
      sheet_names = coalesce(${columnUpdates.sheetNames ? db.json(columnUpdates.sheetNames) : null}, sheet_names),
      file_size = coalesce(${columnUpdates.fileSize ?? null}, file_size),
      mapping_version = coalesce(${columnUpdates.mappingVersion ?? null}, mapping_version),
      asset_type = coalesce(${columnUpdates.assetType ?? null}, asset_type),
      extra = extra || ${db.json(extraUpdates)},
      updated_at = now()
    where organization_id = ${organizationId} and id = ${datasetId}
    returning *
  `;
  return rowToEntry(row);
}

/**
 * Get a single dataset by ID.
 */
async function get(organizationId, datasetId) {
  assertOrgId(organizationId);
  const db = getSql();
  const [row] = await db`
    select * from dataset_registry where organization_id = ${organizationId} and id = ${datasetId}
  `;
  return rowToEntry(row);
}

/**
 * Get the most recent dataset (used when the client doesn't know the ID).
 */
async function getLatest(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();
  const [row] = await db`
    select * from dataset_registry
    where organization_id = ${organizationId}
    order by upload_timestamp desc
    limit 1
  `;
  return rowToEntry(row);
}

/**
 * List datasets, most recent first. Optional status filter.
 */
async function list(organizationId, { status, limit = 50 } = {}) {
  assertOrgId(organizationId);
  const db = getSql();
  const rows = status
    ? await db`
        select * from dataset_registry
        where organization_id = ${organizationId} and processing_status = ${status}
        order by upload_timestamp desc limit ${limit}
      `
    : await db`
        select * from dataset_registry
        where organization_id = ${organizationId}
        order by upload_timestamp desc limit ${limit}
      `;
  // Hide fingerprint in list view, matching the original behavior.
  return rows.map((row) => {
    const { fingerprint, ...rest } = rowToEntry(row);
    return rest;
  });
}

/**
 * Count datasets, optionally by status.
 */
async function count(organizationId, status) {
  assertOrgId(organizationId);
  const db = getSql();
  const [row] = status
    ? await db`select count(*) as cnt from dataset_registry where organization_id = ${organizationId} and processing_status = ${status}`
    : await db`select count(*) as cnt from dataset_registry where organization_id = ${organizationId}`;
  return Number(row.cnt);
}

/**
 * Check if a file would be a duplicate before uploading.
 */
async function wouldBeDuplicate(organizationId, buffer, filename) {
  assertOrgId(organizationId);
  const db = getSql();
  const fingerprint = computeFingerprint(buffer, filename);
  const [row] = await db`
    select 1 as found from dataset_registry where organization_id = ${organizationId} and fingerprint = ${fingerprint}
  `;
  return !!row;
}

/**
 * Increment the mappingVersion counter for a dataset — bumped each
 * time the user re-maps columns on the same file.
 */
async function incrementMappingVersion(organizationId, datasetId) {
  assertOrgId(organizationId);
  const db = getSql();
  const [row] = await db`
    update dataset_registry set mapping_version = coalesce(mapping_version, 1) + 1, updated_at = now()
    where organization_id = ${organizationId} and id = ${datasetId}
    returning *
  `;
  return rowToEntry(row);
}

module.exports = {
  register, update, get, getLatest, list, count, computeFingerprint, wouldBeDuplicate, incrementMappingVersion,
};
