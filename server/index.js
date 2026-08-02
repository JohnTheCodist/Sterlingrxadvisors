const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const fs = require('fs');
const multer = require('multer');
const { normalize, normalizeFromSheets } = require('./services/normalizer');
const { analyze } = require('./services/analytics');
const { detectSchema, mergeLlmResults, checkMappingCoherence } = require('./services/schemaDetector');
const { resolveMapping, saveMapping, loadMapping, loadPharmacyMappings } = require('./services/columnMapper');
const { recordMapping } = require('./services/columnAlias');
const { loadFactRecords, queryAnalytics, populateProductAttributes, getSql, computeProductNaturalKey, purgeDataset, getActiveConversationId, startNewConversation, listConversations, resolveOwnedConversationId, getConversationMessages, appendAdvisorMessage, getMembershipsForUser } = require('./services/db');
const { validate } = require('./services/validator');
const { joinSheets } = require('./services/sheetJoiner');
const { profitByCategory, abcAnalysis, abcSummary, fastSlowMovers, fastSlowSummary, expirySummary, inventoryTurnover } = require('./services/insights');
const { mapColumns, isLlmAvailable, getLlmConfig } = require('./services/llmMapper');
const { computeAllMetrics } = require('./services/metrics');
const { analyzeMetrics } = require('./services/analysisAgent');
const { FIELD_METADATA, buildFieldOptions, REQUIRED_FIELDS } = require('./services/dictionary');
const { scoreBusinessHealth } = require('./services/businessHealth');
const { generateInsights } = require('./services/recommendations');
const { computeHealthStats } = require('./services/businessHealthData');
const { classifyDataset } = require('./services/datasetClassifier');
const datasetRegistry = require('./services/datasetRegistry');
const { evaluate: evaluateWidgets, evaluateFromStore } = require('./services/widgetEngine');
const { hasTransactionCapability } = require('./services/columnMapper');
const factStore = require('./services/factStore');
const { chatStream: advisorChatStream } = require('./services/advisorAgent');
const advisorQueries = require('./services/advisorQueries');
const { buildDashboardPdf, fmtN, fmtNum } = require('./services/reports/dashboardPdfReport');
const { requireAuth, requireAuthOnly } = require('./middleware/auth');
const { ALLOWED_MIMES, ALLOWED_EXTS, parseSheet } = require('./services/fileUpload');
const { verifyTwilioSignature } = require('./services/whatsapp/twilioSignature');
const { handleIncomingWhatsapp, servePdfExport } = require('./services/whatsapp/webhookHandler');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---------- Multer config ----------

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIMES.includes(file.mimetype) || ALLOWED_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`"${file.originalname}" is not allowed. Only .xlsx and .csv files are accepted.`));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const uploadFields = upload.fields([
  { name: 'sales', maxCount: 1 },
  { name: 'inventory', maxCount: 1 },
]);
const uploadSingle = upload.single('file');
const uploadBatch = upload.array('files', 20);

// In-memory store for contact form submissions
const submissions = [];

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------- Auth gate ----------
//
// Everything under /api/* requires a verified Supabase session and a real
// organization membership, EXCEPT: health (above, already handled before
// this middleware runs), contact (public marketing form), and organization
// creation (a brand-new user has no membership yet — that's the point of
// this endpoint).
const PUBLIC_API_PATHS = new Set(['/contact']);
app.use('/api', (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (req.path === '/organizations' && req.method === 'POST') return requireAuthOnly(req, res, next);
  return requireAuth(req, res, next);
});

// ---------- WhatsApp (Twilio) — outside /api, not subject to requireAuth ----------
//
// An incoming WhatsApp message carries no Supabase bearer token, so it can't
// pass through the auth gate above. verifyTwilioSignature is the real
// security boundary for these two public routes instead.
app.post('/webhooks/whatsapp', express.urlencoded({ extended: false }), verifyTwilioSignature, handleIncomingWhatsapp);
app.get('/pdf/whatsapp/:id', servePdfExport);

// ---------- Organizations ----------

/**
 * Rejects a state weather could not resolve. Checked against the weather
 * service's own map rather than a list maintained beside a form — two lists
 * drift, and the failure that follows is silent.
 *
 * @returns {string|null} an error message, or null when the value is fine.
 */
function validateState(state) {
  if (state == null || state === '') return null;
  const { RESOLVABLE_STATES } = require('./services/weather/weatherService');
  if (!RESOLVABLE_STATES.includes(state)) {
    return `"${state}" is not a Nigerian state we can look up weather for. Pick one from the list.`;
  }
  return null;
}

app.post('/api/organizations', async (req, res) => {
  const { name, state } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required.' });
  }
  if (state != null && typeof state !== 'string') {
    return res.status(400).json({ error: 'state must be a string.' });
  }
  const badState = validateState(state);
  if (badState) return res.status(400).json({ error: badState });

  try {
    const db = getSql();

    // Idempotency backstop. This route used to create an organization
    // unconditionally, so anything that sent a user back to /onboarding
    // when they already had a pharmacy — most commonly a transient
    // /api/organizations/me failure being read as "no organization" —
    // silently minted a duplicate, empty organization and stranded the
    // user's real data in the old one. A user has exactly one
    // organization in v1, so return the existing one instead of ever
    // creating a second.
    const existing = await getMembershipsForUser(req.user.id);
    if (existing.length > 0) {
      const membership = existing[0];
      const [org] = await db`select id, name from organizations where id = ${membership.organization_id}`;
      return res.status(200).json({ organizationId: org.id, name: org.name, role: membership.role });
    }

    const [org] = await db`insert into organizations (name) values (${name.trim()}) returning id, name`;
    await db`insert into organization_members (organization_id, user_id, role) values (${org.id}, ${req.user.id}, 'owner')`;

    // Signup collects the state, so write it straight into the same profile
    // row Settings edits and the weather signal reads. Doing it here rather
    // than asking again later is the whole point of collecting it at signup.
    if (state) {
      await require('./services/pharmacyProfile').update(org.id, { state });
    }

    return res.status(201).json({ organizationId: org.id, name: org.name, role: 'owner', state: state || null });
  } catch (err) {
    return res.status(500).json({ error: `Failed to create organization: ${err.message}` });
  }
});

// requireAuth already resolved req.organizationId/req.organizationRole from
// real membership — this just returns the org's name for display, since
// the frontend has no other way to learn "what organization am I in."
app.get('/api/organizations/me', async (req, res) => {
  try {
    const db = getSql();
    const [org] = await db`select id, name from organizations where id = ${req.organizationId}`;
    return res.json({ organizationId: req.organizationId, name: org?.name || null, role: req.organizationRole });
  } catch (err) {
    return res.status(500).json({ error: `Failed to load organization: ${err.message}` });
  }
});

// ---------- Dataset Registry (metadata for every uploaded dataset) ----------

app.get('/api/datasets', async (req, res) => {
  const status = req.query.status || null;
  const limit = parseInt(req.query.limit) || 50;
  return res.json(await datasetRegistry.list(req.organizationId, { status, limit }));
});

app.get('/api/datasets/:id', async (req, res) => {
  const entry = await datasetRegistry.get(req.organizationId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'Dataset not found.' });
  return res.json(entry);
});

app.get('/api/datasets/latest', async (req, res) => {
  const entry = await datasetRegistry.getLatest(req.organizationId);
  if (!entry) return res.status(404).json({ error: 'No datasets registered.' });
  return res.json(entry);
});

// ---------- Widget Engine --------------------------------------------------

// Accept raw records OR read from fact store for multi-dataset evaluation.
app.post('/api/widgets', async (req, res) => {
  const records = req.body?.records;
  // If explicit records passed, use them directly — no DB access needed.
  if (Array.isArray(records) && records.length > 0) {
    return res.json(evaluateWidgets(records));
  }
  // Scoped to the current upload by default, same as /api/analytics —
  // ?scope=all asks for the organization's full history explicitly.
  const { evaluateFromStore } = require('./services/widgetEngine');
  const manifest = await evaluateFromStore(req.organizationId, { scope: req.query.scope });
  // Stamped the same way /api/analytics already is, so the client can label
  // what it's showing rather than silently swapping the KPI grid's numbers
  // to a wider scope with nothing on screen explaining why they changed.
  return res.json({ ...manifest, scope: req.query.scope === 'all' ? 'all' : 'current-upload' });
});

// ---------- Dataset Classification (runs before schema detection) ----------

app.post('/api/classify-dataset', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    try {
      // Store for later use by inventory/supplier/expiry dashboards
      setLastUpload(req.organizationId, file.buffer, file.mimetype);

      const sheets = parseSheet(file.buffer);
      const sheetKeys = Object.keys(sheets);
      const rows = sheetKeys.length > 0 ? sheets[sheetKeys[0]] : [];

      if (rows.length === 0) {
        return res.json({
          primary_type: 'unknown',
          confidence: 0,
          capabilities: { sales: false, inventory: false, expiry: false, supplier: false, customer: false },
          recommended_dashboards: [],
          dataset_type: 'unknown',
          reasons: ['The file contains no data rows.'],
          fileName: file.originalname,
          sheetName: null,
          rowCount: 0,
        });
      }

      const classification = classifyDataset(rows);

      // Register in the Dataset Registry (dedup-aware)
      const reg = await datasetRegistry.register(req.organizationId, {
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      });
      if (!reg.isDuplicate) {
        await datasetRegistry.update(req.organizationId, reg.datasetId, {
          processingStatus: 'classified',
          capabilities: classification.capabilities,
          recommended_dashboards: classification.recommended_dashboards,
          rowCount: rows.length,
          sheetNames: sheetKeys,
          assetType: classification.primary_type,
        });
      }

      return res.json({
        ...classification,
        fileName: file.originalname,
        sheetName: sheetKeys[0] || null,
        rowCount: rows.length,
        datasetId: reg.datasetId,
      });
    } catch (parseErr) {
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }
  });
});

// ---------- Batch Classify (multi-file support) --------------------------------

app.post('/api/classify-batch', (req, res) => {
  uploadBatch(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files received.' });
    }

    const results = [];
    for (const file of files) {
      try {
        const sheets = parseSheet(file.buffer);
        const sheetKeys = Object.keys(sheets);
        const rows = sheetKeys.length > 0 ? sheets[sheetKeys[0]] : [];
        const classification = classifyDataset(rows);
        const reg = await datasetRegistry.register(req.organizationId, {
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype,
        });
        if (!reg.isDuplicate) {
          await datasetRegistry.update(req.organizationId, reg.datasetId, {
            processingStatus: 'classified',
            capabilities: classification.capabilities,
            recommended_dashboards: classification.recommended_dashboards,
            rowCount: rows.length,
            sheetNames: sheetKeys,
            assetType: classification.primary_type,
          });
        }
        results.push({
          ...classification,
          fileName: file.originalname,
          sheetName: sheetKeys[0] || null,
          rowCount: rows.length,
          datasetId: reg.datasetId,
        });
      } catch (parseErr) {
        results.push({
          fileName: file.originalname,
          error: `Failed to parse: ${parseErr.message}`,
        });
      }
    }

    return res.json({ files: results, totalFiles: files.length });
  });
});

// ---------- Inventory Analytics -------------------------------------------------

// In-memory store for the last uploaded file, per organization (a plain
// module-global would leak one tenant's file into another tenant's
// inventory-analytics call).
const lastUploadByOrg = new Map();
function setLastUpload(organizationId, buffer, mimeType) {
  lastUploadByOrg.set(organizationId, { buffer, mimeType });
}
function getLastUpload(organizationId) {
  return lastUploadByOrg.get(organizationId) || null;
}

app.post('/api/inventory-analytics', (req, res) => {
  const existing = getLastUpload(req.organizationId);
  if (!existing) {
    // If no file in memory, accept a new upload
    uploadSingle(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file received.' });
      setLastUpload(req.organizationId, file.buffer, file.mimetype);
      return runInventoryAnalysis(file.buffer, res);
    });
    return;
  }
  return runInventoryAnalysis(existing.buffer, res);
});

function runInventoryAnalysis(buffer, res) {
  try {
    const sheets = parseSheet(buffer);
    const sheetKeys = Object.keys(sheets);
    const rows = sheetKeys.length > 0 ? sheets[sheetKeys[0]] : [];

    if (rows.length === 0) {
      return res.json({ error: 'No data rows found.', stockMetrics: { totalProducts: 0, lowStockCount: 0, expiringSoon: 0 }, products: [], suppliers: [] });
    }

    const headers = Object.keys(rows[0]);

    // Detect column roles by header names
    const findCol = (patterns) => {
      return headers.find((h) => {
        const norm = h.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        return patterns.some((p) => p.test(norm));
      });
    };

    const nameCol = findCol([/\bproduct\b.*\bname\b|\bname\b.*\bproduct\b|\bproduct\b|\bdescription\b/i]) || findCol([/\bitem\b|\bdrug\b/i]);
    const stockCol = findCol([/\bstock\b.*\blevel\b|\bstock\b|\bclosing\b|\bavailable/i]);
    const openingCol = findCol([/\bopening\b/i]);
    const reorderCol = findCol([/\breorder\b|\bre.?order/i]);
    const maxCol = findCol([/\bmaximum\b|\bmax\b/i]);
    const supplierCol = findCol([/\bsupplier\b|\bvendor\b|\bmanufacturer\b/i]);
    const expiryCol = findCol([/\bexpir(?:y|ation|e)\b|\bexp\b|\bbest.?before/i]);
    const batchCol = findCol([/\bbatch\b|\blot\b/i]);

    const products = [];
    const supplierMap = {};
    let lowStockCount = 0;
    let expiringSoon = 0;
    const now = new Date();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    for (const row of rows) {
      const name = nameCol ? String(row[nameCol] || 'Unknown').trim() : 'Unknown';
      const stock = stockCol ? parseInt(row[stockCol], 10) || 0 : (openingCol ? parseInt(row[openingCol], 10) || 0 : 0);
      const reorder = reorderCol ? parseInt(row[reorderCol], 10) || null : null;
      const maxStock = maxCol ? parseInt(row[maxCol], 10) || null : null;
      const supplier = supplierCol ? String(row[supplierCol] || '').trim() : null;
      const expiryRaw = expiryCol ? row[expiryCol] : null;
      const batch = batchCol ? String(row[batchCol] || '').trim() : null;

      let expiryDate = null;
      let expiryUrgent = false;
      if (expiryRaw) {
        try {
          expiryDate = new Date(expiryRaw);
          if (!isNaN(expiryDate.getTime())) {
            expiryDate = expiryDate.toISOString().substring(0, 10);
            if (expiryDate && new Date(expiryDate).getTime() - now.getTime() < ninetyDays) {
              expiryUrgent = true;
              expiringSoon++;
            }
          }
        } catch { expiryDate = null; }
      }

      if (stock <= (reorder || 0)) lowStockCount++;

      products.push({
        name,
        stock,
        reorderLevel: reorder,
        maxLevel: maxStock,
        supplier,
        expiryDate,
        expiryUrgent,
        batch,
      });

      if (supplier) {
        if (!supplierMap[supplier]) supplierMap[supplier] = { name: supplier, productCount: 0 };
        supplierMap[supplier].productCount++;
      }
    }

    return res.json({
      stockMetrics: { totalProducts: products.length, lowStockCount, expiringSoon },
      products,
      suppliers: Object.values(supplierMap),
    });
  } catch (err) {
    return res.status(400).json({ error: `Failed to analyze inventory: ${err.message}` });
  }
}

// ---------- Schema Detection (step 1: detect columns, return to client) ----------
// Now integrates LLM-powered mapping when LLM_API_KEY is configured.

app.post('/api/detect-schema', async (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    try {
      const sheets = parseSheet(file.buffer);

      // Auto-join dimension tables if present
      const { rows, meta: joinMeta } = joinSheets(sheets);

      if (rows.length === 0) {
        return res.status(400).json({ error: 'The file contains no data rows.' });
      }

      const rawHeaders = Object.keys(rows[0]);

      // Run rule-based schema detection on joined rows
      let schema = detectSchema(rows);

      // Try LLM-powered mapping if available
      let llmSource = null;
      let llmColumns = null;
      if (isLlmAvailable()) {
        try {
          const sampleSize = Math.min(rows.length, 30);
          const sampleRows = rows.slice(0, sampleSize);
          const sampleValues = rawHeaders.map((h) => sampleRows.map((r) => r[h]));

          const llmResult = await mapColumns(rawHeaders, sampleValues);
          llmSource = llmResult.source;
          llmColumns = llmResult.columns;

          // Merge LLM results into schema
          if (llmColumns && llmColumns.length > 0) {
            schema = mergeLlmResults(schema, llmColumns);
          }
        } catch (llmErr) {
          console.warn('[detect-schema] LLM mapping failed, using rule-based only:', llmErr.message);
        }
      }

      // Resolve once to learn which column each field landed on, check that
      // set against the actual rows, then resolve again on the adjusted
      // confidences. Coherence can only be judged after an assignment exists —
      // "is cost below selling price?" is not a question about either column
      // alone — and its verdict moves columns between the auto/review tiers,
      // so the second pass is what actually applies it. resolveMapping is a
      // pure function over the schema, so running it twice costs nothing.
      const provisional = resolveMapping(schema);
      const coherence = checkMappingCoherence(schema, provisional.mapping, rows);
      schema = coherence.columns;

      // Resolve mapping
      const {
        mapping, tiers, unmapped, unmappedRequired, unmappedOptional, priceFulfilled,
        ignored, domainStatus, productIdentityFulfilled, needsConfirmation,
      } = resolveMapping(schema);

      // Check for saved mapping
      const savedMapping = await loadMapping(req.organizationId, rawHeaders);

      // Build response: for each column, show detections, current mapping, and classification
      const columns = schema.map((col) => {
        const mappedCategory = Object.entries(mapping).find(
          ([_, info]) => info.rawHeader === col.rawHeader
        );
        const bestGuess = col.detections && col.detections.length > 0 ? col.detections[0] : null;
        const alternatives = col.detections
          ? col.detections.slice(1, 4).filter(d => d.category !== (mappedCategory ? mappedCategory[0] : null))
          : [];
        return {
          rawHeader: col.rawHeader,
          normalizedHeader: col.normalizedHeader,
          detections: col.detections,
          // A few real sample values, sent back to /api/reinterpret-column
          // if the user later describes this column in their own words.
          sampleValues: rows.slice(0, 5).map((r) => r[col.rawHeader]).filter((v) => v != null && v !== ''),
          mappedTo: mappedCategory ? mappedCategory[0] : null,
          bestGuess: bestGuess ? { category: bestGuess.category, confidence: bestGuess.confidence } : null,
          alternatives: alternatives.map(a => ({ category: a.category, confidence: a.confidence })),
          tier: mappedCategory ? tiers[mappedCategory[0]] : 'confirm',
          classification: mappedCategory ? mapping[mappedCategory[0]].classification : (col.ignored ? 'ignored' : undefined),
          semanticKey: mappedCategory ? mapping[mappedCategory[0]].semanticKey : undefined,
          ignored: col.ignored || false,
        };
      });

      // Update the Dataset Registry with schema detection results
      const fp = datasetRegistry.computeFingerprint(file.buffer, file.originalname);
      const entry = await datasetRegistry.findByFingerprint(req.organizationId, fp);
      if (entry) {
        await datasetRegistry.update(req.organizationId, entry.datasetId, {
          processingStatus: 'schema_detected',
          sheetNames: Object.keys(sheets),
          rowCount: rows.length,
        });
      }

      return res.json({
        fileName: file.originalname,
        sheetName: Object.keys(sheets)[0] || null,
        rowCount: rows.length,
        joinMeta,
        columns,
        savedMapping: savedMapping || null,
        needsConfirmation,
        unmapped: unmapped.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader })),
        unmappedRequired: unmappedRequired.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader })),
        unmappedOptional: unmappedOptional.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader })),
        // Phase 1: ignored columns (notes, contact info, audit fields, etc.)
        ignored: ignored.map((c) => ({ rawHeader: c.rawHeader, normalizedHeader: c.normalizedHeader, reason: c.reason })),
        mappedCategories: Object.keys(mapping),
        priceFulfilled,
        // Phase 1: domain-level requirements
        domainStatus,
        productIdentityFulfilled,
        fieldMeta: FIELD_METADATA,
        fieldOptions: buildFieldOptions(),
        llm: {
          used: !!llmSource,
          source: llmSource || 'rule-based',
          config: isLlmAvailable() ? getLlmConfig() : null,
        },
        // What the mapping was checked against once assembled, and what those
        // checks found. Surfaced so the review screen can say WHY a column
        // needs a second look ("cost is above selling price on 94% of rows")
        // rather than only that its confidence happens to be low.
        coherenceChecks: coherence.checks,
      });
    } catch (parseErr) {
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }
  });
});

// ---------- LLM Mapping Status ----------

app.get('/api/llm-status', (req, res) => {
  res.json({
    available: isLlmAvailable(),
    config: getLlmConfig(),
  });
});

// ---------- Column re-interpretation (user-supplied hint, escape hatch) ----------
// Used when neither of a column's top-2 algorithmic guesses is correct. The
// user describes the column in plain language instead of picking from a
// full field list; the LLM re-reads the column with that hint as the
// strongest signal. Below-threshold or unavailable LLM -> treated as no
// match so the caller skips the column rather than force a weak guess.
const REINTERPRET_MIN_CONFIDENCE = 0.55;

app.post('/api/reinterpret-column', async (req, res) => {
  const { rawHeader, sampleValues, hint } = req.body || {};
  if (!rawHeader || !hint || !String(hint).trim()) {
    return res.status(400).json({ error: 'rawHeader and hint are required.' });
  }
  try {
    const { reinterpretColumn } = require('./services/llmMapper');
    const result = await reinterpretColumn(rawHeader, Array.isArray(sampleValues) ? sampleValues : [], hint);
    if (!result.category || result.confidence < REINTERPRET_MIN_CONFIDENCE) {
      return res.json({ matched: false });
    }
    return res.json({ matched: true, category: result.category, confidence: result.confidence });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Re-interpretation failed.' });
  }
});

// ---------- Pharmacy Profile (v1: single-location, used for weather lookups) ----------

app.get('/api/pharmacy-profile', async (req, res) => {
  res.json(await require('./services/pharmacyProfile').get(req.organizationId));
});

app.post('/api/pharmacy-profile', async (req, res) => {
  const { state, city } = req.body || {};
  if (state != null && typeof state !== 'string') {
    return res.status(400).json({ error: 'state must be a string.' });
  }
  // Only a string was checked before, so any typo was accepted and stored —
  // and then reached OpenWeather as an ungeocodable name, which is a weather
  // signal that just stops appearing with nothing to explain why. Rejecting
  // it here means a stored state is always one weather can resolve.
  const badState = validateState(state);
  if (badState) return res.status(400).json({ error: badState });

  const fields = {};
  if (state !== undefined) fields.state = state;
  if (city !== undefined) fields.city = city;
  res.json(await require('./services/pharmacyProfile').update(req.organizationId, fields));
});

// ---------- NAFDAC Database Status (shared reference data, not tenant-scoped) ----------

app.get('/api/nafdac-status', (req, res) => {
  const { getNafdacStatus } = require('./services/nafdacLookup');
  res.json(getNafdacStatus());
});

// ---------- NAFDAC Database Reload (production hot-reload) ----------

app.post('/api/reload-nafdac', (req, res) => {
  try {
    const { loadNafdac, getNafdacStatus } = require('./services/nafdacLookup');
    const result = loadNafdac();
    if (result.success) {
      res.json({ success: true, ...getNafdacStatus(), message: `Reloaded ${result.totalRecords} NAFDAC records` });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Confirm Mapping (step 2: user confirms/overrides, then normalize) ----------

app.post('/api/confirm-mapping', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    const organizationId = req.organizationId;

    // Parse user mapping from body (comes as JSON string)
    let userMapping = {};
    try {
      userMapping = typeof req.body.mapping === 'string'
        ? JSON.parse(req.body.mapping)
        : (req.body.mapping || {});
    } catch (_) {
      return res.status(400).json({ error: 'Invalid mapping format. Must be a JSON object.' });
    }

    // Which columns the user personally decided. Sent separately from the
    // mapping itself because the mapping also contains columns that were
    // auto-accepted without anyone looking — recording those as though a human
    // had confirmed them would turn a detector guess into permanent memory.
    let reviewStatuses = {};
    try {
      reviewStatuses = typeof req.body.reviewStatuses === 'string'
        ? JSON.parse(req.body.reviewStatuses)
        : (req.body.reviewStatuses || {});
    } catch (_) {
      reviewStatuses = {}; // absent or malformed: record nothing, never guess
    }

    // Stage timing. A slow upload is almost always one stage, and without
    // this the only way to find out which is to guess and re-measure — so
    // every stage that can touch the network or the database is timed, and
    // the breakdown is logged once at the end.
    const timings = [];
    const timed = async (label, fn) => {
      const t0 = Date.now();
      try { return await fn(); }
      finally { timings.push([label, Date.now() - t0]); }
    };

    try {
      const sheets = await timed('parseSheet', async () => parseSheet(file.buffer));

      // Auto-join dimension tables and normalize
      const result = await timed('normalizeFromSheets', () =>
        normalizeFromSheets(sheets, { organizationId, userMapping }));

      if (result.normalized.length === 0) {
        return res.status(400).json({ error: 'The file contains no processable data rows.' });
      }

      // Resolve the registry entry BEFORE persisting — loadFactRecords needs
      // the dataset id to replace this file's own rows rather than stack a
      // duplicate set on top of them when the same file is processed again.
      const fp = datasetRegistry.computeFingerprint(file.buffer, file.originalname);
      let regEntry = await timed('findByFingerprint', () =>
        datasetRegistry.findByFingerprint(organizationId, fp));

      // Facts must never be written without a dataset id. Rows stored with a
      // null one belong to no upload, so no later upload can replace them —
      // they simply accumulate, and nothing in the system can tell they are a
      // second copy. Registering here guarantees this file owns its rows.
      if (!regEntry) {
        regEntry = await datasetRegistry.register(organizationId, {
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype,
        });
      }

      // The same rows arriving as a different file REPLACE the earlier copy
      // rather than adding to it. The byte fingerprint above cannot see this:
      // it hashes the filename and the raw bytes, so a repeat download
      // ("report (1).xlsx") or a re-export from the same POS reads as a new
      // dataset, and the previous copy's rows stay behind — every total then
      // counts the same sales twice.
      const contentFp = datasetRegistry.computeContentFingerprint(sheets);
      const superseded = await timed('replaceDuplicates', async () => {
        if (!contentFp) return [];
        const stale = await datasetRegistry.findSupersededByContent(
          organizationId, contentFp, regEntry.datasetId,
        );
        for (const old of stale) {
          const removed = await purgeDataset(organizationId, old.datasetId);
          await datasetRegistry.remove(organizationId, old.datasetId);
          console.log(
            `[confirm-mapping] replaced earlier copy "${old.filename}" `
            + `(${removed.sales} sales, ${removed.facts} fact rows removed)`,
          );
        }
        return stale;
      });

      // Persist into dimensional model
      const inserted = await timed('loadFactRecords', () =>
        loadFactRecords(organizationId, result.normalized, {
          datasetId: regEntry.datasetId,
        }));

      // Query analytics from the star schema (same shape dashboard expects)
      const analyticsResult = await timed('queryAnalytics', () => queryAnalytics(organizationId));

      // Compute verified metrics (Phase 5) — use valid records only
      const metrics = computeAllMetrics(result.validRecords || result.normalized, {
        productNormalizationStats: result.productNormalizationStats,
        cleaningReportSummary: result.cleaningReport ? result.cleaningReport.summary : null,
        qualityReport: result.qualityReport,
        cleaningStats: result.cleaningStats,
      });

      // Business Health — computed from the same metrics the KPIs use
      const { inventoryStats, customerStats } = await timed('computeHealthStats', () =>
        computeHealthStats(organizationId));
      const bizHealthOpts = {};
      if (inventoryStats) bizHealthOpts.inventoryStats = inventoryStats;
      if (customerStats) bizHealthOpts.customerStats = customerStats;
      // Pass raw records for product-level monthly attribution in insights
      bizHealthOpts.records = result.validRecords || result.normalized;

      // Weather signal is fully optional — a fetch/config problem here must
      // never break the upload flow, so it's isolated in its own try/catch
      // and simply omitted (generateInsights runs unchanged without it).
      await timed('weatherSignal', async () => {
        try {
          const { state } = await require('./services/pharmacyProfile').get(organizationId);
          if (state) {
            const weatherSignal = await require('./services/weather/weatherCache').getOrFetch(organizationId, state);
            if (weatherSignal) {
              const demandRules = await require('./services/weatherDecisionRules').evaluateWeatherDemandRules(organizationId, weatherSignal);
              bizHealthOpts.weatherSignals = { ...weatherSignal, demandRules };
            }
          }
        } catch (weatherErr) {
          console.warn('[confirm-mapping] weather signal unavailable:', weatherErr.message);
        }
      });

      // Calendar signal — Calendar Intelligence is read-only and has no
      // external dependencies, so this can't meaningfully fail, but it's
      // wrapped the same way for consistency.
      try {
        bizHealthOpts.calendarSignals = require('./services/calendar/calendarService').getCalendarSignals(new Date());
      } catch (calendarErr) {
        console.warn('[confirm-mapping] calendar signal unavailable:', calendarErr.message);
      }

      const bizHealth = scoreBusinessHealth(metrics, bizHealthOpts);
      const bizInsights = generateInsights(bizHealth, metrics, bizHealthOpts);

      // Determine which dashboards to evaluate using the shared
      // hasTransactionCapability gate — not a separate classifier check.
      const isSalesFile = hasTransactionCapability(result.mapping, result.tiers);

      // Determine capabilities by classifying the raw sheet rows. Reading from
      // regEntry.capabilities doesn't work when: (1) /api/classify was never
      // called, (2) the file is a duplicate and the capabilities weren't
      // updated, or (3) regEntry is null. Calling classifyDataset here directly
      // ensures capabilities are always detected, matching the WhatsApp pipeline.
      const primarySheetRows = Object.values(sheets)[0] || [];
      const caps = classifyDataset(primarySheetRows).capabilities;

      // Never pass undefined to the widget engine — that would evaluate ALL
      // dashboards without gating.
      const dashFromCaps = Object.keys(caps).filter((k) => caps[k]);
      const baseDashboards = dashFromCaps.length > 0 ? dashFromCaps : ['inventory', 'expiry'];
      const effectiveDashboards = baseDashboards.filter((d) => d !== 'sales');
      if (isSalesFile) effectiveDashboards.push('sales');

      // Generate widget manifest from normalized records, respecting capabilities
      const widgetManifest = await timed('evaluateWidgets', async () =>
        evaluateWidgets(result.validRecords || result.normalized, {
          dashboards: effectiveDashboards,
        }));

      await datasetRegistry.update(organizationId, regEntry.datasetId, {
        processingStatus: 'processed',
        capabilities: caps,
        recommended_dashboards: dashFromCaps,
        mappedColumns: userMapping,
        normalizedSchema: result.schema || null,
        rowCount: result.normalized.length,
        sheetNames: Object.keys(sheets),
        // Stored so the NEXT upload of this same data can recognise it, even
        // arriving under a different filename or re-exported byte-for-byte
        // differently.
        contentFingerprint: contentFp,
      });

      // Write normalized records into the Fact Store so the Widget Engine
      // can read from all registered datasets, not just the latest upload.
      const records = result.validRecords || result.normalized;

      // Extract dimension data from normalized records. Always a real id now,
      // so factStore.append can scope its replace to this upload.
      const _assetId = regEntry.datasetId;
      const dimProducts = new Map();
      const dimCustomers = new Map();
      const dimSuppliers = new Map();
      const dimDates = new Map();

      for (const rec of records) {
        const prodName = rec.product_name || rec.product;
        if (prodName) {
          // Same key logic as upsertProduct's star-schema grouping (db.js) —
          // otherwise DimProduct fragments on spacing/case/unit noise that
          // the star schema's `product` table no longer does.
          const key = computeProductNaturalKey(prodName);
          if (!dimProducts.has(key)) {
            dimProducts.set(key, { name: prodName, category: rec.category || null, sourceAssetId: _assetId });
          }
        }
        if (rec.customer) {
          const key = String(rec.customer).toLowerCase().trim();
          if (!dimCustomers.has(key)) {
            dimCustomers.set(key, { name: rec.customer, sourceAssetId: _assetId });
          }
        }
        if (rec.supplier) {
          const key = String(rec.supplier).toLowerCase().trim();
          if (!dimSuppliers.has(key)) {
            dimSuppliers.set(key, { name: rec.supplier, sourceAssetId: _assetId });
          }
        }
        if (rec.transaction_date) {
          const dateStr = String(rec.transaction_date).substring(0, 10);
          if (!dimDates.has(dateStr)) {
            dimDates.set(dateStr, {
              date: dateStr,
              year: parseInt(dateStr.substring(0, 4)) || null,
              month: parseInt(dateStr.substring(5, 7)) || null,
              sourceAssetId: _assetId,
            });
          }
        }
      }

      // Batched: one round-trip per 500 dimension rows rather than two per
      // row. A file with thousands of distinct products used to spend most of
      // its upload time in these four lines.
      const asEntries = (m) => [...m].map(([naturalKey, record]) => ({ naturalKey, record }));
      await timed('upsertDimensions', async () => {
        await factStore.upsertDimensions(organizationId, 'DimProduct', asEntries(dimProducts));
        await factStore.upsertDimensions(organizationId, 'DimCustomer', asEntries(dimCustomers));
        await factStore.upsertDimensions(organizationId, 'DimSupplier', asEntries(dimSuppliers));
        await factStore.upsertDimensions(organizationId, 'DimDate', asEntries(dimDates));
      });

      // Write each dataset's rows into the fact store EXACTLY ONCE.
      //
      // Two bugs lived here. First, only sales- and inventory-capable files
      // were stored at all, so an expiry-only or supplier-only file
      // contributed nothing queryable — its widgets stayed empty and the
      // Advisor answered "no expiry data uploaded" for a file full of expiry
      // dates. Second, a file that was BOTH sales- and inventory-capable ran
      // both branches over the same `records`, storing every row twice and
      // double-counting it in every total.
      //
      // factStore.queryAll ignores table_name — the widget engine discovers
      // what it can compute from the FIELDS present — so one row per record,
      // filed under its primary capability, serves every dashboard.
      const hasStockSideData = !!(caps?.inventory || caps?.expiry || caps?.supplier);
      const factTable = isSalesFile ? 'FactSales' : (hasStockSideData ? 'FactInventory' : null);
      if (factTable) {
        const insertedFacts = await timed('factStore.append', () =>
          factStore.append(organizationId, factTable, records, _assetId));
        if (insertedFacts > 0) console.log(`[factStore] +${insertedFacts} ${factTable} records`);
      }

      const totalMs = timings.reduce((a, [, ms]) => a + ms, 0);
      console.log(
        `[confirm-mapping] ${result.normalized.length} rows in ${(totalMs / 1000).toFixed(1)}s — `
        + timings.filter(([, ms]) => ms >= 50)
          .sort((a, b) => b[1] - a[1])
          .map(([label, ms]) => `${label} ${(ms / 1000).toFixed(1)}s`)
          .join(', '),
      );

      // Remember only the columns a person actually decided on, keyed per
      // column rather than per file, so the answer survives a spreadsheet that
      // gains or loses columns next month — and so the WhatsApp channel, which
      // has no mapping screen, never asks about a column already settled here.
      const decided = {};
      const overrides = {};
      for (const [rawHeader, status] of Object.entries(reviewStatuses)) {
        if (status !== 'user_confirmed' && status !== 'user_overridden') continue;
        const category = userMapping[rawHeader];
        if (!category) continue;
        decided[rawHeader] = category;
        overrides[rawHeader] = status === 'user_overridden';
      }
      if (Object.keys(decided).length > 0) {
        await recordMapping(organizationId, decided, overrides, 'web')
          .catch((e) => console.warn('[confirm-mapping] could not record column aliases:', e.message));
      }

      // A fresh upload is a new analysis context — start a new Advisor
      // conversation so questions about it aren't answered using context
      // left over from a previous, unrelated file.
      await startNewConversation(organizationId).catch((e) => console.error('[advisor-chat] failed to start new conversation:', e));

      return res.json({
        datasetId: regEntry.datasetId,
        // Earlier uploads holding these same rows, now removed rather than
        // added to. Surfaced so the UI can say "this replaced March.xlsx"
        // instead of silently changing the totals the owner just saw.
        replacedDatasets: superseded.map((d) => ({
          datasetId: d.datasetId, fileName: d.filename, rowCount: d.rowCount,
        })),
        fileName: file.originalname,
        sheetName: Object.keys(sheets)[0] || null,
        widgetManifest,
        factStore: await factStore.summary(organizationId),
        analytics: analyticsResult,
        metrics,
        bizHealth: { health: bizHealth, insights: bizInsights, topPriorities: bizInsights.slice(0, 3) },
        mapping: result.mapping,
        tiers: result.tiers,
        cleaningStats: result.cleaningStats,
        cleaningReport: result.cleaningReport,
        productNormalization: result.productNormalizationStats,
        derivationReport: result.derivationReport,
        qualityReport: result.qualityReport,
        joinMeta: result.joinMeta,
        normalizedRowCount: result.normalized.length,
        persistedRows: inserted,
      });
    } catch (parseErr) {
      return res.status(400).json({ error: `Failed to process file: ${parseErr.message}` });
    }
  });
});

// ---------- Full Upload (legacy: auto-normalize + analyze in one shot) ----------

app.post('/api/upload', (req, res) => {
  uploadFields(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    }

    const salesFile = req.files?.sales?.[0];
    const inventoryFile = req.files?.inventory?.[0];
    const organizationId = req.organizationId;

    if (!salesFile && !inventoryFile) {
      return res.status(400).json({
        error: 'No files received. Upload at least one file (sales or inventory).',
      });
    }

    try {
      const result = {};

      if (salesFile) {
        const sheets = parseSheet(salesFile.buffer);
        const sheetKeys = Object.keys(sheets);

        // Full pipeline: normalize → persist → query. Register first: the
        // dataset id is what scopes the load, so re-uploading the same file
        // replaces its rows instead of appending a duplicate copy.
        const normalized = await normalizeFromSheets(sheets, { organizationId });
        const salesEntry = await datasetRegistry.register(organizationId, {
          buffer: salesFile.buffer,
          filename: salesFile.originalname,
          mimeType: salesFile.mimetype,
        });
        await loadFactRecords(organizationId, normalized.normalized, { datasetId: salesEntry?.datasetId || null });
        const analyticsResult = await queryAnalytics(organizationId);

        result.sales = {
          fileName: salesFile.originalname,
          sheetName: sheetKeys[0] || null,
          analytics: analyticsResult,
          schema: normalized.schema,
          mapping: normalized.mapping,
          cleaningStats: normalized.cleaningStats,
          needsConfirmation: normalized.needsConfirmation,
        };
      }

      if (inventoryFile) {
        const sheets = parseSheet(inventoryFile.buffer);
        const sheetKeys = Object.keys(sheets);

        const normalized = await normalizeFromSheets(sheets, { organizationId });
        // Registered up here rather than after the load (where it used to
        // live) so its id can scope the load and keep re-uploads idempotent.
        const inventoryEntry = await datasetRegistry.register(organizationId, {
          buffer: inventoryFile.buffer,
          filename: inventoryFile.originalname,
          mimeType: inventoryFile.mimetype,
        });
        await loadFactRecords(organizationId, normalized.normalized, { datasetId: inventoryEntry?.datasetId || null });
        const analyticsResult = await queryAnalytics(organizationId);

        result.inventory = {
          fileName: inventoryFile.originalname,
          sheetName: sheetKeys[0] || null,
          analytics: analyticsResult,
          schema: normalized.schema,
          mapping: normalized.mapping,
          cleaningStats: normalized.cleaningStats,
          needsConfirmation: normalized.needsConfirmation,
        };
      }

      // Update registry entries for processed files
      const files = [salesFile, inventoryFile].filter(Boolean);
      for (const f of files) {
        const fp = datasetRegistry.computeFingerprint(f.buffer, f.originalname);
        const all = await datasetRegistry.list(organizationId, { limit: 500 });
        let entry = null;
        for (const d of all) {
          const full = await datasetRegistry.get(organizationId, d.datasetId);
          if (full && full.fingerprint === fp) { entry = full; break; }
        }
        if (entry) {
          await datasetRegistry.update(organizationId, entry.datasetId, { processingStatus: 'processed' });
        }
      }

      // A fresh upload is a new analysis context — start a new Advisor
      // conversation so questions about it aren't answered using context
      // left over from a previous, unrelated file.
      await startNewConversation(organizationId).catch((e) => console.error('[advisor-chat] failed to start new conversation:', e));

      return res.json(result);
    } catch (parseErr) {
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }
  });
});

// ---------- Analytics from DB ----------

// Scoped to the current upload by default, because that is what the dashboard
// shows the moment an upload finishes. Returning the organization's whole
// history here instead would mean the figures CHANGED on refresh — ₦19M where
// ₦8.4M stood a second earlier — and a dashboard that reports a different
// revenue depending on how you arrived at it is worse than one that forgets.
// `?scope=all` asks for the full history explicitly.
app.get('/api/analytics', async (req, res) => {
  const { startDate, endDate, branchId, scope } = req.query;
  let datasetId;
  if (scope !== 'all') {
    const latest = await datasetRegistry.getLatest(req.organizationId);
    datasetId = latest?.datasetId;
  }
  const analytics = await queryAnalytics(req.organizationId, {
    startDate, endDate, datasetId,
    branchId: branchId ? Number(branchId) : undefined,
  });
  res.json({ ...analytics, scope: scope === 'all' ? 'all' : 'current-upload' });
});

// ---------- Dimension summaries ----------

app.get('/api/dimensions/products', async (req, res) => {
  const db = getSql();
  const products = await db`select id, name, category from product where organization_id = ${req.organizationId} order by name`;
  res.json(products);
});

app.get('/api/dimensions/branches', async (req, res) => {
  const db = getSql();
  const branches = await db`select id, name, location from branch where organization_id = ${req.organizationId} order by name`;
  res.json(branches);
});

// ---------- Advanced Analytics Insights ----------

app.get('/api/insights/profit-by-category', async (req, res) => {
  res.json(await profitByCategory(req.organizationId));
});

app.get('/api/insights/abc-analysis', async (req, res) => {
  res.json({ items: await abcAnalysis(req.organizationId), summary: await abcSummary(req.organizationId) });
});

app.get('/api/insights/fast-slow-movers', async (req, res) => {
  res.json({ items: await fastSlowMovers(req.organizationId), summary: await fastSlowSummary(req.organizationId) });
});

app.get('/api/insights/expiry-summary', async (req, res) => {
  res.json(await expirySummary(req.organizationId));
});

app.get('/api/insights/inventory-turnover', async (req, res) => {
  res.json(await inventoryTurnover(req.organizationId));
});

// ---------- Business Health ----------
//
// Delegates to advisorQueries.getBusinessHealthBundle — the AI Advisor's
// data layer already rebuilds this exact bundle (same metrics/health/
// insights shape); duplicating the ~120-line Postgres translation of this
// route's original inline SQL a second time in this file would just be two
// near-identical code paths that could silently drift apart over time.
app.get('/api/business-health', async (req, res) => {
  try {
    const { health, insights, topPriorities } = await advisorQueries.getBusinessHealthBundle(req.organizationId);
    return res.json({ health, insights, topPriorities });
  } catch (err) {
    console.error('[business-health]', err);
    return res.status(500).json({ error: `Failed to compute business health: ${err.message}` });
  }
});

// ---------- Dashboard PDF export ----------
//
// Replaces the client's old html2canvas + jsPDF screenshot: this draws a real
// vector PDF server-side (services/reports/dashboardPdfReport.js) from the
// same data the dashboard itself queries, current-upload-scoped the same way
// /api/analytics and /api/widgets already are — so the report matches what's
// on screen instead of rasterizing whatever the DOM happened to look like.
app.get('/api/export/dashboard-pdf', async (req, res) => {
  try {
    const organizationId = req.organizationId;
    const db = getSql();

    const [org] = await db`select name from organizations where id = ${organizationId}`;
    const latest = await datasetRegistry.getLatest(organizationId);

    const [analytics, healthBundle, widgetManifest] = await Promise.all([
      queryAnalytics(organizationId, { datasetId: latest?.datasetId }),
      advisorQueries.getBusinessHealthBundle(organizationId),
      evaluateFromStore(organizationId),
    ]);

    const m = analytics.metrics || {};
    const byId = new Map();
    for (const dash of Object.values(widgetManifest.dashboards || {})) {
      for (const w of dash.available || []) byId.set(w.id, w.result);
    }
    const g = (id) => byId.get(id);

    const kpis = [
      { label: 'Total Revenue', value: fmtN(m.totalRevenue), accent: '#1F6F5C' },
      m.grossProfit != null && {
        label: 'Gross Profit', value: fmtN(m.grossProfit),
        sub: m.grossMargin != null ? `${m.grossMargin}% margin` : null, accent: '#1F6F5C',
      },
      { label: 'Transactions', value: String(m.transactionCount ?? 0), accent: '#B8901F' },
      { label: 'Avg. Basket', value: fmtN(m.averageTransactionValue), accent: '#B8901F' },
      { label: 'Products Sold', value: fmtNum(m.totalQuantitySold), accent: '#164F42' },
      g('distinct-products-kpi') && {
        label: 'Distinct Products', value: String(g('distinct-products-kpi').value), accent: '#164F42',
      },
      g('avg-items-per-basket') && {
        label: 'Items per Basket', value: fmtNum(g('avg-items-per-basket').value), accent: '#B4780A',
      },
    ].filter(Boolean);

    // Same four risk metrics DynamicKpiGrid shows on screen, plus up to four
    // of the highest-severity executive notes across every stock-side widget
    // that produced one — carried verbatim from the widgets themselves (see
    // ExecutiveNote.jsx) so the report can never disagree with its own chart.
    const invAvailable = [
      ...(widgetManifest.dashboards.inventory?.available || []),
      ...(widgetManifest.dashboards.expiry?.available || []),
    ];
    let inventory = null;
    if (invAvailable.length > 0) {
      const invById = new Map(invAvailable.map((w) => [w.id, w.result]));
      const gi = (id) => invById.get(id);
      const invKpis = [
        gi('stock-value') && { label: 'Stock Value', value: fmtN(gi('stock-value').value), accent: '#1F6F5C' },
        gi('current-stock') && { label: 'Current Stock', value: fmtNum(gi('current-stock').value), accent: '#1F6F5C' },
        gi('low-stock-alert') && { label: 'Low Stock Items', value: fmtNum(gi('low-stock-alert').value), accent: '#B23A2E' },
        gi('expiry-risk-value') && { label: 'At Risk of Expiring', value: fmtN(gi('expiry-risk-value').value), accent: '#B4780A' },
        gi('overstock-value') && { label: 'Cash in Overstock', value: fmtN(gi('overstock-value').value), accent: '#B8901F' },
      ].filter(Boolean);

      const severityRank = { high: 0, medium: 1, low: 2, info: 3 };
      const notes = invAvailable
        .map((w) => w.result?.executive)
        .filter((n) => n && (n.insight || n.action))
        .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
        .slice(0, 4);

      if (invKpis.length > 0 || notes.length > 0) inventory = { kpis: invKpis, notes };
    }

    const dateRangeLabel = analytics.monthlyRevenue && analytics.monthlyRevenue.length > 0
      ? `${analytics.monthlyRevenue[0].month} to ${analytics.monthlyRevenue[analytics.monthlyRevenue.length - 1].month}`
      : null;

    const pdfBuffer = await buildDashboardPdf({
      organizationName: org?.name || 'RxNaija Analytics',
      datasetLabel: latest?.filename ? `Current upload: ${latest.filename}` : null,
      dateRangeLabel,
      kpis,
      bizHealth: healthBundle.health,
      insights: healthBundle.insights,
      monthlyRevenue: analytics.monthlyRevenue,
      topProducts: analytics.topProducts,
      inventory,
    });

    const safeName = (org?.name || 'rxnaija').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${safeName}-dashboard-report-${stamp}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[export/dashboard-pdf]', err);
    res.status(500).json({ error: `Failed to generate PDF: ${err.message}` });
  }
});

// ---------- AI Advisor (conversational, tool-calling) ----------

// Lets the client repopulate the conversation on mount/reload instead of
// the AI Advisor starting empty every time — it used to live only in React
// state and vanish on refresh or navigating away.
app.get('/api/advisor-chat/history', async (req, res) => {
  try {
    // An explicit ?conversationId= loads that thread (history sidebar);
    // omitting it keeps the original behaviour of loading the active one.
    // Ownership is re-checked server-side — an id from the query string is
    // never trusted on its own.
    const requested = req.query.conversationId
      ? await resolveOwnedConversationId(req.organizationId, req.query.conversationId)
      : null;
    if (req.query.conversationId && !requested) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    const conversationId = requested || (await getActiveConversationId(req.organizationId));
    const messages = await getConversationMessages(conversationId);
    return res.json({ conversationId, messages });
  } catch (err) {
    return res.status(500).json({ error: `Failed to load advisor history: ${err.message}` });
  }
});

// Conversation list for the history sidebar.
app.get('/api/advisor-chat/conversations', async (req, res) => {
  try {
    return res.json({ conversations: await listConversations(req.organizationId) });
  } catch (err) {
    return res.status(500).json({ error: `Failed to load conversations: ${err.message}` });
  }
});

// Explicitly starts a fresh conversation — the manual "New chat" equivalent
// to the automatic reset that already happens after a new file upload.
app.post('/api/advisor-chat/new', async (req, res) => {
  try {
    const conversationId = await startNewConversation(req.organizationId);
    return res.json({ ok: true, conversationId });
  } catch (err) {
    return res.status(500).json({ error: `Failed to start a new conversation: ${err.message}` });
  }
});

// Server-Sent Events: streams the advisor's answer token-by-token as it's
// generated, instead of making the client wait for the full reply. Each
// event is one JSON-encoded line; the client reassembles them live.
//
// History is authoritative on the server (advisor_message, scoped to the
// active conversation), not trusted from the client — the client only
// sends the new question.
app.post('/api/advisor-chat', async (req, res) => {
  const question = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!question) return res.status(400).json({ error: 'message is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    // Replying inside a conversation picked from the history sidebar must
    // continue THAT thread, not the active one — otherwise the answer lands
    // in a different conversation than the one on screen. Falls back to the
    // active conversation when the client sends no id (original behaviour).
    const selected = req.body?.conversationId
      ? await resolveOwnedConversationId(req.organizationId, req.body.conversationId)
      : null;
    const conversationId = selected || (await getActiveConversationId(req.organizationId));
    const priorHistory = await getConversationMessages(conversationId);
    await appendAdvisorMessage(req.organizationId, conversationId, 'user', question);
    const history = [...priorHistory, { role: 'user', content: question }];

    const result = await advisorChatStream(
      req.organizationId,
      history,
      (token) => send({ type: 'token', token }),
      { analysisContext: req.body?.analysisContext || null }
    );
    await appendAdvisorMessage(req.organizationId, conversationId, 'assistant', result.reply);
    send({ type: 'done', toolCalls: result.toolCalls, conversationId });
  } catch (err) {
    console.error('[advisor-chat]', err);
    send({ type: 'error', error: `Advisor chat failed: ${err.message}` });
  } finally {
    res.end();
  }
});

// ---------- Pipeline Validation ----------

app.post('/api/validate', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });

    let userMapping = {};
    try {
      userMapping = typeof req.body.mapping === 'string'
        ? JSON.parse(req.body.mapping) : (req.body.mapping || {});
    } catch (_) {}

    try {
      const sheets = parseSheet(file.buffer);
      const sheetKeys = Object.keys(sheets);
      const rows = sheetKeys.length > 0 ? sheets[sheetKeys[0]] : [];

      if (rows.length === 0) {
        return res.status(400).json({ error: 'The file contains no data rows.' });
      }

      const result = await normalizeFromSheets(sheets, { organizationId: req.organizationId, userMapping });
      const analyticsResult = analyze(result.normalized);
      const validationReport = validate(rows, result, analyticsResult);

      return res.json({
        fileName: file.originalname,
        validation: validationReport,
        analytics: analyticsResult,
      });
    } catch (e) {
      return res.status(400).json({ error: `Validation failed: ${e.message}` });
    }
  });
});

// ---------- Saved Mappings ----------
//
// The pharmacyId URL param is accepted for backward-compatible routing but
// never used for scoping — the real tenant is always the authenticated
// session's organization, never a client-supplied value.
app.get('/api/mappings/:pharmacyId', async (req, res) => {
  const mappings = await loadPharmacyMappings(req.organizationId);
  res.json({ mappings });
});

// ---------- Contact ----------

app.post('/api/contact', (req, res) => {
  const { name, email, pharmacyName, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({
      error: 'Name, email, and message are required.',
    });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const entry = {
    id: submissions.length + 1,
    name,
    email,
    pharmacyName: pharmacyName || '',
    message,
    receivedAt: new Date().toISOString(),
  };

  submissions.push(entry);
  console.log('New contact submission:', entry);

  res.status(201).json({
    message: "Thanks — we've got your message and will reply within one business day.",
  });
});

// Serve the built React app in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send(
      'RxNaija Analytics API is running. Build the client (cd client && npm run build) to serve the site from here.'
    );
  });
}

// ----- Phase 5: Verified Metrics & AI Analysis -----

app.post('/api/metrics', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });

    try {
      const sheets = parseSheet(file.buffer);
      const result = await normalizeFromSheets(sheets, { organizationId: req.organizationId });

      if (result.normalized.length === 0) {
        return res.status(400).json({ error: 'No processable data found.' });
      }

      // Compute full verified metrics
      const metrics = computeAllMetrics(result.normalized, {
        productNormalizationStats: result.productNormalizationStats,
        cleaningReportSummary: result.cleaningReport ? result.cleaningReport.summary : null,
        qualityReport: result.qualityReport,
        cleaningStats: result.cleaningStats,
      });

      // Persist data. Scoped to the dataset so re-posting the same file
      // replaces its rows rather than stacking another copy — this endpoint
      // persists as a side effect, so it inflated totals just as silently as
      // the real upload routes did.
      const entry = await datasetRegistry.register(req.organizationId, {
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      });
      await loadFactRecords(req.organizationId, result.normalized, { datasetId: entry?.datasetId || null });

      return res.json({
        fileName: file.originalname,
        metrics,
        cleaningReport: result.cleaningReport,
        productNormalization: result.productNormalizationStats,
      });
    } catch (e) {
      return res.status(400).json({ error: `Processing failed: ${e.message}` });
    }
  });
});

app.post('/api/analysis', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });

    try {
      const sheets = parseSheet(file.buffer);
      const result = await normalizeFromSheets(sheets, { organizationId: req.organizationId });

      if (result.normalized.length === 0) {
        return res.status(400).json({ error: 'No processable data found.' });
      }

      // Compute verified metrics
      const metrics = computeAllMetrics(result.normalized, {
        productNormalizationStats: result.productNormalizationStats,
        cleaningReportSummary: result.cleaningReport ? result.cleaningReport.summary : null,
        qualityReport: result.qualityReport,
        cleaningStats: result.cleaningStats,
      });

      // Generate AI analysis
      const analysis = await analyzeMetrics(metrics);

      // Persist data. Scoped to the dataset so re-posting the same file
      // replaces its rows rather than stacking another copy — this endpoint
      // persists as a side effect, so it inflated totals just as silently as
      // the real upload routes did.
      const entry = await datasetRegistry.register(req.organizationId, {
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      });
      await loadFactRecords(req.organizationId, result.normalized, { datasetId: entry?.datasetId || null });

      return res.json({
        fileName: file.originalname,
        metrics,
        analysis,
        cleaningReport: result.cleaningReport,
        productNormalization: result.productNormalizationStats,
      });
    } catch (e) {
      return res.status(400).json({ error: `Processing failed: ${e.message}` });
    }
  });
});

app.listen(PORT, () => {
  console.log(`RxNaija Analytics server listening on http://localhost:${PORT}`);
  // Stale-FactSales purging now happens per-organization inside
  // evaluateFromStore() — there's no single "current org" at startup
  // anymore, so the old blanket purge-on-boot call is gone.
});
