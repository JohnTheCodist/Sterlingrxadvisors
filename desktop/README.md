# RxNaija Desktop

An Electron window onto the same product the website serves. No business logic
lives here.

## What this is, and is not

The desktop app loads the **same React UI** from files bundled in the installer,
talking to the **same hosted backend**. A desktop customer is another
organization in the system that already exists, so every feature works
identically — there is only one implementation of each.

What the shell adds is a desktop icon, its own window, no URL bar, no tab to
close by accident, and auto-update. In this market that is worth real money, but
it is packaging, not capability.

**It needs internet.** Everything is server-side. If offline operation is ever
required, see the "when to revisit" note in `RXNAIJA_DESKTOP_PLAN_FINAL.md` —
`llmTransport.js` and `relay/` were built as the seam for it.

## Build

```bash
cd desktop
npm install
RXNAIJA_API_ORIGIN=https://app.rxnaija.com npm run dist
```

Produces `dist/RxNaija-Setup-<version>.exe`.

`RXNAIJA_API_ORIGIN` is baked into the bundle at build time. It defaults to
`https://app.rxnaija.com`; point it elsewhere for staging.

## Develop

```bash
# terminal 1 — the usual dev servers
cd client && npm run dev
cd server && npm start

# terminal 2
cd desktop && npm run dev
```

In dev the shell loads `http://localhost:5173`, so hot reload works normally.
Override with `RXNAIJA_DEV_URL`.

## Two things that will bite

**1. Asset paths.** Electron loads the UI over `file://`, where `/assets/x.js`
resolves to the filesystem root and 404s — producing a blank white window with
no useful error. `build-renderer.js` passes `--base ./` and then *verifies* the
output contains no absolute paths, failing the build if it does. Do not remove
that check.

**2. `client/dist` gets overwritten.** The renderer build writes to
`client/dist`, the same directory the web deploy uses, but with different
settings. After building the desktop app, rebuild the web bundle before
deploying the site:

```bash
cd client && npx vite build
```

A web build has absolute `/assets/...` paths and no API origin baked in. A
desktop build has relative `./assets/...` and the origin compiled in. Shipping
one where the other belongs breaks that target.

## Files

| File | Purpose |
|---|---|
| `main.js` | Window, menu, external-link handling, load-failure dialog |
| `scripts/build-renderer.js` | Builds the client for `file://` and copies it here |
| `package.json` | electron-builder / NSIS installer config |
| `renderer/` | Build output (gitignored) |
