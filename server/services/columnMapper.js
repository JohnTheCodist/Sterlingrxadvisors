/**
 * ColumnMapper — resolves schema detections into a concrete column mapping.
 *
 * Phase 1: Flexible Semantic Mapping Layer
 *
 * Responsibilities:
 *   1. Classify every column as MAPPED, OPTIONAL, or IGNORED.
 *   2. Resolve ambiguous columns (e.g., revenue vs selling_price).
 *   3. Support flexible product identity — no single PRODUCT column required.
 *   4. Classify each mapping by confidence tier (auto / review / confirm).
 *   5. Check domain requirements (product_identity, quantity, date, price).
 *   6. Persist and recall mappings per pharmacy/template.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  canonicalize, REQUIRED_FIELDS, PRICE_FIELDS,
  SEMANTIC_REGISTRY, PRODUCT_IDENTITY_FIELDS,
  DOMAIN_REQUIREMENTS,
  getClassification, resolveCanonical, CANONICAL_TO_SEMANTIC,
} = require('./dictionary');

const mappingStore = new Map();

function fingerprintHeaders(rawHeaders) {
  return rawHeaders
    .map((h) => String(h).toLowerCase().trim())
    .sort()
    .join('|');
}

/**
 * Generate a filesystem-safe filename segment from the header fingerprint.
 * When headers produce a long fingerprint (> 80 chars sanitized), the
 * resulting path would exceed OS limits, so we SHA1-hash it instead.
 * Short fingerprints (< 80 chars) are kept verbatim for backward
 * compatibility with existing mapping files.
 */
function fingerprintFilename(pharmacyId, rawHeaders) {
  const fp = fingerprintHeaders(rawHeaders);
  const sanitized = fp.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeId = pharmacyId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fpPart = sanitized.length <= 80
    ? sanitized
    : 'h_' + crypto.createHash('sha1').update(fp).digest('hex').slice(0, 20);
  return `${safeId}__${fpPart}.json`;
}

// ---- resolution --------------------------------------------------------

/**
 * @param {object[]} schemaColumns — from detectSchema()
 *   Each column: { rawHeader, normalizedHeader, detections[], ignored }
 * @returns {{
 *   mapping, tiers, unmapped, unmappedRequired, unmappedOptional,
 *   ignored, priceFulfilled, domainStatus, productIdentityFulfilled
 * }}
 */
function resolveMapping(schemaColumns) {
  const assignedCategories = new Set();
  const assignedColumns = new Set();
  const mapping = {};
  const unmapped = [];
  const ignored = [];       // Phase 1: columns matching IGNORED_PATTERNS

  // ---- Step 1: Separate ignored columns ----

  const activeColumns = [];
  for (const col of schemaColumns) {
    if (col.ignored) {
      ignored.push({
        rawHeader: col.rawHeader,
        normalizedHeader: col.normalizedHeader,
        reason: 'Irrelevant business column (notes, contact info, audit fields, etc.)',
      });
      continue;
    }
    activeColumns.push(col);
  }

  // ---- Step 2: Build candidate list from active columns ----

  const candidates = [];
  const candidateMap = new Map(); // rawHeader → candidates[]

  for (const col of activeColumns) {
    if (col.detections.length === 0) {
      unmapped.push({ ...col, reason: 'No category detected' });
      continue;
    }

    // Columns indicating margin/markup are financial ratios — leave unmapped
    if (/margin|markup/i.test(col.normalizedHeader)) {
      unmapped.push({ ...col, reason: 'Margin/markup column — not a price or cost' });
      continue;
    }

    const colCandidates = [];

    for (const det of col.detections) {
      let category = canonicalize(det.category);
      let confidence = det.confidence;
      const source = det.source;

      // Cost vs selling_price/revenue disambiguation via header text
      const isPurchaseCost = /(purchase|supplier|buying|acquisition)/i.test(col.normalizedHeader);
      const isSellingRelated = /(selling|sell\b|retail|margin|markup)/i.test(col.normalizedHeader);

      if ((category === 'revenue' || category === 'selling_price') && isPurchaseCost && !isSellingRelated) {
        const costDet = col.detections.find((d) => canonicalize(d.category) === 'cost_price');
        if (costDet && costDet.confidence > 0.3) {
          category = 'cost_price';
          confidence = costDet.confidence;
        }
      }

      // Resolve semantic key for classification
      const semanticKey = CANONICAL_TO_SEMANTIC[category];
      const classification = semanticKey ? getClassification(semanticKey) : 'optional';

      const candidate = {
        rawHeader: col.rawHeader,
        normalizedHeader: col.normalizedHeader,
        category,
        semanticKey,
        classification,
        confidence,
        source,
      };

      colCandidates.push(candidate);
      candidates.push(candidate);
    }

    candidateMap.set(col.rawHeader, colCandidates);
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  // ---- Step 3: Greedy assignment (highest confidence first) ----

  for (const c of candidates) {
    if (assignedCategories.has(c.category)) continue;
    if (assignedColumns.has(c.rawHeader)) continue;

    assignedCategories.add(c.category);
    assignedColumns.add(c.rawHeader);
    mapping[c.category] = {
      rawHeader: c.rawHeader,
      confidence: c.confidence,
      source: c.source,
      normalizedHeader: c.normalizedHeader,
      semanticKey: c.semanticKey,       // Phase 1
      classification: c.classification,  // Phase 1: mapped | optional
    };
  }

  // ---- Step 4: Collect unmapped active columns ----

  for (const col of activeColumns) {
    if (!assignedColumns.has(col.rawHeader) && col.detections.length > 0) {
      unmapped.push({ ...col, reason: 'All candidate categories already claimed' });
    }
  }

  // ---- Step 5: Confidence tiers ----

  const tiers = {};
  for (const [category, info] of Object.entries(mapping)) {
    if (info.confidence >= 0.95) {
      tiers[category] = 'auto';
    } else if (info.confidence >= 0.70) {
      tiers[category] = 'review';
    } else {
      tiers[category] = 'confirm';
    }
  }

  // ---- Step 6: Classify unmapped columns as required or optional ----

  const unmappedRequired = [];
  const unmappedOptional = [];

  for (const col of unmapped) {
    const targetsRequired = (col.detections || []).some(
      (d) => REQUIRED_FIELDS.has(canonicalize(d.category))
    );
    if (targetsRequired) {
      unmappedRequired.push(col);
    } else {
      unmappedOptional.push(col);
    }
  }

  // ---- Phase 1: Domain Requirement Checks ----

  const mappedCategories = Object.keys(mapping);
  const mappedSemanticKeys = new Set(
    mappedCategories.map((cat) => CANONICAL_TO_SEMANTIC[cat]).filter(Boolean)
  );

  // Check each domain requirement
  const domainStatus = DOMAIN_REQUIREMENTS.map((req) => {
    const matched = req.fields.filter((f) => mappedSemanticKeys.has(f));
    const satisfied = matched.length >= req.minMapped;
    return {
      domain: req.domain,
      label: req.label,
      required: req.fields,
      matched,
      minRequired: req.minMapped,
      satisfied,
      message: satisfied ? null : req.message,
    };
  });

  // Price requirement — no longer a gate; the client enforces price for sales dashboards.
  const priceFulfilled = true;

  // Product identity: any of the product identity fields mapped?
  const productIdentityFulfilled = PRODUCT_IDENTITY_FIELDS
    ? Array.from(PRODUCT_IDENTITY_FIELDS).some((f) => mappedSemanticKeys.has(f))
    : mappedCategories.includes('product_name');

  // ---- Step 7: needsConfirmation — only if required domains are missing ----

  const allDomainsSatisfied = domainStatus.every((d) => d.satisfied);
  const requiredTiersIncomplete = Object.entries(tiers).some(
    ([cat, t]) => REQUIRED_FIELDS.has(cat) && t === 'confirm'
  );
  const needsConfirmation = !allDomainsSatisfied || requiredTiersIncomplete;

  return {
    mapping,
    tiers,
    unmapped,
    unmappedRequired,
    unmappedOptional,
    ignored,                    // Phase 1: ignored columns
    priceFulfilled,
    domainStatus,               // Phase 1: per-domain satisfaction
    productIdentityFulfilled,   // Phase 1: flexible identity check
    needsConfirmation,
  };
}

// ---- persistence --------------------------------------------------------

const MAPPINGS_DIR = path.join(__dirname, '..', 'mappings');

function ensureMappingsDir() {
  if (!fs.existsSync(MAPPINGS_DIR)) {
    fs.mkdirSync(MAPPINGS_DIR, { recursive: true });
  }
}

function saveMapping(pharmacyId, rawHeaders, mapping) {
  ensureMappingsDir();
  const fp = fingerprintHeaders(rawHeaders);
  const key = `${pharmacyId}::${fp}`;
  const record = { pharmacyId, fingerprint: fp, mapping, savedAt: new Date().toISOString() };
  mappingStore.set(key, mapping);
  const filename = fingerprintFilename(pharmacyId, rawHeaders);
  fs.writeFileSync(
    path.join(MAPPINGS_DIR, filename),
    JSON.stringify(record, null, 2)
  );
}

function loadMapping(pharmacyId, rawHeaders) {
  const fp = fingerprintHeaders(rawHeaders);
  const key = `${pharmacyId}::${fp}`;

  if (mappingStore.has(key)) {
    const stored = mappingStore.get(key);
    return canonicalizeMapping(stored);
  }

  ensureMappingsDir();
  const filename = fingerprintFilename(pharmacyId, rawHeaders);
  let filePath = path.join(MAPPINGS_DIR, filename);
  // Backward compat: if the hash-based file doesn't exist, try the
  // old long-name scheme (files saved before the fingerprint-hash fix).
  if (!fs.existsSync(filePath)) {
    const legacyFilename = key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
    const legacyPath = path.join(MAPPINGS_DIR, legacyFilename);
    if (fs.existsSync(legacyPath)) filePath = legacyPath;
  }
  if (fs.existsSync(filePath)) {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const canon = canonicalizeMapping(record.mapping);
      mappingStore.set(key, canon);
      return canon;
    } catch (_) { return null; }
  }
  return null;
}

function canonicalizeMapping(mapping) {
  const out = {};
  for (const [header, category] of Object.entries(mapping)) {
    out[header] = canonicalize(category);
  }
  return out;
}

function loadPharmacyMappings(pharmacyId) {
  ensureMappingsDir();
  const results = [];
  const files = fs.readdirSync(MAPPINGS_DIR);
  for (const file of files) {
    if (file.startsWith(pharmacyId) && file.endsWith('.json')) {
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(MAPPINGS_DIR, file), 'utf-8')
        );
        results.push(record);
      } catch (_) {}
    }
  }
  return results;
}

module.exports = {
  resolveMapping,
  saveMapping,
  loadMapping,
  loadPharmacyMappings,
  canonicalizeMapping,
  hasTransactionCapability,
};

/**
 * Single shared gate: was any column mapped to the transaction_date category
 * at a reliable tier (auto or review, not uncertain-confirm)?
 *
 * All callers that decide sales-vs-not MUST use this one function.
 */
function hasTransactionCapability(mapping, tiers) {
  const dateMapping = (mapping && mapping['transaction_date']) || (mapping && mapping['date']);
  if (!dateMapping) return false;
  if (tiers) {
    return tiers['transaction_date'] === 'auto' || tiers['transaction_date'] === 'review' ||
           tiers['date'] === 'auto' || tiers['date'] === 'review';
  }
  // Fallback when tiers aren't available: check confidence directly
  return (dateMapping.confidence || 0) >= 0.70;
}
