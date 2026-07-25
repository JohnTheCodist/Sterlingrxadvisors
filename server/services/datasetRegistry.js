/**
 * Dataset Registry — persistent store for every uploaded dataset.
 *
 * Records metadata across the ingestion lifecycle:
 *   classified → schema_detected → mapped → processed
 *
 * Deduplication: SHA-256 fingerprint of first 64 KB + file size prevents
 * storing the same file twice.
 *
 * Persistence: JSON file at server/data/dataset-registry.json.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'dataset-registry.json');

// ---- persistence -----------------------------------------------------------

let _store = null;

function _load() {
  if (_store) return _store;
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      _store = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch (_) { /* corrupt file — start fresh */ }
  if (!_store || !Array.isArray(_store)) _store = [];
  return _store;
}

function _save() {
  try {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(_store, null, 2), 'utf8');
  } catch (_) { /* silently fail — store lives in memory */ }
}

// ---- fingerprint -----------------------------------------------------------

function computeFingerprint(buffer, filename) {
  const sampleSize = Math.min(buffer.length, 65536);
  const hash = crypto.createHash('sha256');
  hash.update(buffer.slice(0, sampleSize));
  hash.update(String(buffer.length));
  hash.update(filename);
  return hash.digest('hex').slice(0, 32);
}

// ---- public API ------------------------------------------------------------

/**
 * Register a new dataset or return an existing one if a duplicate is found.
 */
function register({ buffer, filename, mimeType }) {
  const store = _load();
  const fingerprint = computeFingerprint(buffer, filename);

  // Dedup check
  const existing = store.find((d) => d.fingerprint === fingerprint);
  if (existing) {
    return { ...existing, isDuplicate: true };
  }

  const now = new Date().toISOString();
  const entry = {
    datasetId: crypto.randomUUID(),
    filename,
    mimeType,
    uploadTimestamp: now,
    capabilities: null,
    mappedColumns: null,
    normalizedSchema: null,
    processingStatus: 'registered',
    rowCount: null,
    sheetNames: [],
    fingerprint,
    fileSize: buffer.length,
    branch: null,
    mappingVersion: 1,
    assetType: null,
    updatedAt: now,
  };

  store.push(entry);
  _save();
  return { ...entry, isDuplicate: false };
}

/**
 * Update a registry entry — merges provided fields.
 */
function update(datasetId, fields) {
  const store = _load();
  const idx = store.findIndex((d) => d.datasetId === datasetId);
  if (idx === -1) return null;

  store[idx] = { ...store[idx], ...fields, updatedAt: new Date().toISOString() };
  _save();
  return { ...store[idx] };
}

/**
 * Get a single dataset by ID.
 */
function get(datasetId) {
  const store = _load();
  return store.find((d) => d.datasetId === datasetId) || null;
}

/**
 * Get the most recent dataset (used when the client doesn't know the ID).
 */
function getLatest() {
  const store = _load();
  if (store.length === 0) return null;
  return store.reduce((a, b) =>
    new Date(a.uploadTimestamp) > new Date(b.uploadTimestamp) ? a : b
  );
}

/**
 * List datasets, most recent first. Optional status filter.
 */
function list({ status, limit = 50 } = {}) {
  let store = _load();
  if (status) store = store.filter((d) => d.processingStatus === status);
  return store
    .sort((a, b) => new Date(b.uploadTimestamp) - new Date(a.uploadTimestamp))
    .slice(0, limit)
    .map(({ fingerprint, ...rest }) => rest); // hide fingerprint in list view
}

/**
 * Count datasets, optionally by status.
 */
function count(status) {
  const store = _load();
  if (status) return store.filter((d) => d.processingStatus === status).length;
  return store.length;
}

/**
 * Check if a file would be a duplicate before uploading.
 */
function wouldBeDuplicate(buffer, filename) {
  const fingerprint = computeFingerprint(buffer, filename);
  const store = _load();
  return store.some((d) => d.fingerprint === fingerprint);
}

/**
 * Clear the registry (for testing).
 */
function _clear() {
  _store = [];
  try { fs.unlinkSync(REGISTRY_PATH); } catch (_) {}
}

/**
 * Increment the mappingVersion counter for a dataset — bumped each
 * time the user re-maps columns on the same file.
 */
function incrementMappingVersion(datasetId) {
  const store = _load();
  const idx = store.findIndex((d) => d.datasetId === datasetId);
  if (idx === -1) return null;
  store[idx].mappingVersion = (store[idx].mappingVersion || 1) + 1;
  store[idx].updatedAt = new Date().toISOString();
  _save();
  return { ...store[idx] };
}

module.exports = { register, update, get, getLatest, list, count, computeFingerprint, wouldBeDuplicate, incrementMappingVersion, _clear };
