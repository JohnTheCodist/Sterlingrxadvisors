# SterlingRx Desktop

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
required, see the "when to revisit" note in `STERLINGRX_DESKTOP_PLAN_FINAL.md` —
`llmTransport.js` and `relay/` were built as the seam for it.

## Build

```bash
cd desktop
npm install
STERLINGRX_API_ORIGIN=https://app.sterlingrxadvisors.com npm run dist
```

Produces `dist/SterlingRx-Setup-<version>.exe`.

`STERLINGRX_API_ORIGIN` is baked into the bundle at build time. It defaults to
`https://app.sterlingrxadvisors.com`; point it elsewhere for staging.

## Develop

```bash
# terminal 1 — the usual dev servers
cd client && npm run dev
cd server && npm start

# terminal 2
cd desktop && npm run dev
```

In dev the shell loads `http://localhost:5173`, so hot reload works normally.
Override with `STERLINGRX_DEV_URL`.

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

## Before the first build: enable Developer Mode

`npm run dist` fails on a stock Windows install:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : ...\winCodeSign\<id>\darwin\10.12\lib\libcrypto.dylib
```

electron-builder unpacks a toolkit containing macOS symlinks, and Windows
refuses to create symlinks unless the process is elevated or Developer Mode is
on. The files it chokes on are under `darwin/` — macOS libraries irrelevant to
a Windows build — but the extraction fails as a whole, and it retries into a
fresh directory each time, so the cache never helps.

**Fix once, then it stays fixed:**

Settings → System → For developers → **Developer Mode: On**

Or from an elevated PowerShell:

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" -Name AllowDevelopmentWithoutDevLicense -Value 1 -PropertyType DWORD -Force
```

Building from an Administrator terminal also works, per build.

### Do not "fix" it with signAndEditExecutable: false

That flag makes the build succeed, and the installer it produces is broken as a
product. Skipping the executable edit means skipping `rcedit`, which is what
writes the icon and version metadata into the exe. The result:

```
ProductName:     Electron        ← should be SterlingRx Advisors
FileDescription: Electron
FileVersion:     33.4.11         ← Electron's version, not ours
icon:            Electron logo   ← should be the teal Rx mark
```

A pharmacy owner sees the Electron logo on their desktop and "Electron" in Task
Manager. Use it to check the rest of the pipeline if you must, never to ship.

## Code signing — read before sending the installer to anyone

The build produces an **unsigned** installer. It works, but on a customer's PC
Windows SmartScreen shows a full-screen blue warning:

> Windows protected your PC — Microsoft Defender SmartScreen prevented an
> unrecognised app from starting.

The "Run anyway" button is hidden behind a "More info" link. A pharmacy owner
who paid for software and is then told by Windows that it is dangerous will
mostly not click through — they will ask for a refund. Some antivirus products
go further and quarantine the file outright.

This is not something the code can fix; it is about who vouches for the binary.

**Options, cheapest first:**

| Option | Cost/yr | SmartScreen |
|---|---|---|
| Ship unsigned | ₦0 | Blue warning on every install |
| OV certificate | ~$200–400 | Warning until reputation builds (weeks–months of installs) |
| **EV certificate** | ~$300–600 | **Trusted immediately, no warning** |

EV is the only one that works from the first install. It requires a hardware
token or cloud HSM, and the issuer verifies the business — budget a couple of
weeks for that, not a couple of days.

Once you have a certificate, electron-builder picks it up from the environment;
no config change is needed:

```bash
export CSC_LINK=/path/to/cert.pfx
export CSC_KEY_PASSWORD=...
npm run dist
```

**Until then**, ship with install instructions that pre-empt the warning:
tell the customer it will appear, that it means "not yet signed" rather than
"unsafe", and exactly which link to click. Saying it first is the difference
between a support ticket and a refund.

## Files

| File | Purpose |
|---|---|
| `main.js` | Window, menu, external-link handling, load-failure dialog |
| `scripts/build-renderer.js` | Builds the client for `file://` and copies it here |
| `package.json` | electron-builder / NSIS installer config |
| `renderer/` | Build output (gitignored) |
