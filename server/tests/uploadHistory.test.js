/**
 * Tests for "how many files have I uploaded" — the question the Advisor
 * answered wrong in production: a pharmacy with one sales file and three
 * stock/expiry/supplier files asked how many files it had and was told "1".
 *
 * Root cause: the only existing mechanism, getDataScope, counts distinct
 * dataset_id FROM THE SALE TABLE — so it only ever sees files that produced
 * sales transaction rows, and it goes silent entirely once that count is
 * ≤ 1 (its actual job is disclosing whether a SALES figure spans one file or
 * several, not answering "how many files exist"). A stock-only or
 * expiry-only upload never touches `sale` at all, so it was invisible to
 * every mechanism the Advisor had.
 *
 * getUploadHistory reads dataset_registry directly instead — the real record
 * of every upload — so these tests stub datasetRegistry.list (not the SQL
 * layer) and assert the count and shape are correct regardless of which
 * capability each file has.
 */

const queriesPath = require.resolve('../services/advisorQueries');
const registryPath = require.resolve('../services/datasetRegistry');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log(`  ok    ${name}`); })
    .catch((e) => { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); });
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

const ORG = '11111111-1111-1111-1111-111111111111';

function withRegistryStub(files, fn) {
  const real = require.cache[registryPath];
  require.cache[registryPath] = {
    id: registryPath, filename: registryPath, loaded: true,
    exports: { list: async () => files },
  };
  delete require.cache[queriesPath];
  const queries = require('../services/advisorQueries');
  return Promise.resolve(fn(queries)).finally(() => {
    require.cache[registryPath] = real;
    delete require.cache[queriesPath];
  });
}

const entry = (over = {}) => ({
  filename: 'file.xlsx', uploadTimestamp: '2026-08-01T00:00:00Z',
  processingStatus: 'processed', rowCount: 10, capabilities: {},
  ...over,
});

async function main() {
  section('The reported case: sales file + non-sales files, all counted');

  await test('a stock/expiry/supplier-only file counts as a real upload', async () => {
    await withRegistryStub(
      [
        entry({ filename: 'pharmacy_daily_sales.xlsx', rowCount: 848, capabilities: { sales: true } }),
        entry({ filename: 'Pharmacy_Inventory_300.xlsx', rowCount: 300, capabilities: { expiry: true } }),
        entry({ filename: 'deepseek_csv.txt', rowCount: 20, capabilities: { expiry: true, supplier: true, inventory: true } }),
        entry({ filename: 'Messy_50.xlsx', rowCount: 50, capabilities: {} }),
      ],
      (q) => q.getUploadHistory(ORG).then((r) => {
        eq(r.totalFiles, 4, 'every registry row counts, not just sales-capable ones');
      }),
    );
  });

  await test('a single sales file no longer under-reports the rest', async () => {
    // The exact regression: getDataScope's block is silent whenever it sees
    // only one dataset in `sale` — which used to mean the Advisor's ONLY
    // signal about file count went dark the moment there was just one sales
    // file, however many other files actually existed.
    await withRegistryStub(
      [entry({ filename: 'only_sales_file.xlsx', capabilities: { sales: true } })],
      (q) => q.getUploadHistory(ORG).then((r) => eq(r.totalFiles, 1)),
    );
  });

  section('Shape of the answer');

  await test('capabilities are reported as names, not a false-heavy object', async () => {
    await withRegistryStub(
      [entry({ capabilities: { sales: true, inventory: false, expiry: true, supplier: false, customer: false } })],
      (q) => q.getUploadHistory(ORG).then((r) => {
        eq(JSON.stringify(r.files[0].capabilities), JSON.stringify(['sales', 'expiry']),
          'only the true capabilities, not the whole object');
      }),
    );
  });

  await test('a file with no detected capability still appears, with an empty list', async () => {
    await withRegistryStub(
      [entry({ filename: 'unclassified.xlsx', capabilities: {} })],
      (q) => q.getUploadHistory(ORG).then((r) => {
        eq(r.totalFiles, 1, 'a failed-classification file is still a file the owner uploaded');
        eq(r.files[0].capabilities.length, 0);
      }),
    );
  });

  await test('every file carries filename, status and row count', async () => {
    await withRegistryStub(
      [entry({ filename: 'a.xlsx', rowCount: 42, processingStatus: 'processed' })],
      (q) => q.getUploadHistory(ORG).then((r) => {
        eq(r.files[0].filename, 'a.xlsx');
        eq(r.files[0].rowCount, 42);
        eq(r.files[0].status, 'processed');
      }),
    );
  });

  section('Files that never finished processing');

  await test('an unprocessed file counts toward totalFiles but not processedFiles', async () => {
    await withRegistryStub(
      [
        entry({ filename: 'done.xlsx', processingStatus: 'processed' }),
        entry({ filename: 'stuck.xlsx', processingStatus: 'schema_detected' }),
      ],
      (q) => q.getUploadHistory(ORG).then((r) => {
        eq(r.totalFiles, 2, 'both are real registry rows');
        eq(r.processedFiles, 1, 'only one actually finished');
        assert(r.note && r.note.includes('schema_detected'), 'the stuck one is named, not silently dropped');
      }),
    );
  });

  await test('when everything processed cleanly, no note is added', async () => {
    await withRegistryStub(
      [entry({ processingStatus: 'processed' }), entry({ processingStatus: 'processed' })],
      (q) => q.getUploadHistory(ORG).then((r) => {
        assert(!('note' in r), 'a clean history should not carry an explanatory note about nothing');
      }),
    );
  });

  section('Empty history');

  await test('an organization with nothing uploaded gets zero, not an error', async () => {
    await withRegistryStub([], (q) => q.getUploadHistory(ORG).then((r) => {
      eq(r.totalFiles, 0);
      eq(r.files.length, 0);
    }));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

main();
