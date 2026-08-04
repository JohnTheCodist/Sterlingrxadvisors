# SterlingRx Advisors

Pharmacy business intelligence site — React (Vite) frontend + Node.js/Express backend.

## Structure

```
sterlingrx-analytics/
├── client/     React app (Vite + React Router) — all pages, white/light theme
└── server/     Express API (contact form endpoint, serves the built client in production)
```

## Run it locally

**1. Start the API**
```
cd server
npm install
npm run dev
```
Runs on http://localhost:4000

**2. Start the frontend (separate terminal)**
```
cd client
npm install
npm run dev
```
Runs on http://localhost:5173 and proxies `/api/*` calls to the server.

## Production build

```
cd client
npm install
npm run build
```

This outputs `client/dist`. The server (`server/index.js`) automatically serves that folder as static files and handles the SPA fallback, so in production you only need to run:

```
cd server
npm install
npm start
```

and visit http://localhost:4000 — it serves the built React app and the API from one process.

## Pages

- `/` — Home
- `/features` — Features
- `/pricing` — Pricing
- `/how-it-works` — How It Works
- `/case-studies` — Case Studies / Customer Success
- `/contact` — Contact (posts to `POST /api/contact`)

## Design

Light theme (near-white background), deep emerald + naira-gold accent, Fraunces for display headings, Inter for body text, IBM Plex Mono for numbers/stats. All copy is written for the Nigerian pharmacy market (NHIA claims, Naira, counter/wholesale/e-channel sales split) — swap out placeholder stats and testimonials with real numbers before launch.
