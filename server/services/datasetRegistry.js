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
  'contentFingerprint', 'fileSize', 'mappingVersion', 'assetType', 'updatedAt',
]);

function computeFingerprint(buffer, filename) {
  const sampleSize = Math.min(buffer.length, 65536);
  const hash = crypto.createHash('sha256');
  hash.update(buffer.slice(0, sampleSize));
  hash.update(String(buffer.length));
  hash.update(filename);
  return hash.digest('hex').slice(0, 32);
}

/**
 * Identify a dataset by the rows it contains rather than the file that
 * carried them.
 *
 * computeFingerprint above answers "is this the same FILE?" — it hashes bytes
 * and the filename. That is the wrong question for deduplication, because the
 * same report exported twice is the same dataset while being a different file:
 * Excel rewrites internal metadata on every save, and a browser renames a
 * repeat download to "report (1).xlsx". Both used to register as new datasets,
 * and since every replace is scoped to one dataset_id, the earlier copy's rows
 * stayed behind and every total counted them twice.
 *
 * This hashes the parsed cells instead, and is deliberately blind to three
 * things that change without the data changing:
 *   - row order      — rows are hashed individually, then sorted
 *   - column order   — keys are sorted within each row
 *   - cell notation  — 100 and "100" and " 100 " agree; dates normalize to ISO
 *
 * It is NOT blind to case or to content: "Panadol" and "panadol" hash
 * differently, because treating them as one file would mean replacing data the
 * user may have meant to keep. Wrongly declaring two datasets identical
 * destroys rows, so every ambiguous case resolves toward "these are different".
 *
 * @param {Record<string, object[]>} sheets — parsed workbook, sheet name -> rows
 */
function computeContentFingerprint(sheets) {
  if (!sheets || typeof sheets !== 'object') return null;

  const cell = (v) => {
    if (v == null || v === '') return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const s = String(v).trim();
    if (s === '') return '';
    // "100", " 100 " and 100 must agree, or a re-export that changes cell
    // formatting would read as a different dataset.
    const n = Number(s);
    return Number.isFinite(n) && s !== '' ? String(n) : s;
  };

  const sheetHashes = [];
  for (const rows of Object.values(sheets)) {
    // A sheet with no rows contributes nothing to identity — otherwise two
    // unrelated workbooks could match on nothing but their shared empty tabs.
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const rowHashes = rows.map((row) => {
      // Trim BEFORE sorting. Sorting on the raw key orders " Product " and
      // "Product" differently, changing the hash — the exact padding
      // difference this is meant to see through.
      const parts = Object.keys(row || {})
        .map((k) => [String(k).trim(), cell(row[k])])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${k}\t${v}`);
      return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
    }).sort();

    const sh = crypto.createHash('sha256');
    sh.update(String(rows.length));
    for (const rh of rowHashes) sh.update(rh);
    sheetHashes.push(sh.digest('hex'));
  }
  if (sheetHashes.length === 0) return null;

  // Sheet names are excluded — a renamed tab is not a different dataset.
  sheetHashes.sort();
  const hash = crypto.createHash('sha256');
  for (const s of sheetHashes) hash.update(s);
  return hash.digest('hex').slice(0, 32);
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    datasetId: row.id,
    contentFingerprint: row.content_fingerprint,
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

  // Sending a file again IS a new upload event, even though it reuses the
  // existing row. Returning the old row untouched left its upload_timestamp
  // at whenever the file was FIRST seen, so re-uploading last week's file and
  // watching it process fine still did not make it the newest dataset — every
  // "your current upload" answer went on pointing at some other file.
  const [existing] = await db`
    update dataset_registry set upload_timestamp = now(), updated_at = now()
    where organization_id = ${organizationId} and fingerprint = ${fingerprint}
    returning *
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
      content_fingerprint = coalesce(${columnUpdates.contentFingerprint ?? null}, content_fingerprint),
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
 * Find a dataset by its content fingerprint.
 *
 * list() deliberately strips the fingerprint, so a caller holding a file and
 * wanting "have I seen this exact one before?" had to list every dataset and
 * then fetch each one individually to compare — up to 500 sequential queries
 * to locate a single indexed row. This answers it in one.
 */
async function findByFingerprint(organizationId, fingerprint) {
  assertOrgId(organizationId);
  if (!fingerprint) return null;
  const db = getSql();
  const [row] = await db`
    select * from dataset_registry
    where organization_id = ${organizationId} and fingerprint = ${fingerprint}
    limit 1
  `;
  return rowToEntry(row);
}

/**
 * Every OTHER dataset in this organization holding the same rows.
 *
 * Excludes `exceptId` — the dataset currently being processed — so the caller
 * gets exactly the stale copies that need clearing out, and can never be
 * handed the one it is about to write.
 */
async function findSupersededByContent(organizationId, contentFingerprint, exceptId = null) {
  assertOrgId(organizationId);
  if (!contentFingerprint) return [];
  const db = getSql();
  const rows = exceptId
    ? await db`
        select * from dataset_registry
        where organization_id = ${organizationId}
          and content_fingerprint = ${contentFingerprint}
          and id <> ${exceptId}
      `
    : await db`
        select * from dataset_registry
        where organization_id = ${organizationId}
          and content_fingerprint = ${contentFingerprint}
      `;
  return rows.map(rowToEntry);
}

/**
 * Delete a registry entry. Facts referencing it must already be gone — see
 * purgeDataset in db.js, which clears both fact tables first.
 */
async function remove(organizationId, datasetId) {
  assertOrgId(organizationId);
  const db = getSql();
  await db`delete from dataset_registry where organization_id = ${organizationId} and id = ${datasetId}`;
}

/**
 * Get the most recent dataset (used when the client doesn't know the ID).
 */
async function getLatest(organizationId) {
  assertOrgId(organizationId);
  const db = getSql();

  // "The current upload" means the newest file the owner can actually be
  // ASKED about, which is not the same as the newest row in this table. A file
  // whose mapping never completed sits here at 'schema_detected' carrying no
  // facts and no sale rows, and picking it made every scoped tool report that
  // the current upload has no readable fields — true of that row, and nothing
  // to do with the file the owner had just successfully uploaded.
  // Ordered by when the file was last SEEN, which is the later of when it
  // arrived and when it last finished processing. upload_timestamp alone is
  // not that: rows registered before re-uploads began refreshing it still
  // carry the date the file was first ever submitted, so a file re-uploaded
  // and successfully processed minutes ago can sit days down the list while
  // the dashboard — which renders the upload's own response — correctly shows
  // its numbers. The two disagreeing is exactly what makes the Advisor look
  // confused, so it reads the same event the dashboard does.
  const [processed] = await db`
    select * from dataset_registry
    where organization_id = ${organizationId} and processing_status = 'processed'
    order by greatest(upload_timestamp, coalesce(updated_at, upload_timestamp)) desc
    limit 1
  `;
  if (processed) return rowToEntry(processed);

  // Nothing has finished processing yet — a first upload mid-flight, or an
  // organization whose only files all failed. Fall back to the newest row so
  // callers still get a filename to talk about rather than null.
  const [any] = await db`
    select * from dataset_registry
    where organization_id = ${organizationId}
    order by upload_timestamp desc
    limit 1
  `;
  return rowToEntry(any);
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
  register, update, get, getLatest, list, count, computeFingerprint, findByFingerprint,
  computeContentFingerprint, findSupersededByContent, remove,
  wouldBeDuplicate, incrementMappingVersion,
};
