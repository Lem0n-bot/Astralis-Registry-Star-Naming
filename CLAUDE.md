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
- **Durability comes from two places.** `lib/store.js` uses Vercel KV when `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set, and falls back to per-instance memory when they are not. Underneath that, `lib/order-codec.js` packs the whole order into the Stripe Checkout Session's metadata (deflate + base64url, chunked across `od0..odN`), so fulfilment can rebuild the order from the webhook payload alone with zero infrastructure. **Keep both paths working** — the metadata fallback is what prevents a charge-with-no-delivery.
- **Fail closed, never silently.** `create-session` refuses the sale (503 `fulfilment_not_configured`) if Resend is unconfigured or the order is unrecoverable. The webhook returns **500** when fulfilment fails so Stripe retries for up to 3 days — do not "fix" it back to an unconditional 200.
- **Fulfilment is idempotent** (durable snapshot + lock) and self-heals a failed receipt email on retry via `repairEmail`.
- **`GET /api/health`** reports which env vars are configured (booleans only). `ready:false` means orders cannot be fulfilled.

Required env in production: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ORDER_TOKEN_SECRET`, `NEXT_PUBLIC_SITE_URL`. See `.env.example`.

### Next.js shell

- `next.config.mjs` — security headers (HSTS, X-Frame-Options, etc.), www→apex permanent redirect, and the `/` → `/index.html` rewrite that serves the app.
- `middleware.js` — defensive HTTPS + canonical-host enforcement at the edge; contains the documented secure-cookie pattern for future session work. Canonical host is `astralis.com.au`; change `CANONICAL_HOST` there and the redirect in `next.config.mjs` together if the domain changes.
- `app/layout.js` / `app/page.js` — metadata shell and a fallback route that is never reached in practice (root is rewritten before it).

The empty `Astralis-Registry-Star-Naming/` directory and `docs/` (README screenshots) are not part of the app.
