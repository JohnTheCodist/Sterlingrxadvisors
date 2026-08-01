/**
 * Tests for resolving "the current upload".
 *
 * Almost every Advisor tool scopes itself to this one value, so when it points
 * at the wrong dataset every scoped answer is wrong in the same breath — and
 * wrong in the most confusing possible way, because the Advisor correctly
 * reports that the file it is looking at has no readable fields while the
 * owner is staring at a file that uploaded fine.
 *
 * Two independent defects produced exactly that, and both are guarded here:
 * a re-uploaded file kept the timestamp of the first time it was ever seen, so
 * it could never become the newest; and the newest row won regardless of
 * whether its mapping had ever completed, so a failed upload silently became
 * the answer to every question.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/test';

const holder = { sql: null };
const facade = (...args) => holder.sql(...args);
facade.begin = (fn) => holder.sql.begin(fn);
facade.json = (v) => ({ __json: v });
const pgPath = require.resolve('postgres');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: () => facade };

/** @param {Array} rows registry rows, any order */
function makeFakeSql(rows = []) {
  const state = { statements: [], timestampBumped: false, inserted: [] };
  // Mirrors the SQL: greatest(upload_timestamp, coalesce(updated_at, upload_timestamp))
  const seenAt = (r) => Math.max(r.upload_timestamp, r.updated_at || r.upload_timestamp);
  const sorted = () => [...rows].sort((a, b) => seenAt(b) - seenAt(a));

  const respond = (text, values) => {
    state.statements.push(text);
    if (/^update dataset_registry set upload_timestamp/.test(text)) {
      const fingerprint = values[1];
      const hit = rows.find((r) => r.fingerprint === fingerprint);
      if (!hit) return [];
      state.timestampBumped = true;
      hit.upload_timestamp = new Date();
      return [hit];
    }
    if (/processing_status = .?processed/.test(text)) {
      return sorted().filter((r) => r.processing_status === 'processed').slice(0, 1);
    }
    if (/^select \* from dataset_registry/.test(text)) {
      return sorted().slice(0, 1);
    }
    if (/^insert into dataset_registry/.test(text)) {
      const row = { id: 'new-id', filename: 'new.xlsx', processing_status: 'registered',
        upload_timestamp: new Date(), sheet_names: [] };
      state.inserted.push(row);
      rows.push(row);
      return [row];
    }
    return [];
  };

  const sql = (...args) => {
    if (Array.isArray(args[0]) && args[0].raw) {
      const text = args[0].join(' ? ').replace(/\s+/g, ' ').trim();
      return Promise.resolve(respond(text, args.slice(1)));
    }
    const first = args[0];
    if (Array.isArray(first) && first.length && typeof first[0] === 'object') return { __rows: first };
    return { __list: Array.isArray(first) ? first : [first] };
  };
  sql.begin = async (fn) => fn(sql);
  sql.json = (v) => ({ __json: v });
  sql.state = state;
  return sql;
}

const reg = require('../services/datasetRegistry');

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
const at = (iso) => new Date(iso);
const row = (filename, status, iso, extra = {}) => ({
  id: filename, filename, processing_status: status,
  upload_timestamp: at(iso), sheet_names: [], ...extra,
});

async function main() {
  section('A failed upload is not "the current upload"');

  await test('a newer file whose mapping never completed does not win', async () => {
    // Exactly the reported state: the newest row is a file that stopped at
    // schema detection and holds no facts, while a real dataset sits below it.
    holder.sql = makeFakeSql([
      row('NAFDAC_v4.xlsx', 'schema_detected', '2026-07-31T16:00:00Z'),
      row('Pharmacy_Sales_500.xlsx', 'processed', '2026-07-31T15:00:00Z'),
    ]);
    const latest = await reg.getLatest(ORG);
    eq(latest.filename, 'Pharmacy_Sales_500.xlsx', 'must skip the unprocessed newer row');
  });

  await test('a merely registered file does not win either', async () => {
    holder.sql = makeFakeSql([
      row('just_uploaded.xlsx', 'registered', '2026-07-31T18:00:00Z'),
      row('real.xlsx', 'processed', '2026-07-30T09:00:00Z'),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'real.xlsx');
  });

  await test('the newest PROCESSED file wins among several', async () => {
    holder.sql = makeFakeSql([
      row('older.xlsx', 'processed', '2026-07-28T09:00:00Z'),
      row('newest_processed.xlsx', 'processed', '2026-07-30T09:00:00Z'),
      row('failed.xlsx', 'schema_detected', '2026-07-31T09:00:00Z'),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'newest_processed.xlsx');
  });

  section('Recently processed beats recently registered');

  await test('a file re-processed minutes ago beats one registered days later', async () => {
    // The reported case exactly. pharmacy_daily_sales was first submitted on
    // the 29th and successfully re-processed today, but its upload_timestamp
    // was never refreshed, so ordering on that field alone put a file from the
    // 31st ahead of it — while the dashboard, which renders the upload's own
    // response, was showing the 29th file's numbers. Both must name one file.
    holder.sql = makeFakeSql([
      row('pharmacy_daily_sales.xlsx', 'processed', '2026-07-29T08:29:25Z',
        { updated_at: at('2026-08-01T05:30:24Z') }),
      row('Pharmacy_Sales_500.xlsx', 'processed', '2026-07-31T15:00:00Z',
        { updated_at: at('2026-07-31T15:00:00Z') }),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'pharmacy_daily_sales.xlsx',
      'last processed wins over last registered');
  });

  await test('a stale updated_at never drags a file ahead of a newer arrival', async () => {
    holder.sql = makeFakeSql([
      row('old_but_touched.xlsx', 'processed', '2026-07-20T08:00:00Z',
        { updated_at: at('2026-07-21T08:00:00Z') }),
      row('genuinely_newest.xlsx', 'processed', '2026-07-31T15:00:00Z',
        { updated_at: at('2026-07-31T15:00:00Z') }),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'genuinely_newest.xlsx');
  });

  await test('a row that has never been updated still sorts on its arrival', async () => {
    holder.sql = makeFakeSql([
      row('never_updated.xlsx', 'processed', '2026-07-31T16:00:00Z'), // updated_at absent
      row('older.xlsx', 'processed', '2026-07-30T09:00:00Z', { updated_at: at('2026-07-30T09:00:00Z') }),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'never_updated.xlsx', 'null updated_at must not sort last');
  });

  section('Falling back rather than returning nothing');

  await test('when nothing has processed yet, the newest row is still named', async () => {
    // A first upload mid-flight must not leave callers with null — they still
    // need a filename to talk about.
    holder.sql = makeFakeSql([
      row('first_ever.xlsx', 'schema_detected', '2026-07-31T16:00:00Z'),
      row('also_failed.xlsx', 'registered', '2026-07-31T15:00:00Z'),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'first_ever.xlsx');
  });

  await test('an organization with no datasets resolves to nothing, not a crash', async () => {
    holder.sql = makeFakeSql([]);
    eq(await reg.getLatest(ORG), null);
  });

  section('Re-uploading a file makes it current again');

  await test('sending the same file again refreshes its upload time', async () => {
    // Without this the row keeps the timestamp of the first time it was ever
    // seen, so re-uploading last week's file and watching it process fine
    // still leaves some other file answering "what did I just upload?".
    const buffer = Buffer.from('the same bytes arriving a second time');
    const existing = row('daily_sales.xlsx', 'processed', '2026-07-29T08:29:25Z', {
      fingerprint: reg.computeFingerprint(buffer, 'daily_sales.xlsx'),
    });
    holder.sql = makeFakeSql([existing]);
    const before = existing.upload_timestamp.getTime();

    const result = await reg.register(ORG, {
      buffer, filename: 'daily_sales.xlsx', mimeType: 'application/vnd.ms-excel',
    });

    assert(holder.sql.state.timestampBumped, 'the duplicate path must write, not just read');
    assert(existing.upload_timestamp.getTime() > before, 'timestamp moved forward');
    eq(result.isDuplicate, true, 'still reported as a duplicate, not a new dataset');
    eq(holder.sql.state.inserted.length, 0, 'no second row created for the same file');
  });

  await test('a re-uploaded file becomes the current upload again', async () => {
    const buffer = Buffer.from('last week\'s file, sent again');
    const daily = row('daily_sales.xlsx', 'processed', '2026-07-29T08:29:25Z', {
      fingerprint: reg.computeFingerprint(buffer, 'daily_sales.xlsx'),
    });
    holder.sql = makeFakeSql([
      daily,
      row('something_else.xlsx', 'processed', '2026-07-31T15:00:00Z'),
    ]);
    eq((await reg.getLatest(ORG)).filename, 'something_else.xlsx', 'before re-upload');

    await reg.register(ORG, { buffer, filename: 'daily_sales.xlsx', mimeType: 'x' });
    eq((await reg.getLatest(ORG)).filename, 'daily_sales.xlsx', 'after re-upload it is current');
  });

  await test('a genuinely new file still registers as new', async () => {
    holder.sql = makeFakeSql([row('old.xlsx', 'processed', '2026-07-29T08:00:00Z', { fingerprint: 'aaa' })]);
    const r = await reg.register(ORG, {
      buffer: Buffer.from('brand new contents'), filename: 'brand_new.xlsx', mimeType: 'x',
    });
    eq(r.isDuplicate, false, 'not a duplicate');
    eq(holder.sql.state.inserted.length, 1, 'one row created');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

main();
