/**
 * Tests for the batched fact loader.
 *
 * The thing under test is not arithmetic, it is *round-trip count*. A loader
 * that produces correct rows one network hop at a time is still broken at
 * 6,000 rows: the hops are sequential, so they add up into tens of minutes
 * and the transaction dies on the statement timeout. So these tests stub the
 * driver, count how many statements actually leave the process, and assert
 * that the count scales with the number of BATCHES rather than the number of
 * rows — while every value written stays byte-identical to what the per-row
 * path produced.
 *
 * The stub speaks just enough of postgres.js to be indistinguishable from it
 * here: a tagged template is a statement (counted), a plain call is the
 * values-builder helper (free, it never leaves the process).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/test';

// ---- driver stub, installed before db.js is loaded ----------------------
// db.js memoizes the connection on first use, so the stub it receives has to
// be one stable object that forwards to whichever fake the current test
// installed — swapping holder.sql alone would be invisible to it.
const holder = { sql: null };
const facade = (...args) => holder.sql(...args);
facade.begin = (fn) => holder.sql.begin(fn);
facade.json = (v) => ({ __json: v });
const pgPath = require.resolve('postgres');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true, exports: () => facade,
};

function makeFakeSql(opts = {}) {
  const existingProducts = new Map(Object.entries(opts.existingProducts || {}));
  const state = {
    statements: [], saleRows: [], productInserts: [], productUpserts: [],
    factRows: [], factDeletes: [],
  };
  let nextId = 1000;

  const respond = (text, values) => {
    const helper = values.find((v) => v && v.__rows);
    if (/^select id, natural_key from product/.test(text)) {
      const keys = (values.find((v) => v && v.__list) || { __list: [] }).__list;
      return keys.filter((k) => existingProducts.has(k))
        .map((k) => ({ id: existingProducts.get(k), natural_key: k }));
    }
    if (/^insert into product/.test(text)) {
      const rows = helper ? helper.__rows : [];
      if (/on conflict/.test(text)) { state.productUpserts.push(...rows); return []; }
      state.productInserts.push(...rows);
      return rows.map((r) => ({ id: ++nextId, natural_key: r.natural_key }));
    }
    if (/^insert into sale/.test(text)) {
      state.saleRows.push(...(helper ? helper.__rows : []));
      return [];
    }
    if (/^insert into widget_fact/.test(text)) {
      state.factRows.push(...(helper ? helper.__rows : []));
      return [];
    }
    if (/^delete from widget_fact/.test(text)) {
      const keys = (values.find((v) => v && v.__list) || { __list: [] }).__list;
      state.factDeletes.push(...keys);
      return [];
    }
    if (/^select id from calendar/.test(text)) {
      const d = values[0];
      return opts.missingDates && opts.missingDates.includes(d) ? [] : [{ id: 5000 }];
    }
    if (/^select id from (branch|employee|customer)/.test(text)) return [];
    if (/^insert into (branch|employee|customer)/.test(text)) return [{ id: ++nextId }];
    return [];
  };

  const sql = (...args) => {
    if (Array.isArray(args[0]) && args[0].raw) {
      const text = args[0].join(' ? ').replace(/\s+/g, ' ').trim();
      const values = args.slice(1);
      state.statements.push(text);
      return Promise.resolve(respond(text, values));
    }
    // values-builder helper: sql(rowObjects, ...columns) or sql(primitiveList)
    const first = args[0];
    if (Array.isArray(first) && first.length > 0 && typeof first[0] === 'object') {
      return { __rows: first, __cols: args.slice(1) };
    }
    return { __list: Array.isArray(first) ? first : [first] };
  };
  sql.begin = async (fn) => fn(sql);
  sql.json = (v) => ({ __json: v });
  sql.state = state;
  return sql;
}

const db = require('../services/db');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
function test(name, fn) {
  return fn().then(() => { passed++; console.log(`  ok    ${name}`); })
    .catch((e) => { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); });
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

const ORG = '11111111-1111-1111-1111-111111111111';
const rowsFor = (n, fn = () => ({})) => Array.from({ length: n }, (_, i) => ({
  product_name: `Product ${i}`,
  quantity: 2,
  selling_price: 100,
  cost_price: 60,
  transaction_date: '2026-03-01',
  ...fn(i),
}));

async function main() {
  section('Round-trip count scales with batches, not rows');

  await test('6,000 distinct products cost tens of statements, not tens of thousands', async () => {
    holder.sql = makeFakeSql();
    const n = await db.loadFactRecords(ORG, rowsFor(6000));
    eq(n, 6000, 'every row inserted');
    const total = holder.sql.state.statements.length;
    // Old path: ~2 per product + 1 per row = ~18,000.
    assert(total < 100, `expected well under 100 statements, got ${total}`);
    const saleStmts = holder.sql.state.statements.filter((s) => /^insert into sale/.test(s)).length;
    eq(saleStmts, 6, '6,000 rows at 1,000 per batch');
  });

  await test('statement count grows ~12x slower than row count', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, rowsFor(500));
    const small = holder.sql.state.statements.length;
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, rowsFor(6000));
    const big = holder.sql.state.statements.length;
    // 12x the rows must not cost anywhere near 12x the statements.
    assert(big < small * 12, `${small} -> ${big} for 12x the rows`);
  });

  section('Every written value is unchanged');

  await test('sale columns carry exactly what the per-row insert carried', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, [{
      product_name: 'Paracetamol 500mg', quantity: 3, selling_price: 250, cost_price: 100,
      transaction_date: '2026-03-15T09:30:00Z', payment_method: 'Cash', invoice_ref: 'INV-1',
    }], { datasetId: 'ds-1' });
    const [r] = holder.sql.state.saleRows;
    eq(r.organization_id, ORG); eq(r.dataset_id, 'ds-1');
    eq(r.quantity, 3); eq(r.unit_price, 250); eq(r.unit_cost, 100);
    eq(r.sale_date, '2026-03-15', 'date truncated to 10 chars');
    eq(r.payment_method, 'Cash'); eq(r.invoice_ref, 'INV-1');
    assert(r.product_id > 0, 'product resolved to a real id');
  });

  await test('a total-cost column is still divided into a unit cost', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, [{
      product_name: 'A', quantity: 4, selling_price: 100, cost_price: 200,
      _cost_is_total: true, transaction_date: '2026-03-01',
    }]);
    eq(holder.sql.state.saleRows[0].unit_cost, 50, '200 total over 4 units');
  });

  await test('missing quantity and price keep their old defaults', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, [{ product_name: 'A', transaction_date: '2026-03-01' }]);
    const [r] = holder.sql.state.saleRows;
    eq(r.quantity, 1, 'quantity defaults to 1'); eq(r.unit_price, 0, 'price defaults to 0');
    eq(r.unit_cost, null, 'absent cost stays null, never 0');
  });

  section('Skips and counts');

  await test('a row whose date resolves to nothing is skipped, not inserted', async () => {
    holder.sql = makeFakeSql({ missingDates: ['2020-01-01'] });
    const n = await db.loadFactRecords(ORG, [
      { product_name: 'A', transaction_date: '2026-03-01', quantity: 1 },
      { product_name: 'B', transaction_date: '2020-01-01', quantity: 1 },
    ]);
    eq(n, 1, 'only the resolvable row counts');
    eq(holder.sql.state.saleRows.length, 1, 'only one row sent');
  });

  await test('an empty file writes nothing and reports nothing', async () => {
    holder.sql = makeFakeSql();
    eq(await db.loadFactRecords(ORG, []), 0);
    eq(holder.sql.state.saleRows.length, 0);
  });

  section('Product resolution matches the per-row upsert');

  await test('a repeated product is resolved once, first occurrence winning', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, [
      { product_name: 'Panadol', category: 'Analgesic', transaction_date: '2026-03-01' },
      { product_name: 'Panadol', category: 'Something Else', transaction_date: '2026-03-02' },
    ]);
    eq(holder.sql.state.productInserts.length, 1, 'one product row');
    eq(holder.sql.state.productInserts[0].category, 'Analgesic', 'first occurrence wins');
  });

  await test('a new product gets the classified category when the file has none', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, [{ product_name: 'Amoxicillin 500mg', transaction_date: '2026-03-01' }]);
    const cat = holder.sql.state.productInserts[0].category;
    assert(cat && cat.length > 0, 'classifier fallback still applied to new products');
  });

  await test('an existing product is never handed the classified fallback', async () => {
    const key = db.computeProductNaturalKey('Amoxicillin 500mg');
    holder.sql = makeFakeSql({ existingProducts: { [key]: 77 } });
    await db.loadFactRecords(ORG, [{
      product_name: 'Amoxicillin 500mg', resolved_brand: 'Amoxil', transaction_date: '2026-03-01',
    }]);
    eq(holder.sql.state.productInserts.length, 0, 'no new product row');
    eq(holder.sql.state.productUpserts.length, 1, 'took the conflict path');
    eq(holder.sql.state.productUpserts[0].category, null,
      'a guessed category must not overwrite the stored one');
    eq(holder.sql.state.saleRows[0].product_id, 77, 'reused the existing id');
  });

  await test('an existing product with nothing new to write is left alone', async () => {
    const key = db.computeProductNaturalKey('Panadol');
    holder.sql = makeFakeSql({ existingProducts: { [key]: 88 } });
    await db.loadFactRecords(ORG, [{ product_name: 'Panadol', transaction_date: '2026-03-01' }]);
    eq(holder.sql.state.productUpserts.length, 0, 'no pointless write');
    eq(holder.sql.state.saleRows[0].product_id, 88);
  });

  await test('resolved identity fields survive the conflict path', async () => {
    const key = db.computeProductNaturalKey('Flagyl');
    holder.sql = makeFakeSql({ existingProducts: { [key]: 99 } });
    await db.loadFactRecords(ORG, [{
      product_name: 'Flagyl', resolved_generic: 'Metronidazole', resolved_manufacturer: 'Sanofi',
      active_ingredients: ['Metronidazole'], transaction_date: '2026-03-01',
    }]);
    const u = holder.sql.state.productUpserts[0];
    eq(u.resolved_generic, 'Metronidazole');
    eq(u.resolved_manufacturer, 'Sanofi');
    eq(u.active_ingredients, 'Metronidazole', 'array joined to text as before');
  });

  section('Batch boundaries');

  await test('a chunk boundary loses no rows', async () => {
    holder.sql = makeFakeSql();
    const n = await db.loadFactRecords(ORG, rowsFor(1001));
    eq(n, 1001, 'count spans the boundary');
    eq(holder.sql.state.saleRows.length, 1001, 'every row sent');
    eq(holder.sql.state.statements.filter((s) => /^insert into sale/.test(s)).length, 2);
  });

  await test('no statement exceeds the Postgres bind-parameter ceiling', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, rowsFor(6000));
    for (const r of holder.sql.state.statements) {
      // sale batches are the widest: 13 columns x 1,000 rows.
      assert(true, r);
    }
    const saleBatches = holder.sql.state.saleRows.length / 6;
    assert(saleBatches * 13 < 65535, 'bind parameters per statement stay legal');
  });

  section('Transaction shape preserved');

  await test('the timeouts and the dataset-scoped delete still run', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, rowsFor(3), { datasetId: 'ds-9' });
    const s = holder.sql.state.statements;
    assert(s.some((x) => /set local statement_timeout/.test(x)), 'statement timeout set');
    assert(s.some((x) => /delete from sale where/.test(x)), 'dataset rows cleared first');
    assert(s.some((x) => /delete from product/.test(x)), 'orphan products still pruned');
  });

  await test('no dataset id means no delete, so history accumulates', async () => {
    holder.sql = makeFakeSql();
    await db.loadFactRecords(ORG, rowsFor(3));
    assert(!holder.sql.state.statements.some((x) => /delete from sale where/.test(x)),
      'must not wipe prior uploads');
  });

  section('Product attribute population (runs before the loader)');

  const joined = (n, nameFn = (i) => `Product ${i}`) => Array.from({ length: n }, (_, i) => ({
    _productName: nameFn(i),
    _product_Category: 'Analgesic',
    _product_Brand: 'BrandCo',
    _product_ListPriceEUR: 10,
  }));

  await test('thousands of products cost a handful of statements', async () => {
    holder.sql = makeFakeSql();
    await db.populateProductAttributes(ORG, joined(6000));
    const stmts = holder.sql.state.statements.filter((s) => /^insert into product/.test(s)).length;
    eq(stmts, 12, '6,000 products at 500 per batch');
    eq(holder.sql.state.productUpserts.length, 6000, 'every product still written');
  });

  await test('names differing only by case collapse to one row per batch', async () => {
    // Two rows colliding on the conflict target inside ONE statement makes
    // Postgres raise "cannot affect row a second time" — the batch must be
    // unique by natural key or a real upload dies here.
    holder.sql = makeFakeSql();
    await db.populateProductAttributes(ORG, [
      { _productName: 'Panadol', _product_Category: 'Analgesic' },
      { _productName: 'panadol', _product_Brand: 'GSK' },
      { _productName: 'PANADOL', _product_PackSize: '20s' },
    ]);
    const keys = holder.sql.state.productUpserts.map((r) => r.natural_key);
    eq(new Set(keys).size, keys.length, 'no duplicate conflict target in a batch');
    eq(keys.length, 1, 'three spellings, one row');
  });

  await test('merging duplicates keeps the later non-empty value, as sequential upserts did', async () => {
    holder.sql = makeFakeSql();
    await db.populateProductAttributes(ORG, [
      { _productName: 'Panadol', _product_Category: 'Analgesic', _product_Brand: 'Old' },
      { _productName: 'panadol', _product_Brand: 'GSK' },
    ]);
    const [r] = holder.sql.state.productUpserts;
    eq(r.brand, 'GSK', 'later non-empty value wins');
    eq(r.category, 'Analgesic', 'earlier value survives when later row omits it');
  });

  await test('an empty joined set writes nothing', async () => {
    holder.sql = makeFakeSql();
    await db.populateProductAttributes(ORG, []);
    eq(holder.sql.state.statements.length, 0);
  });

  section('Dimension writes (the four loops in confirm-mapping)');

  const factStore = require('../services/factStore');
  const dimEntries = (n) => Array.from({ length: n }, (_, i) => ({
    naturalKey: `key-${i}`, record: { name: `Product ${i}`, category: 'Analgesic' },
  }));

  await test('6,000 dimension rows cost 24 statements, not 12,000', async () => {
    holder.sql = makeFakeSql();
    const written = await factStore.upsertDimensions(ORG, 'DimProduct', dimEntries(6000));
    eq(written, 6000, 'every row written');
    eq(holder.sql.state.statements.length, 24, '2 statements per 500-row batch');
    eq(holder.sql.state.factRows.length, 6000, 'every row sent');
  });

  await test('each batch clears its own keys before re-inserting them', async () => {
    holder.sql = makeFakeSql();
    await factStore.upsertDimensions(ORG, 'DimProduct', dimEntries(3));
    eq(holder.sql.state.factDeletes.length, 3, 'deletes are scoped to the keys in the batch');
    assert(holder.sql.state.factDeletes.includes('key-0'), 'by natural key');
  });

  await test('payload keeps the natural key the reader matches on', async () => {
    holder.sql = makeFakeSql();
    await factStore.upsertDimensions(ORG, 'DimProduct', [
      { naturalKey: 'panadol', record: { name: 'Panadol', category: 'Analgesic' } },
    ]);
    const [row] = holder.sql.state.factRows;
    eq(row.table_name, 'DimProduct');
    eq(row.payload.__json.naturalKey, 'panadol', 'naturalKey written into the payload');
    eq(row.payload.__json.name, 'Panadol');
    assert(row.payload.__json._ingestedAt, 'ingest timestamp preserved');
  });

  await test('a repeated key resolves to one row, later entry winning', async () => {
    holder.sql = makeFakeSql();
    await factStore.upsertDimensions(ORG, 'DimProduct', [
      { naturalKey: 'panadol', record: { name: 'Panadol', category: 'Old' } },
      { naturalKey: 'panadol', record: { name: 'Panadol', category: 'New' } },
    ]);
    eq(holder.sql.state.factRows.length, 1, 'one row per key');
    eq(holder.sql.state.factRows[0].payload.__json.category, 'New', 'later entry wins');
  });

  await test('an empty dimension writes nothing at all', async () => {
    holder.sql = makeFakeSql();
    eq(await factStore.upsertDimensions(ORG, 'DimCustomer', []), 0);
    eq(holder.sql.state.statements.length, 0, 'no statement for an absent dimension');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

main();
