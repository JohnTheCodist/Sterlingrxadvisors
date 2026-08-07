#!/usr/bin/env node
/**
 * Refuses to build a bundle that cannot sign anyone in.
 *
 * Vite substitutes VITE_* variables at COMPILE time. When they are absent the
 * build still succeeds and still emits a perfectly valid bundle -- one where
 * `import.meta.env.VITE_SUPABASE_URL` is simply undefined. Nothing warns. The
 * failure surfaces later, in someone's browser:
 *
 *   Uncaught Error: supabaseUrl is required.
 *
 * and the server log stays clean throughout, because the server was never
 * involved. That happened on the first Render deploy: the values live in
 * client/.env, which is gitignored, so a build that had always run on a laptop
 * suddenly ran somewhere that file did not exist.
 *
 * A build is the last moment this is cheap to catch. Failing here costs one
 * red line in a deploy log; not failing costs a broken production site that
 * looks, from every server-side signal, entirely healthy.
 */

// Vite's own loader, not process.env, because those are not the same set and
// the difference is the whole point of this check. Vite reads .env files itself
// once it starts; a plain node script running before it sees only real
// environment variables, so this refused every local build -- client/.env sat
// right there, correctly filled in, and was never consulted.
//
// loadEnv merges both sources: the .env files a developer uses, and the real
// variables Render injects. That is exactly what the build will compile in, so
// this checks the thing that matters instead of an approximation of it.
import { loadEnv } from 'vite';

const env = loadEnv('production', process.cwd(), 'VITE_');

const REQUIRED = [
  ['VITE_SUPABASE_URL', 'Supabase project URL, e.g. https://xxxx.supabase.co'],
  ['VITE_SUPABASE_ANON_KEY', 'Supabase anon/publishable key (safe for browsers)'],
];

const missing = REQUIRED.filter(([key]) => !env[key]);

if (missing.length > 0) {
  console.error('\nCannot build the client: required environment variables are not set.\n');
  for (const [key, why] of missing) {
    console.error(`  ${key}`);
    console.error(`      ${why}\n`);
  }
  console.error('Vite compiles these into the bundle, so a build without them');
  console.error('produces a site that loads and then fails to sign anyone in.\n');
  console.error('Locally:  put them in client/.env');
  console.error('On Render: Dashboard > your service > Environment\n');
  process.exit(1);
}

// Catches the paste that grabbed the wrong key. The service role key bypasses
// row level security entirely, and shipping it to browsers would hand every
// visitor unrestricted access to the database.
if (/service_role/i.test(env.VITE_SUPABASE_ANON_KEY || '')) {
  console.error('\nVITE_SUPABASE_ANON_KEY looks like a SERVICE ROLE key.\n');
  console.error('That key bypasses row level security and would be readable by');
  console.error('anyone who opens the site. Use the anon/publishable key.\n');
  process.exit(1);
}

console.log('Client environment OK — Supabase URL and anon key are set.');
