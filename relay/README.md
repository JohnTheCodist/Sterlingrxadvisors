# RxNaija Relay

Credential broker and usage meter sitting between desktop installs and the LLM
provider.

## Why this exists

The desktop build runs on a pharmacy's own PC. An Electron app is a ZIP file —
anyone who buys one copy can open `app.asar` and read a bundled API key in about
five minutes, then run unlimited queries billed to us, with no way to revoke it
that doesn't break every other install.

So the desktop ships **no provider key**. It sends a licence key here; this
service holds the real credential, checks the subscription, meters usage, and
streams the provider's answer back untouched.

## One codebase, two products

This is not a fork. `server/` is shared by both the web product and the desktop
build, and a single environment variable decides where LLM calls go:

| | `LLM_MODE` | Calls | Credential |
|---|---|---|---|
| Web / cloud | unset (default) | provider directly | `LLM_API_KEY` on the server |
| Desktop | `relay` | this relay | `LICENSE_KEY` on the PC |

The switch lives in `server/services/llmTransport.js`. Relay mode requires BOTH
`LLM_MODE=relay` and `RELAY_URL`; anything less falls back to direct, so a
stray `RELAY_URL` in a shared `.env` cannot silently divert the live web
product. There are tests for exactly that.

## Running it

```bash
npm install
LLM_API_KEY=sk-... SEED_LICENSE=RXN-DEV-001 npm start
```

Point a desktop build at it:

```bash
LLM_MODE=relay RELAY_URL=http://localhost:4310 LICENSE_KEY=RXN-DEV-001 npm start
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + whether a provider key is configured |
| GET | `/v1/license/check` | Subscription state and remaining quota |
| GET | `/v1/usage` | Token counts for the current month |
| POST | `/v1/llm/chat` | The proxy. Body in, body out, nothing altered |

All authenticated by an `X-License-Key` header.

## The two rules that must not be broken

**1. The stream passes through byte-for-byte.**
`advisorAgent.js` parses the SSE stream itself and depends on the exact
framing, on `reasoning_content` deltas, and on `usage` arriving in the final
chunk. This proxy forwards bytes and observes them in passing; it never
reformats or buffers. Reformatting breaks the Advisor in ways that only surface
in production, and buffering destroys the time-to-first-token the Advisor was
tuned for.

**2. The relay fails closed; the desktop app fails open.**
No valid licence means no LLM spend — enforced here. But a pharmacy whose
subscription lapsed, or whose internet is down, or who hit us during an outage,
must still open their dashboard, run reports and see their own recommendations.
Those cost us nothing and gating them turns a billing problem into a refund
request. Gate the Advisor, never their own data.

## Measuring cost — the reason this spike was built

Subscription pricing was chosen, so every question is billed to us. Nobody has
measured what a question costs yet.

```bash
LLM_API_KEY=sk-... node measure-cost.js --plan-price 12000
```

Reports per-question tokens, cost in USD and NGN, and the break-even question
count for a given monthly price.

**Read the caveat it prints.** It measures a bare two-message prompt. The live
Advisor also sends 28 tool schemas (~5,900 tokens) on every call, has reasoning
enabled, and makes several round trips per question. The real figure will be
higher — this is the floor. Re-measure through the real `/api/advisor` path
before committing to a price.

## Tests

```bash
npm test
```

16 tests. The first four are the important ones: they prove the live web
product still calls the provider directly with an unchanged URL, header and
body. If those fail, the desktop work has broken the shipping product.

## Not built yet

This is a spike. Before it carries real customers:

- **Licences are an in-memory Map.** They vanish on restart. Needs Postgres.
- **No auth on `/v1/license/check`** beyond the key itself — fine for a spike,
  not for production.
- **No rate limiting** per licence beyond the monthly cap.
- **Quota is checked before the call, recorded after.** Concurrent requests can
  slip one or two over the cap. Needs an atomic reserve-then-commit.
- **No weather or WhatsApp endpoints** yet; the plan has them landing here too.
