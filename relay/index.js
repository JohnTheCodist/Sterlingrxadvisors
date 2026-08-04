/**
 * SterlingRx Relay — credential broker and usage meter.
 *
 * Exists because the desktop build runs on a pharmacy's own PC, where a
 * bundled provider key could be read straight out of the Electron bundle in
 * about five minutes. So the desktop ships no provider key: it sends a licence
 * key here, and this service supplies the real credential.
 *
 * Three jobs, in order:
 *   1. Decide whether this licence may make the call (active, in date, in quota)
 *   2. Swap the licence key for the provider key and forward the request
 *   3. Stream the provider's answer back BYTE-FOR-BYTE, metering as it passes
 *
 * Step 3 is the one to be careful about. advisorAgent.js parses this stream
 * itself and depends on the exact SSE framing, on `reasoning_content` deltas,
 * and on `usage` arriving in the final chunk. This proxy therefore reformats
 * nothing — it observes the bytes on their way past and forwards them
 * unchanged. Buffering the stream to inspect it would also destroy the
 * time-to-first-token the Advisor was tuned for.
 */

const express = require('express');
const licenses = require('./licenses');

const PORT = process.env.PORT || 4310;
const PROVIDER_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const PROVIDER_KEY = process.env.LLM_API_KEY || '';

const app = express();
// Advisor payloads carry 28 tool schemas plus conversation history; the 100kb
// express default is not enough and the failure looks like a mysterious 413.
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, providerConfigured: Boolean(PROVIDER_KEY), at: new Date().toISOString() });
});

/**
 * What the desktop polls to learn where it stands. Cheap and cacheable — the
 * desktop caches the verdict and tolerates this being unreachable for days.
 */
app.get('/v1/license/check', (req, res) => {
  const key = req.get('X-License-Key') || '';
  const lic = licenses.get(key);
  if (!lic) return res.status(404).json({ active: false, code: 'unknown_license' });

  const plan = licenses.PLANS[lic.plan] || licenses.PLANS.starter;
  const used = licenses.getUsage(key);
  const expired = lic.expiresAt ? new Date(lic.expiresAt) < new Date() : false;

  res.json({
    active: lic.active && !expired,
    pharmacy: lic.pharmacy,
    plan: lic.plan,
    planName: plan.name,
    expiresAt: lic.expiresAt,
    quota: {
      limit: plan.monthlyQuestions === Infinity ? null : plan.monthlyQuestions,
      used: used.requests,
      remaining: plan.monthlyQuestions === Infinity
        ? null
        : Math.max(0, plan.monthlyQuestions - used.requests),
    },
    checkedAt: new Date().toISOString(),
  });
});

/** Usage so far this month — what the pricing decision gets read from. */
app.get('/v1/usage', (req, res) => {
  const key = req.get('X-License-Key') || '';
  if (!licenses.get(key)) return res.status(404).json({ code: 'unknown_license' });
  res.json({ month: licenses.MONTH(), ...licenses.getUsage(key) });
});

/**
 * The proxy. Body in, body out, nothing touched in between.
 */
app.post('/v1/llm/chat', async (req, res) => {
  const key = req.get('X-License-Key') || '';

  const verdict = licenses.authorize(key);
  if (!verdict.ok) {
    // Fail closed here: no licence, no LLM spend. The desktop app fails OPEN
    // for everything that does not cost us money, which is a separate decision
    // made on the client.
    return res.status(verdict.code === 'quota_exceeded' ? 429 : 403).json({
      error: { code: verdict.code, message: verdict.message },
    });
  }

  if (!PROVIDER_KEY) {
    return res.status(503).json({
      error: { code: 'relay_misconfigured', message: 'Relay has no provider credential configured.' },
    });
  }

  // Token counts observed on the way past. Recorded in `finally` so a stream
  // that dies halfway is still billed for what it burned.
  let inputTokens = 0;
  let outputTokens = 0;
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    licenses.recordUsage(key, { inputTokens, outputTokens });
  };

  try {
    const upstream = await fetch(PROVIDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PROVIDER_KEY}`,
      },
      // Forwarded verbatim. The tool schemas and system prompt must stay
      // byte-identical across calls or the provider's prompt cache stops
      // hitting, which measurably slows every answer.
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      record();
      return res.status(upstream.status).type('application/json').send(
        text || JSON.stringify({ error: { code: 'provider_error', message: 'Upstream provider error.' } }),
      );
    }

    // Non-streaming replies (the mapper uses these) pass straight through.
    if (!req.body?.stream) {
      const json = await upstream.json();
      inputTokens = json?.usage?.prompt_tokens || 0;
      outputTokens = json?.usage?.completion_tokens || 0;
      record();
      return res.json(json);
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx and friends will otherwise sit on the stream and hand the client
    // one lump at the end, destroying time-to-first-token.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let meterBuf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Forward first, measure second. The client gets its tokens without
      // waiting for anything we do.
      res.write(Buffer.from(value));

      // Observe usage without altering the stream. Providers put `usage` in a
      // late chunk; we only need that one field, so keep a small tail buffer
      // rather than accumulating the whole answer in memory.
      meterBuf += decoder.decode(value, { stream: true });
      if (meterBuf.length > 16384) meterBuf = meterBuf.slice(-8192);
      const hit = /"usage"\s*:\s*\{[^}]*\}/g;
      let m;
      while ((m = hit.exec(meterBuf)) !== null) {
        try {
          const u = JSON.parse(`{${m[0]}}`).usage;
          if (u) {
            inputTokens = u.prompt_tokens ?? u.input_tokens ?? inputTokens;
            outputTokens = u.completion_tokens ?? u.output_tokens ?? outputTokens;
          }
        } catch { /* partial JSON across a chunk boundary; the next pass gets it */ }
      }
    }

    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: { code: 'relay_upstream_failed', message: err.message } });
    } else {
      res.end();
    }
  } finally {
    record();
  }
});

if (require.main === module) {
  // Dev convenience only. Real licences live in the database this spike does
  // not have yet.
  if (process.env.SEED_LICENSE) {
    licenses.seed(process.env.SEED_LICENSE, { plan: process.env.SEED_PLAN || 'standard' });
    console.log(`[relay] seeded licence ${process.env.SEED_LICENSE}`);
  }
  app.listen(PORT, () => {
    console.log(`[relay] listening on :${PORT}`);
    console.log(`[relay] provider: ${PROVIDER_URL}`);
    console.log(`[relay] provider key: ${PROVIDER_KEY ? 'configured' : 'MISSING'}`);
  });
}

module.exports = { app, licenses };
