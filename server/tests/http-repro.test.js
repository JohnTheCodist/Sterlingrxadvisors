/**
 * HTTP-level reproduction test for the multi-file "Analyze hangs" bug.
 *
 * Uses Node 22's built-in fetch() to simulate the client flow.
 *
 * Run:  node tests/http-repro.test.js
 */

const { spawn } = require('child_process');
const path = require('path');

// ---- test data ---------------------------------------------------------

const csv1 = `Drug Name,Qty Sold,Selling Price,Cost Price,Sale Date,Payment
Paracetamol 500mg,2,200,100,2024-01-15,Cash
Ibuprofen 400mg,1,500,300,2024-01-16,POS
Amoxicillin 500mg,3,150,90,2024-02-01,Transfer`;

const csv2 = `Product,Quantity,Revenue,Purchase Cost,TransactionDate,PayMethod
Coartem 80/480,2,2400,1200,2024-03-01,Cash
Vitamin C 1000mg,5,1500,500,2024-03-02,POS
Coartem 80/480,3,3600,1800,2024-03-15,Transfer`;

const mapping1 = JSON.stringify({
  'Drug Name': 'product_name',
  'Qty Sold': 'quantity',
  'Selling Price': 'selling_price',
  'Cost Price': 'cost_price',
  'Sale Date': 'transaction_date',
  'Payment': 'payment_method',
});

const mapping2 = JSON.stringify({
  'Product': 'product_name',
  'Quantity': 'quantity',
  'Revenue': 'revenue',
  'Purchase Cost': 'cost_price',
  'TransactionDate': 'transaction_date',
  'PayMethod': 'payment_method',
});

// ---- helpers -----------------------------------------------------------

function makeFile(filename, content) {
  return new File([content], filename, { type: 'text/csv' });
}

// ---- test runner -------------------------------------------------------

let passed = 0;
let failed = 0;

function t(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

// ---- main --------------------------------------------------------------

async function run() {
  console.log('=== HTTP Multi-File Sequential Processing ===\n');

  const PORT = 4099;
  let server;

  // Start server
  try {
    const serverPath = path.join(__dirname, '..', 'index.js');
    server = spawn('node', [serverPath], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    server.stdout.on('data', (d) => { output += d; });
    server.stderr.on('data', (d) => { output += d; });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
      server.stdout.on('data', (d) => {
        if (d.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
      });
    });
    console.log('Server started on port', PORT);
  } catch (e) {
    console.error('Server start failed:', e.message);
    process.exit(1);
  }

  const BASE = `http://localhost:${PORT}`;

  try {
    // ================================================================
    // FILE 1 — should work
    // ================================================================

    console.log('\n>>> Processing file 1...');

    // Step 1: Classify file 1
    const fd1 = new FormData();
    fd1.append('file', makeFile('sales.csv', csv1));
    const classify1 = await fetch(`${BASE}/api/classify-dataset`, { method: 'POST', body: fd1 });
    const c1 = await classify1.json();
    console.log(`  Classify: status=${classify1.status}, type=${c1.primary_type}, caps=${JSON.stringify(c1.capabilities)}`);

    // Step 2: Schema detect file 1
    const fd1s = new FormData();
    fd1s.append('file', makeFile('sales.csv', csv1));
    const schema1 = await fetch(`${BASE}/api/detect-schema`, { method: 'POST', body: fd1s });
    const s1 = await schema1.json();
    console.log(`  Schema: status=${schema1.status}, columns=${s1.columns?.length}, mapped=${s1.mappedCategories?.length}`);

    // Step 3: Confirm mapping (ANALYZE) file 1
    const fd1c = new FormData();
    fd1c.append('file', makeFile('sales.csv', csv1));
    fd1c.append('mapping', mapping1);
    const t1Start = Date.now();
    const confirm1Res = await fetch(`${BASE}/api/confirm-mapping`, { method: 'POST', body: fd1c });
    const confirm1 = await confirm1Res.json();
    const t1Elapsed = Date.now() - t1Start;
    console.log(`  Confirm: status=${confirm1Res.status}, rows=${confirm1.normalizedRowCount}, time=${t1Elapsed}ms`);
    console.log(`  Analytics: revenue=${confirm1.analytics?.metrics?.totalRevenue}, widgets=${confirm1.widgetManifest?.summary?.availableWidgets}`);

    // ================================================================
    // FILE 2 — simulate "Process Another File" then process file 2
    // ================================================================

    console.log('\n>>> Processing file 2 (the bug scenario)...');

    // Step 1: Classify file 2
    const fd2 = new FormData();
    fd2.append('file', makeFile('inventory.csv', csv2));
    const classify2 = await fetch(`${BASE}/api/classify-dataset`, { method: 'POST', body: fd2 });
    const c2 = await classify2.json();
    console.log(`  Classify: status=${classify2.status}, type=${c2.primary_type}, caps=${JSON.stringify(c2.capabilities)}`);

    // Step 2: Schema detect file 2
    const fd2s = new FormData();
    fd2s.append('file', makeFile('inventory.csv', csv2));
    const schema2 = await fetch(`${BASE}/api/detect-schema`, { method: 'POST', body: fd2s });
    const s2 = await schema2.json();
    console.log(`  Schema: status=${schema2.status}, columns=${s2.columns?.length}, mapped=${s2.mappedCategories?.length}`);

    // Step 3: Confirm mapping (ANALYZE) file 2 — THIS IS WHERE IT BREAKS
    const fd2c = new FormData();
    fd2c.append('file', makeFile('inventory.csv', csv2));
    fd2c.append('mapping', mapping2);
    console.log(`  Sending confirm-mapping for file 2...`);
    const t2Start = Date.now();
    let confirm2, confirm2Res;
    try {
      confirm2Res = await fetch(`${BASE}/api/confirm-mapping`, { method: 'POST', body: fd2c, signal: AbortSignal.timeout(20000) });
      confirm2 = await confirm2Res.json();
      const t2Elapsed = Date.now() - t2Start;
      console.log(`  Confirm: status=${confirm2Res.status}, rows=${confirm2.normalizedRowCount}, time=${t2Elapsed}ms`);
      console.log(`  Analytics: revenue=${confirm2.analytics?.metrics?.totalRevenue}, widgets=${confirm2.widgetManifest?.summary?.availableWidgets}`);
    } catch (e) {
      console.log(`  FILE 2 CONFIRM FAILED: ${e.message}`);
      failed++;
    }

    // ================================================================
    // Assertions
    // ================================================================
    console.log('\n=== Assertions ===');

    t('file 1 confirm returns 200', confirm1Res?.status === 200, `got ${confirm1Res?.status}`);
    t('file 1 has normalized records', confirm1?.normalizedRowCount > 0, `got ${confirm1?.normalizedRowCount}`);
    t('file 1 revenue = 1350', confirm1?.analytics?.metrics?.totalRevenue === 1350, `got ${confirm1?.analytics?.metrics?.totalRevenue}`);

    t('file 2 confirm returns 200', confirm2Res?.status === 200, `got ${confirm2Res?.status}: ${JSON.stringify(confirm2?.error || confirm2)}`);
    t('file 2 has normalized records', confirm2?.normalizedRowCount > 0, `got ${confirm2?.normalizedRowCount}`);
    t('file 2 revenue = 7500', confirm2?.analytics?.metrics?.totalRevenue === 7500, `got ${confirm2?.analytics?.metrics?.totalRevenue}`);
    t('file 2 widget manifest exists', !!confirm2?.widgetManifest);
    t('file 2 has available widgets', (confirm2?.widgetManifest?.summary?.availableWidgets || 0) > 0);
    t('file 2 fact store has records', (confirm2?.factStore?.FactSales || 0) > 0);

  } catch (e) {
    console.error('Test error:', e);
    failed++;
  } finally {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'='.repeat(50)}\n`);

    server.kill();
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
  }
}

run();
