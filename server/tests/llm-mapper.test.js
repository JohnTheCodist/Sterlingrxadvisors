// Quick validation test for Phase 2 LLM Column Mapper
const { mapColumns, isLlmAvailable, getLlmConfig } = require('../services/llmMapper');
const { DICTIONARY, getCategory } = require('../services/dictionary');
const { detectSchema, mergeLlmResults } = require('../services/schemaDetector');
const { resolveMapping } = require('../services/columnMapper');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.error('  FAIL:', msg); }
}

// ---- Test dictionary ----
console.log('\n--- Dictionary Tests ---');
assert(getCategory('xyz_not_in_dict') === null, 'Dictionary: getCategory returns null for unknown terms');
assert(getCategory('drug name') === 'product_name', 'Dictionary: getCategory matches "drug name" to product_name');
assert(DICTIONARY.product_name.includes('drug'), 'Dictionary: product_name includes "drug"');
assert(DICTIONARY.revenue.includes('sales amount'), 'Dictionary: revenue includes "sales amount"');
assert(DICTIONARY.cost_price.includes('unit cost'), 'Dictionary: cost_price includes "unit cost"');
assert(DICTIONARY.selling_price.includes('retail price'), 'Dictionary: selling_price includes "retail price"');
assert(DICTIONARY.quantity.includes('qty sold'), 'Dictionary: quantity includes "qty sold"');

// ---- Test LLM mapper: local mode ----
console.log('\n--- LLM Mapper Tests (local mode) ---');
assert(!isLlmAvailable(), 'LLM not available without API key');
assert(getLlmConfig().model === 'gpt-4o-mini', 'Default model is gpt-4o-mini');

async function runMapperTests() {
  // Standard pharmacy headers
  const headers1 = ['Drug', 'Qty', 'Amount', 'Unit Cost', 'Selling Price', 'Date'];
  const values1 = [
    ['Paracetamol', 'Coartem', 'Amodiaquine', 'Vitamin'],
    ['5', '10', '3', '24'],
    ['1500', '3500', '12000', '750'],
    ['200', '850', '1500', '95'],
    ['500', '1200', '2500', '350'],
    ['2024-01-15', '2024-02-20', '2024-03-10', '2024-04-05'],
  ];

  const r1 = await mapColumns(headers1, values1);
  assert(r1.source === 'local', 'Local mode used');

  const drugCol = r1.columns.find(c => c.rawHeader === 'Drug');
  assert(drugCol.mappedTo === 'product_name', 'Drug -> product_name');
  assert(drugCol.confidence > 0.5, 'Drug confidence > 0.5');

  const qtyCol = r1.columns.find(c => c.rawHeader === 'Qty');
  assert(qtyCol.mappedTo === 'quantity', 'Qty -> quantity');

  const amountCol = r1.columns.find(c => c.rawHeader === 'Amount');
  assert(amountCol.mappedTo === 'revenue', 'Amount -> revenue');

  const costCol = r1.columns.find(c => c.rawHeader === 'Unit Cost');
  assert(costCol.mappedTo === 'cost_price', 'Unit Cost -> cost_price');

  const priceCol = r1.columns.find(c => c.rawHeader === 'Selling Price');
  assert(priceCol.mappedTo === 'selling_price', 'Selling Price -> selling_price');

  const dateCol = r1.columns.find(c => c.rawHeader === 'Date');
  assert(dateCol.mappedTo === 'transaction_date', 'Date -> transaction_date');

  // Nigerian pharmacy headers
  const headers2 = ['Medicine Name', 'Quantity Sold', 'Sales Amount', 'Purchase Price', 'Retail Price', 'Transaction Date'];
  const values2 = [
    ['Amodiaquine Susp', 'Paracetamol Tab', 'Coartem 80/480', 'ORS Sachet'],
    ['12', '50', '8', '100'],
    ['2400', '7500', '9600', '5000'],
    ['150', '120', '850', '30'],
    ['250', '180', '1500', '60'],
    ['15/01/2024', '20/02/2024', '10/03/2024', '05/04/2024'],
  ];

  const r2 = await mapColumns(headers2, values2);
  assert(r2.source === 'local', 'Nigerian: local mode');

  const medCol = r2.columns.find(c => c.rawHeader === 'Medicine Name');
  assert(medCol.mappedTo === 'product_name', 'Medicine Name -> product_name');

  const qtySold = r2.columns.find(c => c.rawHeader === 'Quantity Sold');
  assert(qtySold.mappedTo === 'quantity', 'Quantity Sold -> quantity');

  const salesAmt = r2.columns.find(c => c.rawHeader === 'Sales Amount');
  assert(salesAmt.mappedTo === 'revenue', 'Sales Amount -> revenue');

  const purchPrice = r2.columns.find(c => c.rawHeader === 'Purchase Price');
  assert(purchPrice.mappedTo === 'cost_price', 'Purchase Price -> cost_price');

  const retailPrice = r2.columns.find(c => c.rawHeader === 'Retail Price');
  assert(retailPrice.mappedTo === 'selling_price', 'Retail Price -> selling_price');

  const txnDate = r2.columns.find(c => c.rawHeader === 'Transaction Date');
  assert(txnDate.mappedTo === 'transaction_date', 'Transaction Date -> transaction_date');

  // Cache test
  const r3 = await mapColumns(headers1, values1);
  assert(r3.source === 'cache', 'Cache works for repeated headers');

  console.log('\n--- Schema Detector Tests ---');
  // Test schema detector integration
  const rows = [
    { Drug: 'Paracetamol', Qty: 5, Amount: 1500, 'Unit Cost': 200, 'Selling Price': 500, Date: '2024-01-15' },
    { Drug: 'Coartem', Qty: 10, Amount: 3500, 'Unit Cost': 850, 'Selling Price': 1200, Date: '2024-02-20' },
  ];

  const schema = detectSchema(rows);
  assert(schema.length === 6, 'Schema detects 6 columns');

  const drugSchema = schema.find(c => c.rawHeader === 'Drug');
  assert(drugSchema.detections.length > 0, 'Drug has detections');
  assert(drugSchema.detections[0].category === 'product_name', 'Drug top detection is product_name');

  // Test LLM merge
  const llmCols = [
    { rawHeader: 'Drug', mappedTo: 'product_name', confidence: 0.95, detections: [] },
  ];
  const merged = mergeLlmResults(schema, llmCols);
  const mergedDrug = merged.find(c => c.rawHeader === 'Drug');
  const llmDet = mergedDrug.detections.find(d => d.source === 'LLM semantic mapping');
  assert(llmDet != null, 'LLM detection is merged');
  assert(llmDet.confidence === 0.95, 'LLM confidence preserved');

  // Test resolution
  const { mapping, tiers } = resolveMapping(merged);
  assert(mapping.product_name.rawHeader === 'Drug', 'Resolution: product_name from Drug');
  assert(mapping.revenue.rawHeader === 'Amount', 'Resolution: revenue from Amount');
  assert(mapping.quantity.rawHeader === 'Qty', 'Resolution: quantity from Qty');
  assert(tiers.product_name === 'auto', 'product_name auto-mapped');

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runMapperTests().catch(e => { console.error(e); process.exit(1); });
