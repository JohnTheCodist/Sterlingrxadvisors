/**
 * Tests for the relay, and for the promise that matters most while it exists:
 * THE CLOUD/WEB PRODUCT MUST BEHAVE EXACTLY AS BEFORE.
 *
 * The relay is additive. A pharmacy using the web version, and every existing
 * deployment, must keep calling the provider directly with the same URL, the
 * same Authorization header and the same body. If any test in the first
 * section fails, the desktop work has broken the live product and must not
 * ship.
 *
 * The second thing under test is byte-for-byte streaming. advisorAgent.js
 * parses the SSE stream itself and depends on the exact framing, on
 * `reasoning_content` deltas, and on `usage` in the final chunk. A proxy that
 * "helpfully" reformats anything breaks the Advisor in ways that only show up
 * in production.
 */

const http = require('http');

let passed = 0, failed = 0;
const failures = [];
const section = (n) => console.log(`\n=== ${n} ===`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'Assertion failed'); };
const eq = (a, e, m) => { if (a !== e) throw new Error(`${m || 'mismatch'}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };

/** Reload llmTransport under a given environment. */
function transportWith(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const path = require.resolve('../../server/services/llmTransport');
  delete require.cache[path];
  const mod = require(path);
  const result = {
    endpoint: mod.chatEndpoint(),
    isRelayMode: mod.isRelayMode(),
    isConfigured: mod.isConfigured(),
  };
  process.env = saved;
  delete require.cache[path];
  return result;
}

/** A fake provider that streams a scripted SSE body. */
function fakeProvider(chunks, { status = 200, json = null } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        srv.lastRequest = { headers: req.headers, body: body ? JSON.parse(body) : null };
        if (status !== 200) { res.writeHead(status).end(JSON.stringify({ error: 'upstream said no' })); return; }
        if (json) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(json)); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of chunks) {
          res.write(c);
          await new Promise((r) => setTimeout(r, 5));
        }
        res.end();
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

function startRelay() {
  delete require.cache[require.resolve('../index')];
  delete require.cache[require.resolve('../licenses')];
  const { app, licenses } = require('../index');
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, licenses, port: srv.address().port }));
  });
}

async function main() {
  section('The web product must be untouched');

  await test('with no LLM_MODE set, requests go straight to the provider', () => {
    const t = transportWith({ LLM_MODE: '', RELAY_URL: '', LLM_API_KEY: 'sk-live-abc', LLM_API_URL: 'https://api.openai.com/v1/chat/completions' });
    eq(t.endpoint.mode, 'direct');
    eq(t.endpoint.url, 'https://api.openai.com/v1/chat/completions');
    eq(t.endpoint.headers.Authorization, 'Bearer sk-live-abc', 'the provider key must still be sent directly');
    assert(!t.endpoint.headers['X-License-Key'], 'no licence header belongs on a direct call');
  });

  await test('a custom LLM_API_URL is still honoured', () => {
    const t = transportWith({ LLM_MODE: '', RELAY_URL: '', LLM_API_KEY: 'k', LLM_API_URL: 'https://api.deepseek.com/v1/chat/completions' });
    eq(t.endpoint.url, 'https://api.deepseek.com/v1/chat/completions');
  });

  await test('RELAY_URL alone does NOT divert the web product', () => {
    // Someone sets RELAY_URL in a shared .env while testing the desktop build.
    // The cloud product must not silently start routing through it.
    const t = transportWith({ LLM_MODE: '', RELAY_URL: 'https://relay.example.com', LLM_API_KEY: 'sk-live-abc' });
    eq(t.endpoint.mode, 'direct', 'relay mode must be opted into explicitly');
  });

  await test('LLM_MODE=relay without a RELAY_URL falls back to direct, not to broken', () => {
    const t = transportWith({ LLM_MODE: 'relay', RELAY_URL: '', LLM_API_KEY: 'sk-live-abc' });
    eq(t.endpoint.mode, 'direct', 'a half-configured relay must not disable the Advisor');
  });

  section('Desktop mode');

  await test('relay mode sends a licence key and no provider key', () => {
    const t = transportWith({ LLM_MODE: 'relay', RELAY_URL: 'https://relay.example.com', LICENSE_KEY: 'RXN-123', LLM_API_KEY: '' });
    eq(t.endpoint.mode, 'relay');
    eq(t.endpoint.url, 'https://relay.example.com/v1/llm/chat');
    eq(t.endpoint.headers['X-License-Key'], 'RXN-123');
    assert(!t.endpoint.headers.Authorization, 'a provider key must never leave the relay');
  });

  await test('a trailing slash on RELAY_URL does not produce a double slash', () => {
    const t = transportWith({ LLM_MODE: 'relay', RELAY_URL: 'https://relay.example.com/', LICENSE_KEY: 'k' });
    eq(t.endpoint.url, 'https://relay.example.com/v1/llm/chat');
  });

  await test('isConfigured asks for the right credential per mode', () => {
    eq(transportWith({ LLM_MODE: 'relay', RELAY_URL: 'https://r.x', LICENSE_KEY: '', LLM_API_KEY: 'sk-live' }).isConfigured, false,
      'a provider key is useless to the desktop build; it needs a licence');
    eq(transportWith({ LLM_MODE: 'relay', RELAY_URL: 'https://r.x', LICENSE_KEY: 'RXN-1', LLM_API_KEY: '' }).isConfigured, true);
    eq(transportWith({ LLM_MODE: '', RELAY_URL: '', LLM_API_KEY: 'sk-live' }).isConfigured, true);
  });

  section('Licence enforcement at the relay');

  const { srv: relay, licenses, port } = await startRelay();
  const base = `http://127.0.0.1:${port}`;
  const call = (key, body = { stream: false, messages: [] }) => fetch(`${base}/v1/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-License-Key': key },
    body: JSON.stringify(body),
  });

  await test('an unknown licence is refused', async () => {
    const r = await call('nope');
    eq(r.status, 403);
    eq((await r.json()).error.code, 'unknown_license');
  });

  await test('an inactive subscription is refused', async () => {
    licenses.seed('RXN-OFF', { active: false });
    eq((await call('RXN-OFF')).status, 403);
  });

  await test('an expired subscription is refused', async () => {
    licenses.seed('RXN-OLD', { expiresAt: '2020-01-01' });
    eq((await call('RXN-OLD')).status, 403);
  });

  await test('exceeding the monthly quota returns 429, and says what still works', async () => {
    licenses.seed('RXN-CAP', { plan: 'starter' });
    for (let i = 0; i < 100; i++) licenses.recordUsage('RXN-CAP', {});
    const r = await call('RXN-CAP');
    eq(r.status, 429);
    const body = await r.json();
    eq(body.error.code, 'quota_exceeded');
    assert(/dashboard/i.test(body.error.message),
      'a capped owner must be told the rest of the product still works');
  });

  section('Streaming passes through untouched');

  const SSE = [
    'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Stock "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Paracetamol."}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5900,"completion_tokens":180}}\n\n',
    'data: [DONE]\n\n',
  ];

  await test('the SSE body arrives byte-for-byte identical', async () => {
    const provider = await fakeProvider(SSE);
    process.env.LLM_API_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.LLM_API_KEY = 'sk-provider';
    const { srv: r2, licenses: l2, port: p2 } = await startRelay();
    l2.seed('RXN-OK');

    const res = await fetch(`http://127.0.0.1:${p2}/v1/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': 'RXN-OK' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    eq(text, SSE.join(''), 'the Advisor parses this stream itself; a single altered byte breaks it');

    r2.close(); provider.close();
  });

  await test('the request body reaches the provider unchanged, with OUR key swapped in', async () => {
    const provider = await fakeProvider(SSE);
    process.env.LLM_API_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.LLM_API_KEY = 'sk-provider-secret';
    const { srv: r3, licenses: l3, port: p3 } = await startRelay();
    l3.seed('RXN-OK');

    const sent = { stream: true, model: 'deepseek-v4', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 't' }], temperature: 0.3 };
    await (await fetch(`http://127.0.0.1:${p3}/v1/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': 'RXN-OK' },
      body: JSON.stringify(sent),
    })).text();

    eq(JSON.stringify(provider.lastRequest.body), JSON.stringify(sent),
      'body must be forwarded verbatim or the provider prompt cache stops hitting');
    eq(provider.lastRequest.headers.authorization, 'Bearer sk-provider-secret');
    assert(!provider.lastRequest.headers['x-license-key'],
      'the licence key is ours, not the provider\'s');

    r3.close(); provider.close();
  });

  section('Metering — the number this spike exists to produce');

  await test('token usage is read out of the stream', async () => {
    const provider = await fakeProvider(SSE);
    process.env.LLM_API_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.LLM_API_KEY = 'sk-provider';
    const { srv: r4, licenses: l4, port: p4 } = await startRelay();
    l4.seed('RXN-METER');

    await (await fetch(`http://127.0.0.1:${p4}/v1/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': 'RXN-METER' },
      body: JSON.stringify({ stream: true, messages: [] }),
    })).text();

    const u = l4.getUsage('RXN-METER');
    eq(u.requests, 1);
    eq(u.inputTokens, 5900, 'prompt tokens must be captured for costing');
    eq(u.outputTokens, 180, 'completion tokens must be captured for costing');

    r4.close(); provider.close();
  });

  await test('a request is still metered when the provider errors', async () => {
    const provider = await fakeProvider([], { status: 500 });
    process.env.LLM_API_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.LLM_API_KEY = 'sk-provider';
    const { srv: r5, licenses: l5, port: p5 } = await startRelay();
    l5.seed('RXN-ERR');

    await fetch(`http://127.0.0.1:${p5}/v1/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': 'RXN-ERR' },
      body: JSON.stringify({ stream: true, messages: [] }),
    });

    eq(l5.getUsage('RXN-ERR').requests, 1, 'a failed call still consumed provider capacity');
    r5.close(); provider.close();
  });

  await test('/v1/license/check reports remaining quota for the desktop app', async () => {
    licenses.seed('RXN-Q', { plan: 'standard', pharmacy: 'Ikeja Pharmacy' });
    licenses.recordUsage('RXN-Q', {});
    const r = await fetch(`${base}/v1/license/check`, { headers: { 'X-License-Key': 'RXN-Q' } });
    const b = await r.json();
    eq(b.active, true);
    eq(b.pharmacy, 'Ikeja Pharmacy');
    eq(b.quota.limit, 300);
    eq(b.quota.remaining, 299);
  });

  relay.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
