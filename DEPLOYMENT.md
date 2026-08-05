# Deploying to cPanel

One Node process serves the Express API **and** the React site. There is no
separate frontend deploy, no static host, no second service. Get this one
application running and everything is up.

---

## Prerequisites

| | |
|---|---|
| Node | **18.18 or newer** (declared in `engines`). cPanel offers a version picker — pick 20 LTS if it is there. |
| npm | 9 or newer, whatever ships with that Node. |
| Supabase | A project, with migrations in `supabase/migrations/` already applied. |
| cPanel | "Setup Node.js App" available (Passenger). |
| Build machine | Your own computer. See below — you do **not** build on the server. |

---

## Build locally, deploy the result

A production Vite build needs roughly a gigabyte of RAM and a minute of CPU.
Shared cPanel plans usually cap both, and the failure is a killed process with
no useful message. So `client/dist` is committed to the repository on purpose:
you build it where you have the resources, and the server only ever serves it.

```bash
npm install          # installs root, server, and client dependencies
npm run build        # writes client/dist — the website bundle
```

Commit the result. That directory is what the server serves.

> **Never deploy straight after building the desktop app.** The two used to
> write to the same directory. They no longer do — `build-renderer.js` writes
> to `desktop/renderer` and asserts `client/dist` was left alone — but the rule
> is worth keeping: if you are unsure, run `npm run build` again before
> deploying.

---

## Setting up the cPanel application

**1. Upload the code.** Git deploy, or upload everything except `node_modules`,
`client/.env`, and `server/.env`.

**2. Create the app.** cPanel → *Setup Node.js App* → *Create Application*.

| Field | Value |
|---|---|
| Node.js version | 18.18+ (20 LTS preferred) |
| Application mode | Production |
| Application root | the folder you uploaded, e.g. `sterlingrx` |
| Application URL | your domain |
| Application startup file | `app.js` |

`app.js` sits at the repository root and hands off to `server/index.js`. It
exists because cPanel expects a startup file at the application root.

**3. Set environment variables.** Same screen, *Environment variables*. Copy
from `.env.example`. These three are mandatory — the app refuses to start
without them and tells you which are missing:

```
DATABASE_URL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Also set `NODE_ENV=production`. **Do not set `PORT`** — Passenger assigns it.

Use the Supabase **session** pooler connection string, not the transaction
pooler. This app uses prepared statements, which the transaction pooler does
not support.

**4. Install dependencies.** Click *Run NPM Install*. The root `postinstall`
installs `server/` and `client/` too.

**5. Start it.** Click *Restart*. Then check the log — a healthy boot looks
like:

```
SterlingRx Advisors server listening on port 34521
```

---

## Client variables are build-time

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are compiled into the bundle
by Vite. Setting them in cPanel does nothing. They must be in `client/.env`
**when you run `npm run build` locally**. Change either one and you must
rebuild and redeploy.

---

## Restarting

Any code change needs a restart — Passenger caches the loaded application.

- cPanel → *Setup Node.js App* → *Restart*, or
- `touch tmp/restart.txt` in the application root.

---

## After deploying — check all of this

| Check | How | Expected |
|---|---|---|
| Site loads | Visit the domain | Homepage, with the S mark in the navbar |
| Static assets | DevTools → Network | No 404s on `/assets/*`, `/favicon.svg` |
| Compression | Response headers on the JS bundle | `content-encoding: gzip` |
| Security headers | Response headers | `x-content-type-options`, `x-frame-options` present |
| Sign in | Sign in with a real account | Lands on the dashboard |
| Session persists | Close the tab, reopen | Still signed in |
| Database | Dashboard loads figures | No "Can't reach the server" |
| Upload | Upload a sales file end to end | Completes through column mapping |
| AI | Ask Lume a question | Answers from your data |
| Reports | Export the dashboard PDF | Downloads and opens |
| WhatsApp | Message the Twilio number | Replies (needs `PUBLIC_BASE_URL`) |
| Desktop download | Visit `/download` | Shows a build, or says none published |

---

## Troubleshooting

**App won't start; log names missing variables.** Working as designed. Set the
ones it lists in cPanel and restart.

**"Can't reach the server" after signing in.** Sign-in succeeded (that is
Supabase, in the browser) but the API call failed. Check `DATABASE_URL`, and
that you used the session pooler.

**Blank page, 404s on `/assets/*`.** `client/dist` is missing or stale. Rebuild
locally with `npm run build` and redeploy.

**Site loads but every API call goes to `localhost:4000`.** A desktop build got
deployed as the website. Rebuild with `npm run build` and redeploy.

**Uploads fail on large files.** Uploads are held in memory, capped at 50 MB.
Shared plans cap total app memory, so a large file can exhaust the worker.
Try a smaller file; if it is a recurring problem the upload path needs to move
to disk streaming.

**Inventory page shows nothing after an upload.** Known limitation. The last
uploaded file is cached in process memory, and Passenger runs several worker
processes — a request can land on one that does not hold it. Restarting clears
it. The real fix is to persist that cache; see *Remaining risks* in the
deployment report.

**WhatsApp silent.** `PUBLIC_BASE_URL` must be your real HTTPS domain, and
Twilio's webhook must point at `https://yourdomain/api/whatsapp/webhook`.

**Everything worked, then stopped after idle.** Shared hosting stops idle apps.
The first request afterwards is slow — it reloads 6,670 NAFDAC records at
startup. It is not broken, only cold.
