/**
 * LLM Column Mapper — AI-powered column-to-canonical-field mapping.
 *
 * Phase 2 core module. Replaces/augments the rule-based schema detector
 * with LLM-powered semantic understanding of spreadsheet column headers.
 *
 * Two operating modes:
 *   - LLM mode (when LLM_API_KEY is set): Calls an OpenAI-compatible API
 *   - Local mode (no API key): Enhanced rule-based heuristics with
 *     higher-quality confidence scoring
 *
 * Architecture:
 *   1. Build prompt: headers + sample values + canonical schema
 *   2. Call LLM → structured JSON response
 *   3. Parse & validate response
 *   4. Merge with rule-based results
 *   5. Cache results for identical headers
 */

const { DICTIONARY } = require('./dictionary');

// ---- configuration ------------------------------------------------------

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '15000', 10);
const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '1024', 10);
const LLM_TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || '0.1');

// In-memory cache: fingerprint → mapping result
const llmCache = new Map();
const CACHE_MAX_SIZE = 500;

// ---- canonical schema definition (sent to LLM) --------------------------

const CANONICAL_SCHEMA = {
  product_name: {
    description: 'The name of the medicine, drug, or pharmaceutical product sold. Text values like "Paracetamol 500mg", "Amodiaquine Suspension", "Vitamin C". Never numeric, never a date.',
    examples: ['Paracetamol 500mg', 'Coartem 80/480', 'Multivitamin Tablets', 'Amoxicillin 250mg'],
  },
  quantity: {
    description: 'The number of units sold or dispensed. Integer values (1, 2, 5, 10, 100). Usually between 1 and 10,000.',
    examples: ['1', '5', '10', '24', '100'],
  },
  revenue: {
    description: 'The total monetary amount for the transaction or row. Can be selling_price × quantity, or the total invoice amount. Numeric values, often in hundreds or thousands.',
    examples: ['1500', '3500.50', '12000', '750'],
  },
  cost_price: {
    description: 'The cost to purchase or acquire one unit from the supplier. Also called purchase price, buying price, unit cost. Numeric, usually lower than selling_price.',
    examples: ['200', '850.75', '1500', '95'],
  },
  selling_price: {
    description: 'The price at which one unit is sold to the customer. Also called retail price, unit price. Numeric, usually higher than cost_price.',
    examples: ['500', '1200', '2500', '350'],
  },
  date: {
    description: 'The transaction or sale date. Can be string (YYYY-MM-DD, DD/MM/YYYY) or Excel serial number.',
    examples: ['2024-01-15', '15/01/2024', '01/15/2024', '45300'],
  },
  payment_method: {
    description: 'How the customer paid. Values like Cash, Transfer, POS, Card, Insurance, Credit.',
    examples: ['Cash', 'Transfer', 'POS', 'Card'],
  },
  supplier: {
    description: 'The name of the supplier or vendor who provided the products. Text values like "Emzor Pharmaceuticals", "GSK Nigeria", "Orange Drugs". Company name, not a person name.',
    examples: ['Emzor Pharmaceuticals', 'GSK Nigeria', 'Orange Drugs', 'M&B Limited'],
  },
  manufacturer: {
    description: 'The company that manufactured or produced the product. May differ from supplier. Text values like "Pfizer", "Sanofi", "Cipla".',
    examples: ['Pfizer', 'Sanofi', 'Cipla', 'Novartis'],
  },
  brand: {
    description: 'The brand or trade name of the product. Text values like "Panadol", "Coartem", "Augmentin". This is the commercial brand, distinct from the generic name.',
    examples: ['Panadol', 'Coartem', 'Augmentin', 'Flagyl'],
  },
  generic_name: {
    description: 'The generic or INN (International Nonproprietary Name) of the medicine. Text values like "Paracetamol", "Artemether + Lumefantrine", "Metronidazole". Scientific/chemical name.',
    examples: ['Paracetamol', 'Artemether + Lumefantrine', 'Metronidazole', 'Amlodipine'],
  },
  category: {
    description: 'The therapeutic class or product category. Text values like "Analgesic", "Antibiotic", "Antimalarial", "Antihypertensive". A broad classification.',
    examples: ['Analgesic', 'Antibiotic', 'Antimalarial', 'Antihypertensive'],
  },
  subcategory: {
    description: 'A finer product subcategory or segment within a category. Text values like "Penicillin", "Cephalosporin", "NSAID", "ACE Inhibitor".',
    examples: ['Penicillin', 'Cephalosporin', 'NSAID', 'ACE Inhibitor'],
  },
  batch_number: {
    description: 'The manufacturing batch or lot number. Alphanumeric codes like "B2024-001", "LOT-12345", "BN7890". Production control identifier.',
    examples: ['B2024-001', 'LOT-12345', 'BN7890', 'MFG-2024A'],
  },
  expiry_date: {
    description: 'The expiration or shelf-life date of the product. Date format like "2025-12-31", "12/2025", "Dec 2025".',
    examples: ['2025-12-31', '12/2025', 'Dec 2025', '31/12/2025'],
  },
  branch: {
    description: 'The pharmacy branch, store, or outlet name. Text values like "Main Branch", "Ikeja Store", "Surulere Pharmacy", "Shop 12". A physical location.',
    examples: ['Main Branch', 'Ikeja Store', 'Surulere Pharmacy', 'Shop 12'],
  },
  warehouse: {
    description: 'The warehouse or storage location where inventory is kept. Text values like "Central Warehouse", "Cold Storage", "Depot A", "Main Store".',
    examples: ['Central Warehouse', 'Cold Storage', 'Depot A', 'Main Store'],
  },
  sales_channel: {
    description: 'The sales or distribution channel. Text values like "Retail", "Wholesale", "Online", "Hospital", "POS", "OTC". How the sale was made.',
    examples: ['Retail', 'Wholesale', 'Online', 'Hospital'],
  },
  customer: {
    description: 'The customer, client, or patient name. Text values like "John Doe", "Walk-in", "HMO Patient", "Corporate Client". Who purchased the product.',
    examples: ['John Doe', 'Walk-in', 'HMO Patient', 'Corporate Client'],
  },
  sales_representative: {
    description: 'The sales representative, pharmacist, or staff member who made the sale. Text values like "Amina Bello", "Dr. Chukwu", "Pharmacist On Duty". Person name.',
    examples: ['Amina Bello', 'Dr. Chukwu', 'Pharmacist On Duty', 'Oluwaseun Ade'],
  },
  invoice_number: {
    description: 'The invoice, receipt, or transaction reference number. Alphanumeric values like "INV-2024-001", "RCT-56789", "TXN123456". Unique sale identifier.',
    examples: ['INV-2024-001', 'RCT-56789', 'TXN123456', 'REF/24/7890'],
  },
  discount: {
    description: 'The discount amount applied to the sale. Numeric value, can be an absolute amount (₦500) or percentage (10). Usually positive.',
    examples: ['500', '10', '250.50', '0'],
  },
  tax: {
    description: 'The tax or VAT amount. Numeric value, can be an absolute amount (₦275) or percentage (7.5). Usually positive.',
    examples: ['275', '7.5', '150', '0'],
  },
  profit: {
    description: 'The profit amount for the transaction or row. Numeric value, can be absolute profit in currency (₦300) or a computed value. Revenue minus costs.',
    examples: ['300', '1250.75', '5000', '-150'],
  },
  margin: {
    description: 'The profit margin as a percentage. Numeric value like "25", "42.5", "10". Percentage value, not a currency amount.',
    examples: ['25', '42.5', '10', '15.75'],
  },
};

// ---- prompt builder -----------------------------------------------------

/**
 * Build the system prompt that instructs the LLM how to map columns.
 */
function buildSystemPrompt() {
  const schemaDesc = Object.entries(CANONICAL_SCHEMA)
    .map(([name, info]) => `  - "${name}": ${info.description}`)
    .join('\n');

  return `You are a pharmacy data mapping expert. Your job is to map spreadsheet column headers to canonical field names.

## Canonical Fields
${schemaDesc}

## Rules
1. Map each column to the best canonical field based on the header name, sample values, and your understanding of pharmacy data.
2. If a column doesn't match any canonical field, map it to null (skip it).
3. Provide a confidence score from 0.0 to 1.0 for each mapping.
4. Consider both the header text AND the sample values when deciding.
5. "Amount" or "Total" columns are usually revenue (total), not selling_price (per-unit).
6. "Price" or "Rate" columns are usually selling_price (per-unit).
7. Analyze the full column name before deciding. The word "cost" alone does NOT determine the mapping:
   - Columns about the selling side (e.g. "SellingCost", "Selling Cost", "RetailCost", "Sales Price") → selling_price.
   - Columns about purchasing from suppliers (e.g. "PurchaseCost", "SupplierPrice", "BuyingPrice", "AcquisitionCost") → cost_price.
   - Compound terms like "MarginCost", "Margin Cost", "Markup" are neither cost_price nor selling_price — map these to null unless the sample values clearly indicate one or the other.
8. Product/medicine names contain alphabetic characters, not just numbers.
9. Be conservative: if unsure, give a lower confidence score.
10. Return ONLY valid JSON, no markdown, no explanation outside the JSON.`;
}

/**
 * Build the user prompt with the actual headers and sample values.
 */
function buildUserPrompt(headers, sampleValues) {
  const columns = headers.map((header, i) => {
    const samples = (sampleValues[i] || [])
      .filter((v) => v != null && v !== '')
      .slice(0, 5);
    return `  "${header}": samples = [${samples.map((v) => JSON.stringify(v)).join(', ')}]`;
  }).join('\n');

  const fields = Object.keys(CANONICAL_SCHEMA).map((f) => `"${f}"`).join(', ');

  return `Map these spreadsheet columns to canonical fields. Valid fields: ${fields}, or null.

Columns:
${columns}

Return a JSON object mapping each original header to either a canonical field name or null:
{
  "Original Header 1": "canonical_field",
  "Original Header 2": null,
  ...
}

Also include a "_confidence" object with confidence scores (0.0-1.0) for each non-null mapping:
{
  "Original Header 1": "canonical_field",
  ...
  "_confidence": { "Original Header 1": 0.95, ... }
}

Only return the JSON object, nothing else.`;
}

// ---- response parser ----------------------------------------------------

/**
 * Parse and validate the LLM's JSON response.
 * Handles common LLM output issues: markdown fences, trailing commas,
 * extra commentary.
 */
function parseLlmResponse(text) {
  if (!text || typeof text !== 'string') return null;

  // Strip markdown code fences
  let json = text.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/i, '');
    json = json.replace(/\s*```$/, '');
  }

  // Try to find the first JSON object
  const braceStart = json.indexOf('{');
  if (braceStart === -1) return null;
  json = json.substring(braceStart);
  // Find matching closing brace (simple approach)
  let depth = 0;
  let end = -1;
  for (let i = 0; i < json.length; i++) {
    if (json[i] === '{') depth++;
    if (json[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end > 0) json = json.substring(0, end);

  try {
    const parsed = JSON.parse(json);
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Validate the LLM response against the canonical schema.
 * Returns { mapping: {}, confidence: {}, raw: originalResponse }
 */
function validateLlmMapping(parsed, headers) {
  const validFields = new Set(Object.keys(CANONICAL_SCHEMA));
  const mapping = {};
  const confidence = {};
  let invalidCount = 0;

  const llmConfidence = parsed._confidence || {};
  delete parsed._confidence;

  for (const header of headers) {
    const mapped = parsed[header];

    if (mapped === null || mapped === undefined || mapped === '') {
      mapping[header] = null;
      continue;
    }

    if (validFields.has(mapped)) {
      mapping[header] = mapped;
      const conf = typeof llmConfidence[header] === 'number'
        ? llmConfidence[header]
        : 0.7;
      confidence[header] = Math.max(0, Math.min(1, conf));
    } else {
      // LLM returned an invalid field name — try to match heuristically
      invalidCount++;
      const fuzzyMatch = findClosestField(mapped, validFields);
      if (fuzzyMatch) {
        mapping[header] = fuzzyMatch;
        confidence[header] = 0.4;
      } else {
        mapping[header] = null;
      }
    }
  }

  return { mapping, confidence, invalidCount };
}

function findClosestField(name, validFields) {
  const n = name.toLowerCase().trim();
  // Direct matching against DICTIONARY
  for (const [field, synonyms] of Object.entries(DICTIONARY)) {
    if (validFields.has(field) && synonyms.some((s) => s.toLowerCase() === n)) {
      return field;
    }
  }
  // Substring matching
  for (const field of validFields) {
    if (n.includes(field) || field.includes(n)) return field;
  }
  return null;
}

// ---- API caller ---------------------------------------------------------

/**
 * Call the LLM API with the mapping prompt.
 * Returns the parsed JSON response or null on failure.
 */
async function callLlmApi(headers, sampleValues) {
  if (!LLM_API_KEY) return null;

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(headers, sampleValues);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: LLM_MAX_TOKENS,
        temperature: LLM_TEMPERATURE,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[llmMapper] LLM API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = parseLlmResponse(content);
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[llmMapper] LLM API call timed out');
    } else {
      console.warn(`[llmMapper] LLM API call failed: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- local simulation mode ----------------------------------------------

/**
 * Enhanced local mapping using dictionary + heuristics.
 * Produces LLM-compatible output shape when no API key is available.
 */
function localMap(headers, sampleValues) {
  const mapping = {};
  const confidence = {};

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const normalized = normalizeForMatching(header);
    const samples = (sampleValues[i] || []).filter((v) => v != null && v !== '');

    let bestField = null;
    let bestScore = 0;

    for (const [field, synonyms] of Object.entries(DICTIONARY)) {
      let headerScore = 0;

      // Exact match
      for (const syn of synonyms) {
        const sClean = normalizeForMatching(syn);

        if (normalized === sClean || normalized.replace(/\s/g, '') === sClean.replace(/\s/g, '')) {
          headerScore = 1.0;
          break;
        }

        // Substring match
        if (normalized.length >= 2 && sClean.length >= 2) {
          if (normalized.includes(sClean) || sClean.includes(normalized)) {
            const ratio = Math.min(normalized.length, sClean.length) /
                          Math.max(normalized.length, sClean.length);
            headerScore = Math.max(headerScore, ratio);
          }
        }

        // Levenshtein similarity
        const dist = levenshteinDistance(normalized, sClean);
        const maxLen = Math.max(normalized.length, sClean.length);
        if (maxLen > 0) {
          const sim = 1 - dist / maxLen;
          if (sim > headerScore && sim > 0.6) headerScore = sim;
        }
      }

      // Value-pattern bonus
      let valueBonus = 0;
      if (samples.length > 0 && headerScore > 0.3) {
        valueBonus = scoreValuePattern(field, samples, header);
      }

      // Combined score: 60% header, 40% values
      const combined = headerScore > 0
        ? headerScore * 0.6 + valueBonus * 0.4
        : valueBonus * 0.3;

      if (combined > bestScore) {
        bestScore = combined;
        bestField = field;
      }
    }

    if (bestScore > 0.2) {
      mapping[header] = bestField;
      confidence[header] = Math.round(bestScore * 100) / 100;
    } else {
      mapping[header] = null;
    }
  }

  return { mapping, confidence, _confidence: confidence };
}

function normalizeForMatching(text) {
  return String(text)
    .toLowerCase()
    .replace(/[₦$€£¥]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return curr[n];
}

/**
 * Score how well the sample values match the expected pattern for a field.
 */
function scoreValuePattern(field, samples, header) {
  const lower = header.toLowerCase();
  let score = 0;
  let total = 0;

  for (const val of samples) {
    total++;
    const s = String(val).trim();
    const n = Number(s.replace(/[₦$€£¥,%]/g, ''));

    switch (field) {
      case 'product_name':
        if (/[a-zA-Z]/.test(s) && s.length > 2 && !/^\d+$/.test(s) &&
            !/^\d{2,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}$/.test(s)) {
          score++;
        }
        break;
      case 'quantity':
        if (Number.isFinite(n) && n >= 0 && n === Math.floor(n) && n < 100000) score++;
        break;
      case 'revenue':
      case 'selling_price':
      case 'cost_price':
        if (Number.isFinite(n) && n > 0) score++;
        break;
      case 'date':              // legacy canonical
      case 'transaction_date':
        if (/^\d{4}-\d{2}-\d{2}$/.test(s) ||
            /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(s) ||
            (typeof val === 'number' && val >= 30000 && val <= 80000)) {
          score++;
        }
        break;
      case 'payment_method':
        if (/cash|transfer|pos|card|insurance|credit|debit|bank/i.test(s)) score++;
        break;

      // ---- product detail fields ----

      case 'supplier':
      case 'manufacturer':
        if (looksLikeTextValue(s)) score++;
        break;

      case 'brand':
      case 'generic_name':
        if (looksLikeTextValue(s) && s.length > 2 && !/^\d+$/.test(s) &&
            !/^\d{2,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}$/.test(s)) {
          score++;
        }
        break;

      case 'category':
      case 'subcategory':
        if (looksLikeTextValue(s)) score++;
        break;

      case 'batch_number':
        if (/^[a-zA-Z0-9][a-zA-Z0-9\-\/\.\_]{2,30}$/.test(s) && /[a-zA-Z]/.test(s)) {
          score++;
        }
        break;

      case 'expiry_date':
        if (/^\d{4}-\d{2}-\d{2}$/.test(s) ||
            /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}$/.test(s) ||
            /^[a-z]{3,9}\s*\d{2,4}$/i.test(s) ||
            (typeof val === 'number' && val >= 30000 && val <= 80000)) {
          score++;
        }
        break;

      // ---- organizational fields ----

      case 'branch':
      case 'warehouse':
      case 'customer':
      case 'sales_channel':
      case 'sales_representative':
        if (looksLikeTextValue(s)) score++;
        break;

      case 'invoice_number':
        if (s.length >= 2 && s.length <= 40 &&
            !/^\d{2,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}$/.test(s)) {
          score++;
        }
        break;

      // ---- financial detail fields ----

      case 'discount':
      case 'tax':
      case 'profit':
        if (Number.isFinite(n)) score++;
        break;

      case 'margin':
        if (Number.isFinite(n) && n >= 0 && n <= 100) score++;
        break;
    }
  }

  return total > 0 ? score / total : 0;
}

function looksLikeTextValue(s) {
  if (!s || s.length < 1 || s.length > 200) return false;
  return /[a-zA-Z]/.test(s);
}

// ---- fingerprint + cache --------------------------------------------------

function fingerprintHeaders(headers) {
  return headers
    .map((h) => String(h).toLowerCase().trim())
    .sort()
    .join('|');
}

function cacheResult(fingerprint, result) {
  if (llmCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry
    const firstKey = llmCache.keys().next().value;
    llmCache.delete(firstKey);
  }
  llmCache.set(fingerprint, { result, timestamp: Date.now() });
}

function getCachedResult(fingerprint) {
  const entry = llmCache.get(fingerprint);
  if (!entry) return null;
  // Cache for 1 hour
  if (Date.now() - entry.timestamp > 3600000) {
    llmCache.delete(fingerprint);
    return null;
  }
  return entry.result;
}

// ---- public API ----------------------------------------------------------

/**
 * Map spreadsheet columns to canonical fields using LLM + rule-based hybrid.
 *
 * @param {string[]} headers - Raw column header names
 * @param {Array[]} sampleValues - Array of arrays, one per column, containing sample row values
 * @param {object} [options]
 * @param {boolean} [options.forceLocal=false] - Skip LLM, use local mode
 * @param {boolean} [options.skipCache=false] - Bypass the result cache
 * @returns {Promise<object>} { source: 'llm'|'local'|'cache', columns: [{ header, mappedTo, confidence, detections }] }
 */
async function mapColumns(headers, sampleValues, options = {}) {
  if (!headers || headers.length === 0) {
    return { source: 'local', columns: [] };
  }

  const fp = fingerprintHeaders(headers);

  // Check cache first
  if (!options.skipCache) {
    const cached = getCachedResult(fp);
    if (cached) {
      return { ...cached, source: 'cache' };
    }
  }

  let llmResult = null;

  // Try LLM if configured
  if (LLM_API_KEY && !options.forceLocal) {
    llmResult = await callLlmApi(headers, sampleValues);

    if (llmResult) {
      const validated = validateLlmMapping(llmResult, headers);
      const columns = buildColumnsFromMapping(headers, validated.mapping, validated.confidence, sampleValues, 'LLM semantic match');

      const result = { source: 'llm', columns, rawLlm: llmResult };
      cacheResult(fp, { source: 'llm', columns });
      return result;
    }
  }

  // Fall back to local mode
  const localResult = localMap(headers, sampleValues);
  const columns = buildColumnsFromMapping(headers, localResult.mapping, localResult.confidence, sampleValues, 'Local heuristic match');

  const result = { source: 'local', columns };
  cacheResult(fp, { source: 'local', columns });
  return result;
}

/**
 * Build the standard column detection output format from a raw mapping.
 */
function buildColumnsFromMapping(headers, mapping, confidence, sampleValues, sourceLabel = 'LLM semantic match') {
  return headers.map((header, i) => {
    const mappedTo = mapping[header] || null;
    const conf = mappedTo ? (confidence[header] || 0.5) : 0;
    const samples = (sampleValues[i] || []).filter((v) => v != null && v !== '');

    // Build detections array for UI compatibility
    const detections = [];
    if (mappedTo) {
      detections.push({
        category: mappedTo,
        confidence: conf,
        source: sourceLabel,
      });

      // Add alternative detections from value patterns
      for (const [field] of Object.entries(DICTIONARY)) {
        if (field === mappedTo) continue;
        const valueScore = scoreValuePattern(field, samples, header);
        if (valueScore > 0.3) {
          detections.push({
            category: field,
            confidence: Math.round(valueScore * 100) / 100,
            source: 'value pattern',
          });
        }
      }
    }

    return {
      rawHeader: header,
      normalizedHeader: normalizeForMatching(header),
      mappedTo,
      confidence: conf,
      detections,
    };
  });
}

// ---- single-column re-interpretation (user-supplied hint) ---------------

/**
 * Builds the prompt for re-interpreting one column when the user says
 * neither of the top-2 guesses was right and types what it actually means.
 */
function buildReinterpretPrompt(rawHeader, sampleValues, hint) {
  const schemaDesc = Object.entries(CANONICAL_SCHEMA)
    .map(([name, info]) => `  - "${name}": ${info.description}`)
    .join('\n');
  const samples = (sampleValues || [])
    .filter((v) => v != null && v !== '')
    .slice(0, 5)
    .map((v) => JSON.stringify(v))
    .join(', ');

  const system = `You are a pharmacy data mapping expert. A column's automatic guesses were both wrong. The user has described what the column actually means, in their own words. Map it to the single best canonical field, using the user's description as the strongest signal.

## Canonical Fields
${schemaDesc}

## Rules
1. Trust the user's description over the header text or sample values when they conflict.
2. If the user's description doesn't clearly correspond to any canonical field, return null — do not force a weak match.
3. Be conservative: if genuinely unsure, lower the confidence score or return null.
4. Return ONLY valid JSON: {"category": "<field or null>", "confidence": 0.0-1.0}. No markdown, no explanation.`;

  const user = `Column header: "${rawHeader}"
Sample values: [${samples}]
User's description of what this column means: "${hint}"

Return the JSON object.`;

  return { system, user };
}

/**
 * Re-interprets a single column using a user-supplied free-text hint —
 * the escape hatch for when neither algorithmic guess was correct. Never
 * exposes the full field list to the user; instead the LLM reads their
 * plain-language description and either finds a real match or returns
 * null, in which case the caller should skip the column rather than
 * force a low-confidence guess.
 *
 * @returns {Promise<{category: string|null, confidence: number}>}
 */
async function reinterpretColumn(rawHeader, sampleValues, hint) {
  if (!LLM_API_KEY || !hint || !hint.trim()) {
    return { category: null, confidence: 0 };
  }

  const { system, user } = buildReinterpretPrompt(rawHeader, sampleValues, hint.trim());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 200,
        temperature: LLM_TEMPERATURE,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[llmMapper] reinterpretColumn: LLM API returned ${response.status}`);
      return { category: null, confidence: 0 };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const parsed = parseLlmResponse(content);
    if (!parsed || !parsed.category || !CANONICAL_SCHEMA[parsed.category]) {
      return { category: null, confidence: 0 };
    }

    return {
      category: parsed.category,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.6,
    };
  } catch (err) {
    console.warn(`[llmMapper] reinterpretColumn failed: ${err.message}`);
    return { category: null, confidence: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if LLM mode is available.
 */
function isLlmAvailable() {
  return !!LLM_API_KEY;
}

/**
 * Get the configured LLM provider info (for diagnostics).
 */
function getLlmConfig() {
  return {
    available: !!LLM_API_KEY,
    model: LLM_MODEL,
    apiUrl: LLM_API_URL.replace(/\/\/.*@/, '//***@'), // redact credentials in URL
    timeout: LLM_TIMEOUT_MS,
  };
}

module.exports = {
  mapColumns,
  isLlmAvailable,
  getLlmConfig,
  buildUserPrompt,
  parseLlmResponse,
  validateLlmMapping,
  localMap,
  reinterpretColumn,
  CANONICAL_SCHEMA,
};
