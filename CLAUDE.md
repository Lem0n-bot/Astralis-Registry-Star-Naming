# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Astralis is a star-naming e-commerce site: an interactive Three.js galaxy explorer where customers pick a star, personalise a certificate, and go through a **real Stripe checkout**. Payments, certificate PDF rendering and email delivery are live. Live at https://astralisregistry.com, deployed on Vercel.

## Commands

```bash
npm install
npm run dev      # Next.js dev server at http://localhost:3000
npm run build    # production build
npm run start    # serve production build
```

There are no tests and no linter configured. The core experience also runs with zero tooling by opening `public/index.html` directly in a browser.

## Architecture

Almost everything lives in **one file**: `public/index.html` (~1,900 lines). It is a self-contained, dependency-free single-page application — markup, CSS, and all JavaScript — whose only external requests are Three.js r128 from a CDN and Google Fonts. The Next.js 14 (App Router) code around it is a thin deployment shell, not the application.

**Duplicate file warning:** `astralis.html` at the repo root is a byte-identical copy of `public/index.html`. `public/index.html` is the file actually served (the root URL is rewritten to it in `next.config.mjs`), so treat it as canonical — when editing the app, either update both files or update `public/index.html` and re-copy.

### Inside public/index.html

CSS and HTML are organised by `============ SECTION ============` comment banners (NAV, HERO, GALAXY EXPLORER, PACKAGES, PERSONALISE, CHECKOUT MODAL, SUB-PAGES, etc.). The JS at the bottom is split into banner-marked blocks:

- **Front-of-site interactions** (~line 866): 2D canvas starfield, scroll reveals/counters via IntersectionObserver, reservation timer, Web Audio ambience. `$`/`$$` are the querySelector helpers; `reduceMotion` short-circuits heavy animation paths throughout.
- **Certificate rendering** (~line 1014): a data-driven template that renders three certificate instances (hero, live preview, showcase) in two finishes (Midnight/Ivory). Certificates are CSS containers sized entirely in `cqw` units at a fixed 1:1.414 (A4) ratio — keep all certificate measurements in `cqw`.
- **Galaxy explorer** (~line 1154): Three.js scene. 38,000 stars as `THREE.Points` split into three geometry groups by availability state (available / reserved / featured) so raycasting can skip unselectable groups. Orbit controls are custom (the r128 CDN build has no OrbitControls) — spherical coordinates with inertia, pinch, and a camera tween system. Raycast threshold scales with camera distance each frame.
- **Cart + checkout** (~line 1737): cart state, multi-step checkout UI, then `POST /api/checkout/create-session` → hosted Stripe Checkout. Payment is **real** — this takes customers' money.
- **Sub-pages** (~line 1788): `PAGES` object + lightweight client-side router for FAQ/About/Contact/Terms/Privacy/Refunds content.

### Key design invariants

- **Star data has no database.** Every star's full record (ID, coordinates, spectral type, magnitude, availability) is computed deterministically from a hash of its index — nothing is stored or fetched. Scarcity ("Already Named", ~20%) is a deterministic predicate on the same hash.
- **No image/audio assets.** All textures (star sprites, nebulae, backdrop, certificate galaxy backgrounds) are painted onto `<canvas>` at runtime; ambience is synthesised with the Web Audio API. Don't add binary assets to the app.
- **Performance budget:** point clouds render in ~6 draw calls; `setPixelRatio` capped at 2; transparent point materials use `depthWrite: false`; the animation loop is fully suspended while the explorer is closed, and the warp scene and galaxy scene never render in the same frame.
- **Honest marketing is deliberate:** UI and legal copy state that naming is symbolic and not IAU-recognised — preserve this in any copy changes.

### Payments and fulfilment (app/api, app/lib)

Real money moves through here. The flow is:

`create-session` → hosted Stripe Checkout → `webhooks/stripe` → `lib/fulfill.js` → render certificate PDFs → email via Resend.

- **`lib/orders.js` is in-memory and NOT durable.** It is per-serverless-instance, so the instance that fulfils an order is usually not the one that created it.
- **Durability comes from two places.** `lib/store.js` uses Vercel KV when `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set, and falls back to per-instance memory when they are not — or when the store is **unreachable**, which is a case that bit us: the free Upstash database is deleted after 14 days with no commands, and the unguarded KV read at the top of `fulfillOrder()` then threw `getaddrinfo ENOTFOUND` before any work was done, so the webhook answered 500 on every Stripe retry and nobody was emailed. Nothing in `store.js` throws now: an unreachable store logs `kv.unreachable`, opens a short circuit breaker and degrades to memory, while a store that answers *and refuses* (rotated token, oversized value) is still reported as a real failure. A daily Vercel Cron (`vercel.json` → `/api/keepalive`, gated by `CRON_SECRET`) does a real write so the idle timer never expires. Underneath that, `lib/order-codec.js` packs the whole order into the Stripe Checkout Session's metadata (deflate + base64url, chunked across `od0..odN`), so fulfilment can rebuild the order from the webhook payload alone with zero infrastructure. **Keep both paths working** — the metadata fallback is what prevents a charge-with-no-delivery.
- **Fail closed, never silently.** `create-session` refuses the sale (503 `fulfilment_not_configured`) if Resend or the webhook secret is unconfigured, or the order is unrecoverable — and for an order too large to pack into metadata it *pings* the store rather than trusting `isKvConfigured()`, since a deleted database passes every env check and answers no commands. The webhook returns **500** whenever the order was not actually delivered — including `fulfilment_in_progress`, when another instance holds the lock — so Stripe retries for up to 3 days. Do not "fix" any of these back to a 200: a 200 for an unfulfilled order is precisely how a paid customer ends up with nothing, and it is the bug that stranded two live orders.
- **The webhook is the only path that fulfils in production.** `GET /api/checkout/order` is read-only there and returns `fulfilment: 'pending' | 'complete' | 'unpaid'` alongside Stripe's `paid`; the success page polls it and shows the charge as confirmed immediately. It fulfils *only* when `STRIPE_WEBHOOK_SECRET` is unset (local dev without `stripe listen`). It must never render certificates inside a customer's page load — that blew the 60s function limit and told a charged customer their payment "could not be confirmed".
- **Certificate rendering is bounded and runs AFTER the durable snapshot.** Chromium is the one step that can outlive `maxDuration`, and a killed function emails nothing. So `fulfill.js` mints a certificate id for *every* purchased star and persists the paid snapshot first, then renders what fits in `CERT_RENDER_BUDGET_MS` (per-certificate ceiling `CERT_RENDER_TIMEOUT_MS`). Keep the email reachable on every path. A certificate with no cached PDF is not lost: `/api/orders/:id/certificate/:certId` re-renders on demand and the client-side viewer needs no Chromium.
- **PDFs are attached from the in-memory render buffer**, not read back from the store — a base64 certificate PDF (~1.1 MB) exceeds Vercel KV's per-value limit, so `putBlob` is a best-effort cache that legitimately stores nothing.
- **Fulfilment is idempotent** (durable snapshot + lock) and self-heals a failed receipt email on retry via `repairEmail`. Certificate ids are reused across retries so links already in a customer's inbox stay valid.
- **Recovering a stranded order:** `GET /api/admin/fulfill?session_id=cs_live_…` to inspect, `POST` to replay. Gated by `ADMIN_API_TOKEN` (404 while unset). See `docs/RUNBOOK-FULFILMENT.md`.
- **Structured logs.** Every stage emits one JSON line via `lib/log.js` (`create_session.created`, `webhook.received`, `cert.rendered`, `email.sent`, `fulfil.done`, …), so grepping an order number in `vercel logs` reconstructs its whole history. Add stages rather than reverting to bare `console.error`.
- **One exception to "a 500 for anything undelivered":** when the store is unreachable *and* the receipt went out with the PDFs attached, `fulfillOrder` returns `ok:true, degraded:true` and the webhook 200s. Retrying cannot produce a snapshot while the database is down, and every retry for 3 days would re-send the receipt. `fulfil.degraded` is logged and the owner copy carries an amber banner naming the session to replay (which restores the portal + download links, reusing certificate ids). With nothing in the customer's hands it is still a 500. See `docs/RUNBOOK-FULFILMENT.md` §1a.
- **`GET /api/health`** reports which env vars are configured (booleans only) plus the active `fulfilment.path` and render budgets. `ready:false` means orders cannot be fulfilled; `degraded:true` + `warnings` means they complete but something needs attention. `checks.kv` is a **live write + read-back**, not an env check, and `store.{configured,reachable}` separates "no store" from "store not answering".
- **Store probes are unique per run and the probing routes set `fetchCache = 'force-no-store'`.** A framework-cached HTTP response made a repeated `get` never reach the database, so the keepalive reported 503 against a healthy store — and the same mechanism can make a dead store look alive. Don't reintroduce a fixed probe key.

Required env in production: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ORDER_TOKEN_SECRET`, `NEXT_PUBLIC_SITE_URL`. Recommended: `ADMIN_API_TOKEN` (enables the fulfilment replay) and `CRON_SECRET` (without it `/api/keepalive` 404s and the daily cron run fails, so the store can idle out again). See `.env.example` for the optional render budgets and store timeouts.

### Next.js shell

- `vercel.json` — crons only (the daily `/api/keepalive` write). Headers, redirects and rewrites live in `next.config.mjs`; keep it that way so there is one place to look.
- `next.config.mjs` — security headers (HSTS, X-Frame-Options, etc.), www→apex permanent redirect, and the `/` → `/index.html` rewrite that serves the app.
- `middleware.js` — defensive HTTPS + canonical-host enforcement at the edge; contains the documented secure-cookie pattern for future session work. Canonical host is `astralis.com.au`; change `CANONICAL_HOST` there and the redirect in `next.config.mjs` together if the domain changes.
- `app/layout.js` / `app/page.js` — metadata shell and a fallback route that is never reached in practice (root is rewritten before it).

The empty `Astralis-Registry-Star-Naming/` directory and `docs/` (README screenshots) are not part of the app.
