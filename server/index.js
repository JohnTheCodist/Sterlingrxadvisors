const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const { normalize, normalizeFromSheets } = require('./services/normalizer');
const { analyze } = require('./services/analytics');
const { detectSchema, mergeLlmResults } = require('./services/schemaDetector');
const { resolveMapping, saveMapping, loadMapping, loadPharmacyMappings } = require('./services/columnMapper');
const { loadFactRecords, queryAnalytics, populateProductAttributes } = require('./services/database');
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
const { evaluate: evaluateWidgets } = require('./services/widgetEngine');
const { hasTransactionCapability } = require('./services/columnMapper');
const factStore = require('./services/factStore');
const { chat: advisorChat } = require('./services/advisorAgent');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---------- Multer config ----------

const ALLOWED_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
];
const ALLOWED_EXTS = ['.xlsx', '.csv'];

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

// ---------- Helpers ----------

function parseSheet(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheets = {};
  workbook.SheetNames.forEach((name) => {
    sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
  });
  return sheets;
}

// In-memory store for contact form submissions
const submissions = [];

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------- Dataset Registry (metadata for every uploaded dataset) ----------

app.get('/api/datasets', (req, res) => {
  const status = req.query.status || null;
  const limit = parseInt(req.query.limit) || 50;
  return res.json(datasetRegistry.list({ status, limit }));
});

app.get('/api/datasets/:id', (req, res) => {
  const entry = datasetRegistry.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Dataset not found.' });
  return res.json(entry);
});

app.get('/api/datasets/latest', (req, res) => {
  const entry = datasetRegistry.getLatest();
  if (!entry) return res.status(404).json({ error: 'No datasets registered.' });
  return res.json(entry);
});

// ---------- Widget Engine --------------------------------------------------

// Accept raw records OR read from fact store for multi-dataset evaluation.
app.post('/api/widgets', (req, res) => {
  const records = req.body?.records;
  // If explicit records passed, use them directly
  if (Array.isArray(records) && records.length > 0) {
    return res.json(evaluateWidgets(records));
  }
  // Otherwise, evaluate ALL fact tables (multi-dataset intelligence)
  const { evaluateFromStore } = require('./services/widgetEngine');
  return res.json(evaluateFromStore());
});

// ---------- Dataset Classification (runs before schema detection) ----------

app.post('/api/classify-dataset', (req, res) => {
  uploadSingle(req, res, (err) => {
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
      lastUploadedBuffer = file.buffer;
      lastUploadedMime = file.mimetype;

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
      const reg = datasetRegistry.register({
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      });
      if (!reg.isDuplicate) {
        datasetRegistry.update(reg.datasetId, {
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
        const reg = datasetRegistry.register({
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype,
        });
        if (!reg.isDuplicate) {
          datasetRegistry.update(reg.datasetId, {
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

// In-memory store for the last uploaded file (used by inventory dashboard).
let lastUploadedBuffer = null;
let lastUploadedMime = null;

app.post('/api/inventory-analytics', (req, res) => {
  if (!lastUploadedBuffer) {
    // If no file in memory, accept a new upload
    uploadSingle(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file received.' });
      lastUploadedBuffer = file.buffer;
      lastUploadedMime = file.mimetype;
      return runInventoryAnalysis(file.buffer, res);
    });
    return;
  }
  return runInventoryAnalysis(lastUploadedBuffer, res);
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

    const pharmacyId = req.body?.pharmacyId || 'default';

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

      // Resolve mapping
      const {
        mapping, tiers, unmapped, unmappedRequired, unmappedOptional, priceFulfilled,
        ignored, domainStatus, productIdentityFulfilled, needsConfirmation,
      } = resolveMapping(schema);

      // Check for saved mapping
      const savedMapping = loadMapping(pharmacyId, rawHeaders);

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
      const all = datasetRegistry.list({ limit: 500 });
      const entry = all.find((d) => {
        const full = datasetRegistry.get(d.datasetId);
        return full && full.fingerprint === fp;
      });
      if (entry) {
        datasetRegistry.update(entry.datasetId, {
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

// ---------- NAFDAC Database Status ----------

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
  uploadSingle(req, res, (err) => {
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

    const pharmacyId = req.body?.pharmacyId || 'default';

    // Parse user mapping from body (comes as JSON string)
    let userMapping = {};
    try {
      userMapping = typeof req.body.mapping === 'string'
        ? JSON.parse(req.body.mapping)
        : (req.body.mapping || {});
    } catch (_) {
      return res.status(400).json({ error: 'Invalid mapping format. Must be a JSON object.' });
    }

    try {
      const sheets = parseSheet(file.buffer);

      // Auto-join dimension tables and normalize
      const result = normalizeFromSheets(sheets, { pharmacyId, userMapping });

      if (result.normalized.length === 0) {
        return res.status(400).json({ error: 'The file contains no processable data rows.' });
      }

      // Persist into dimensional model
      const inserted = loadFactRecords(result.normalized);

      // Query analytics from the star schema (same shape dashboard expects)
      const analyticsResult = queryAnalytics();

      // Compute verified metrics (Phase 5) — use valid records only
      const metrics = computeAllMetrics(result.validRecords || result.normalized, {
        productNormalizationStats: result.productNormalizationStats,
        cleaningReportSummary: result.cleaningReport ? result.cleaningReport.summary : null,
        qualityReport: result.qualityReport,
        cleaningStats: result.cleaningStats,
      });

      // Business Health — computed from the same metrics the KPIs use
      const { inventoryStats, customerStats } = computeHealthStats();
      const bizHealthOpts = {};
      if (inventoryStats) bizHealthOpts.inventoryStats = inventoryStats;
      if (customerStats) bizHealthOpts.customerStats = customerStats;
      // Pass raw records for product-level monthly attribution in insights
      bizHealthOpts.records = result.validRecords || result.normalized;
      const bizHealth = scoreBusinessHealth(metrics, bizHealthOpts);
      const bizInsights = generateInsights(bizHealth, metrics, bizHealthOpts);

      // Determine which dashboards to evaluate using the shared
      // hasTransactionCapability gate — not a separate classifier check.
      const isSalesFile = hasTransactionCapability(result.mapping, result.tiers);

      // Look up dataset classification for non-sales capabilities
      const fp = datasetRegistry.computeFingerprint(file.buffer, file.originalname);
      const all = datasetRegistry.list({ limit: 500 });
      const regEntry = all.find((d) => {
        const full = datasetRegistry.get(d.datasetId);
        return full && full.fingerprint === fp;
      });
      const caps = regEntry ? datasetRegistry.get(regEntry.datasetId)?.capabilities : null;

      // Build effective dashboard list. Prefer recommended_dashboards from the
      // registry, but fall back to capabilities when it's not stored (e.g. old
      // entries from before this field was added). Never pass undefined to the
      // widget engine — that would evaluate ALL dashboards without gating.
      const recDashboards = (regEntry ? datasetRegistry.get(regEntry.datasetId)?.recommended_dashboards : null) || [];
      const dashFromCaps = caps ? Object.keys(caps).filter((k) => caps[k]) : [];
      const baseDashboards = recDashboards.length > 0 ? recDashboards : (dashFromCaps.length > 0 ? dashFromCaps : ['inventory', 'expiry']);
      const effectiveDashboards = baseDashboards.filter((d) => d !== 'sales');
      if (isSalesFile) effectiveDashboards.push('sales');

      // Generate widget manifest from normalized records, respecting capabilities
      const widgetManifest = evaluateWidgets(result.validRecords || result.normalized, {
        dashboards: effectiveDashboards,
      });

      if (regEntry) {
        datasetRegistry.update(regEntry.datasetId, {
          processingStatus: 'processed',
          mappedColumns: userMapping,
          normalizedSchema: result.schema || null,
          rowCount: result.normalized.length,
          sheetNames: Object.keys(sheets),
          branch: result.normalized.length > 0 ? (result.normalized[0].branch || null) : null,
        });
      }

      // Write normalized records into the Fact Store so the Widget Engine
      // can read from all registered datasets, not just the latest upload.
      const records = result.validRecords || result.normalized;

      // Extract dimension data from normalized records
      const _assetId = regEntry?.datasetId || 'unknown';
      const dimProducts = new Map();
      const dimCustomers = new Map();
      const dimSuppliers = new Map();
      const dimDates = new Map();

      for (const rec of records) {
        const prodName = rec.product_name || rec.product;
        if (prodName) {
          const key = String(prodName).toLowerCase().trim();
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

      for (const [key, dim] of dimProducts) factStore.upsertDimension('DimProduct', dim, key);
      for (const [key, dim] of dimCustomers) factStore.upsertDimension('DimCustomer', dim, key);
      for (const [key, dim] of dimSuppliers) factStore.upsertDimension('DimSupplier', dim, key);
      for (const [key, dim] of dimDates) factStore.upsertDimension('DimDate', dim, key);

      if (isSalesFile) {
        const insertedSales = factStore.append('FactSales', records, regEntry?.datasetId || 'unknown');
        if (insertedSales > 0) console.log(`[factStore] +${insertedSales} FactSales records`);
      }
      if (caps?.inventory) {
        const invInserted = factStore.append('FactInventory', records, regEntry?.datasetId || 'unknown');
        if (invInserted > 0) console.log(`[factStore] +${invInserted} FactInventory records`);
      }

      return res.json({
        datasetId: regEntry ? regEntry.datasetId : null,
        fileName: file.originalname,
        sheetName: Object.keys(sheets)[0] || null,
        widgetManifest,
        factStore: factStore.summary(),
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
  uploadFields(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 50 MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    }

    const salesFile = req.files?.sales?.[0];
    const inventoryFile = req.files?.inventory?.[0];

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
        const rows = sheetKeys.length > 0 ? sheets[sheetKeys[0]] : [];

        // Full pipeline: normalize → persist → query
        const normalized = normalizeFromSheets(sheets, { pharmacyId: 'default' });
        loadFactRecords(normalized.normalized);
        const analyticsResult = queryAnalytics();

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
        const rows = sheetKeys.length > 0 ? sheets[sheetKeys[0]] : [];

        const normalized = normalizeFromSheets(sheets, { pharmacyId: 'default' });
        loadFactRecords(normalized.normalized);
        const analyticsResult = queryAnalytics();

        result.inventory = {
          fileName: inventoryFile.originalname,
          sheetName: sheetKeys[0] || null,
          analytics: analyticsResult,
          schema: normalized.schema,
          mapping: normalized.mapping,
          cleaningStats: normalized.cleaningStats,
          needsConfirmation: normalized.needsConfirmation,
        };

        // Register inventory file in the Dataset Registry
        datasetRegistry.register({
          buffer: inventoryFile.buffer,
          filename: inventoryFile.originalname,
          mimeType: inventoryFile.mimetype,
        });
      }

      // Update registry entries for processed files
      const files = [salesFile, inventoryFile].filter(Boolean);
      for (const f of files) {
        const fp = datasetRegistry.computeFingerprint(f.buffer, f.originalname);
        const all = datasetRegistry.list({ limit: 500 });
        const entry = all.find((d) => {
          const full = datasetRegistry.get(d.datasetId);
          return full && full.fingerprint === fp;
        });
        if (entry) {
          datasetRegistry.update(entry.datasetId, { processingStatus: 'processed' });
        }
      }

      return res.json(result);
    } catch (parseErr) {
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }
  });
});

// ---------- Analytics from DB ----------

app.get('/api/analytics', (req, res) => {
  const { startDate, endDate, branchId } = req.query;
  const analytics = queryAnalytics({ startDate, endDate, branchId: branchId ? Number(branchId) : undefined });
  res.json(analytics);
});

// ---------- Dimension summaries ----------

app.get('/api/dimensions/products', (req, res) => {
  const db = require('./services/database').getDb();
  const products = db.prepare('SELECT id, name, category FROM dim_product ORDER BY name').all();
  res.json(products);
});

app.get('/api/dimensions/branches', (req, res) => {
  const db = require('./services/database').getDb();
  const branches = db.prepare('SELECT id, name, location FROM dim_branch ORDER BY name').all();
  res.json(branches);
});

// ---------- Advanced Analytics Insights ----------

app.get('/api/insights/profit-by-category', (req, res) => {
  res.json(profitByCategory());
});

app.get('/api/insights/abc-analysis', (req, res) => {
  res.json({ items: abcAnalysis(), summary: abcSummary() });
});

app.get('/api/insights/fast-slow-movers', (req, res) => {
  res.json({ items: fastSlowMovers(), summary: fastSlowSummary() });
});

app.get('/api/insights/expiry-summary', (req, res) => {
  res.json(expirySummary());
});

app.get('/api/insights/inventory-turnover', (req, res) => {
  res.json(inventoryTurnover());
});

// ---------- Business Health (Phase 6) ----------

app.get('/api/business-health', (req, res) => {
  try {
    const analytics = queryAnalytics();
    const db = require('./services/database').getDb();

    // Compute supplemental stats from the database
    const { inventoryStats, customerStats } = computeHealthStats();

    // --- Build metrics object from queryAnalytics output ---
    const a = analytics.metrics || {};

    // Trends: merge monthly revenue + profit + transaction counts
    const monthlyTxs = db.prepare(`
      SELECT strftime('%Y-%m', c.date) AS month, COUNT(*) AS transactions
      FROM fact_sales f JOIN dim_calendar c ON f.calendar_id = c.id
      GROUP BY strftime('%Y-%m', c.date) ORDER BY month
    `).all();

    const txMap = {};
    monthlyTxs.forEach((r) => { txMap[r.month] = r.transactions; });

    const months = (analytics.monthlyProfit || analytics.monthlyRevenue || []).map((m) => ({
      month: m.month,
      revenue: m.revenue || 0,
      transactions: txMap[m.month] || 0,
      profit: m.profit != null ? m.profit : null,
    }));

    // Products
    const totalDistinct = db.prepare('SELECT COUNT(DISTINCT product_id) AS cnt FROM fact_sales').get().cnt;
    const topProducts = (analytics.topProducts || []).map((p) => ({
      name: p.name,
      revenue: p.revenue,
      margin: p.margin,
    }));

    // Revenue concentration
    const allProductRevs = db.prepare(`
      SELECT SUM(f.unit_price * f.quantity) AS revenue
      FROM fact_sales f GROUP BY f.product_id ORDER BY revenue DESC
    `).all();

    const totalRev = allProductRevs.reduce((s, r) => s + (r.revenue || 0), 0);
    let top1 = 0;
    if (totalRev > 0 && allProductRevs.length > 0) {
      top1 = (allProductRevs[0].revenue / totalRev) * 100;
    }

    // Health: compute from pipeline stages if available, else use DB record counts
    const totalFacts = db.prepare('SELECT COUNT(*) AS cnt FROM fact_sales').get().cnt;
    const productsWithSales = db.prepare('SELECT COUNT(DISTINCT product_id) AS cnt FROM fact_sales').get().cnt;
    const totalProducts = db.prepare('SELECT COUNT(*) AS cnt FROM dim_product').get().cnt;

    const metrics = {
      overview: {
        totalRevenue: a.totalRevenue || 0,
        totalQuantitySold: a.totalQuantitySold || 0,
        transactionCount: a.recordCount || 0,
        averageTransactionValue: a.averageTransactionValue || 0,
        averageSellingPrice: a.averageSellingPrice || 0,
        grossProfit: a.grossProfit,
        grossMargin: a.grossMargin,
        hasCostData: a.grossProfit != null,
      },
      trends: { months, monthCount: months.length },
      products: {
        totalDistinctProducts: totalDistinct,
        revenueConcentration: { top1: Math.round(top1) },
        allProducts: topProducts,
      },
      health: {
        dataCompleteness: { productName: 100, quantity: 100, revenue: 100, date: 100 },
        qualityDistribution: { excellent: totalFacts, good: 0, fair: 0, poor: 0 },
        pipelineStages: { uploadedRows: totalFacts, structurallyValidRows: totalFacts },
        productRecognition: {
          recognizedCount: productsWithSales,
          unknownCount: Math.max(0, totalProducts - productsWithSales),
          recognitionRate: totalProducts > 0 ? (productsWithSales / totalProducts) * 100 : 100,
        },
      },
    };

    const opts = {};
    if (inventoryStats) opts.inventoryStats = inventoryStats;
    if (customerStats) opts.customerStats = customerStats;

    const healthResult = scoreBusinessHealth(metrics, opts);
    const insights = generateInsights(healthResult, metrics, opts);

    return res.json({
      health: healthResult,
      insights,
      topPriorities: insights.slice(0, 3),
    });
  } catch (err) {
    console.error('[business-health]', err);
    return res.status(500).json({ error: `Failed to compute business health: ${err.message}` });
  }
});

// ---------- AI Advisor (conversational, tool-calling) ----------

app.post('/api/advisor-chat', async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) return res.status(400).json({ error: 'messages array is required' });
    const result = await advisorChat(messages);
    return res.json(result);
  } catch (err) {
    console.error('[advisor-chat]', err);
    return res.status(500).json({ error: `Advisor chat failed: ${err.message}` });
  }
});

// ---------- Pipeline Validation ----------

app.post('/api/validate', (req, res) => {
  uploadSingle(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });

    const pharmacyId = req.body?.pharmacyId || 'default';
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

      const result = normalizeFromSheets(sheets, { pharmacyId, userMapping });
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

app.get('/api/mappings/:pharmacyId', (req, res) => {
  const { pharmacyId } = req.params;
  const mappings = loadPharmacyMappings(pharmacyId);
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
  uploadSingle(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });

    try {
      const sheets = parseSheet(file.buffer);
      const result = normalizeFromSheets(sheets);

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

      // Persist data
      loadFactRecords(result.normalized);

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

app.post('/api/analysis', async (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received.' });

    try {
      const sheets = parseSheet(file.buffer);
      const result = normalizeFromSheets(sheets);

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

      // Persist data
      loadFactRecords(result.normalized);

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
  // Purge FactSales records from datasets classified as non-sales
  factStore.purgeStaleFactSales();
});
