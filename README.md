# Astralis - Interactive 3D Star-Naming E-Commerce Platform

A production e-commerce experience where customers fly through a procedurally
generated 3D galaxy, discover and claim a star, personalise a certificate in
real time, pay through Stripe, and receive a high-resolution PDF certificate by
email - with optional printed keepsakes shipped within Australia.

**Live:** https://astralisregistry.com
**Stack:** Three.js (WebGL) · Vanilla JS · Next.js 14 (App Router) · Stripe · Resend · Headless Chromium · Vercel

> 📐 New to the codebase? Read **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** -
> it walks through every flow and module end to end.

---

## Overview

Star-naming gifts are usually sold from a static product page: pick a package,
type a name, check out. **Astralis reframes the purchase as an experience.**
Instead of selecting from a catalogue, the customer flies through an interactive
spiral galaxy of 38,000+ stars, inspects real astronomical properties (spectral
class, magnitude, distance, constellation), and claims a star they discovered
themselves - which measurably increases intent for an emotional, high-margin
gift.

Architecturally the project is split in two:

- a **dependency-free single-file front end** (`public/index.html`, ~4,000 lines)
  that delivers an AAA-feeling 3D experience that loads fast and runs at 60 FPS
  on mid-range phones; and
- a **thin Next.js backend** that handles the things a static file cannot:
  Stripe checkout, transactional email, server-rendered PDF certificates, a
  durable order store, and a no-login order portal.

Naming is **symbolic** and explicitly stated as not IAU-recognised - honest
marketing is a deliberate trust feature throughout the UI and legal copy.

## Features

**Experience**
- **Procedural 3D galaxy explorer** - 38,000 stars as GPU point clouds, warp-speed
  entry, drag/scroll/pinch/pan navigation with inertia, hover tooltips,
  cinematic camera travel to a selected star, a pointer-driven "gravity" effect,
  and an animated constellation-drawing loader.
- **Deterministic star catalogue** - every star's id, coordinates, spectral type,
  magnitude, distance and availability are derived from a hash of its index: a
  consistent "database" of hundreds of thousands of records with **zero storage
  and zero network requests**. Scarcity (~20% "Already Named") is a one-line
  predicate on the same hash.
- **Live certificate engine** - a data-driven template renders three certificate
  instances in two finishes (Midnight / Ivory) at exact A4 proportions, with
  procedurally painted galaxy backgrounds, that update **as the customer types**.
- **Zero binary assets** - star sprites, nebulae, the backdrop and certificate
  backgrounds are painted on `<canvas>` at runtime; ambience is synthesised with
  the Web Audio API.
- **Content & conversion** - FAQ/About/Contact/Terms/Privacy/Refunds via a
  client-side router; animated counters, a live registry counter, a countdown
  promotion, recent-purchase notifications and social proof.
- **Accessibility** - `prefers-reduced-motion` support, ARIA roles/states,
  keyboard escape chains, visible focus styles.

**Commerce**
- **Real Stripe Checkout** - server-authoritative pricing, hosted payment,
  shipping details captured into the PaymentIntent.
- **Email verification** - a 6-digit code (Resend) confirms the buyer's address
  before payment.
- **Server-rendered PDF certificates** - the same template is rendered to a
  faithful A4 PDF + PNG with headless Chromium and attached to the confirmation
  email.
- **Idempotent fulfilment** - driven by both the Stripe webhook and a
  success-page fallback; safe to run twice.
- **Tiered owner notifications** - each order emails the owner a fulfilment
  summary whose subject + banner make the action obvious (digital-only vs print
  & ship vs priority/framed).
- **No-login order portal** - an unguessable HMAC-signed link lets customers
  re-download certificates without an account.

## Technology Stack

| Layer | Technology | Why |
| --- | --- | --- |
| 3D rendering | Three.js r128 (WebGL), CDN | Point-cloud rendering of tens of thousands of stars at 60 FPS while keeping the core file self-contained |
| Front-end UI | Vanilla JavaScript (ES2020) | Zero framework overhead for a single-page experience |
| Styling | Hand-written CSS - custom properties, container queries (`cqw`), glassmorphism | Theme tokens drive certificate finishes; `cqw` makes certificates resolution-independent |
| App shell / API | Next.js 14 (App Router) | Production headers, redirects, edge middleware, and the checkout/email/certificate API |
| Payments | Stripe (hosted Checkout + webhooks) | PCI-light hosted payment; server-verified events |
| Email | Resend | Verification codes, order confirmations (with PDF attachments), owner + contact notifications |
| Certificate rendering | `puppeteer-core` + `@sparticuz/chromium` | HTML → faithful A4 PDF/PNG in a serverless function |
| Durable storage | Vercel KV (Upstash Redis), optional | Order snapshots + certificate blobs across instances |
| Hosting / TLS | Vercel Edge | Automatic Let's Encrypt SSL, TLS 1.2/1.3, global CDN |

## Architecture

```
┌──────────────────────────────  Browser  ──────────────────────────────┐
│ public/index.html  (single-file SPA - markup + CSS + all JS)          │
│  • 2D starfield · scroll/counter system · Web Audio ambience          │
│  • Galaxy explorer (Three.js): 38k point-cloud stars, custom orbit     │
│    controls, camera tweens, GPU gravity, warp intro                    │
│  • Live certificate engine (template + canvas textures, cqw / A4)      │
│  • Cart + multi-step checkout · client-side router · cert viewer       │
└───────────────────────────────────────────────────────────────────────┘
            │  Pay → POST /api/checkout/create-session              ▲
            ▼                                                       │ email links
┌──────────────────────  Next.js on Vercel Edge  ───────────────────────┐
│ middleware.js (HTTPS + canonical host) · next.config.mjs (headers,    │
│   www→apex redirect, / → index.html rewrite, Chromium tracing)        │
│                                                                       │
│ Stripe Checkout ──webhook──► /api/webhooks/stripe ─┐                  │
│ Success page  ──fallback──►  /api/checkout/order  ─┴► fulfillOrder()  │
│   1 claim stars · 2 render PDF/PNG (Chromium) · 3 persist snapshot    │
│   4 email confirmation (+PDFs) · 5 owner notification                 │
│                                                                       │
│ Store: Vercel KV (or in-memory) · /orders/[id] portal (HMAC token)    │
└───────────────────────────────────────────────────────────────────────┘
```

The root URL is **rewritten** to `public/index.html`, so visitors get the
static SPA; the Next.js routes exist only for commerce. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and flows.

## How the core systems work

- **Star registration.** The catalogue is computed, not stored: a star's full
  record is derived from a hash of its index. "Claiming" reserves it for 15
  minutes client-side and pre-fills the certificate; the star is *permanently*
  recorded as claimed only at fulfilment, server-side.
- **Checkout.** The client posts the cart to `/api/checkout/create-session`,
  which **re-prices from the server catalogue** (the browser never sends
  amounts) and opens a hosted Stripe Checkout Session. Payment is confirmed by a
  signed webhook, with the success page as a fast fallback.
- **Fulfilment.** `fulfillOrder()` is idempotent: it claims the stars, renders a
  certificate per star, persists a durable snapshot, then emails the customer and
  the owner. Running it twice (webhook + fallback) is safe.
- **Certificates.** `cert-template.js` extracts the certificate CSS + generators
  from `index.html` and builds a standalone HTML document; `render.js` turns it
  into a faithful A4 PDF + PNG with Chromium. The same template powers the live
  in-browser preview, so the PDF matches what the customer designed.
- **Email delivery.** Resend sends the verification code, the order confirmation
  (with every PDF attached), the internal owner notification, and contact-form
  messages. Sends are retried with backoff and logged per order.
- **Registry / retrieval.** A no-login portal (`/orders/[id]?token=…`) and the
  certificate download routes are gated by an HMAC token - the unguessable link
  is the only credential.

## Project Structure

```
astralis/
├── public/index.html      # ★ Entire front-end SPA (canonical; ~4,000 lines)
├── astralis.html          # Byte-identical copy - keep in sync after edits
├── app/
│   ├── layout.js · page.js
│   ├── checkout/{success,cancel}/page.js
│   ├── orders/[id]/page.js              # no-login order portal
│   ├── api/{checkout,webhooks,orders,verify-email,contact}/…  # API routes
│   └── lib/                             # backend logic (catalog, fulfill, render, store…)
├── middleware.js          # edge HTTPS + canonical host
├── next.config.mjs        # headers, redirects, rewrite, Chromium tracing
├── docs/                  # ARCHITECTURE.md · STRIPE_SETUP.md
├── .env.example           # all environment variables (documented)
└── README.md
```

## Local Development

```bash
git clone https://github.com/Lem0n-bot/astralis.git
cd astralis
npm install
cp .env.example .env.local     # fill in keys (see below)
npm run dev                    # http://localhost:3000
```

- The **marketing experience** runs with no tooling at all - open
  `public/index.html` directly in a browser.
- For the **commerce backend**, set the environment variables below. To render
  certificates locally, point `PUPPETEER_EXECUTABLE_PATH` at your system Chrome.
- To test webhooks: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
  and copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.

There is no test suite or linter configured.

## Environment Variables & External Services

All variables are documented in [`.env.example`](.env.example). Key ones:

| Variable | Service | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe | Server-side key. Required for checkout. |
| `STRIPE_WEBHOOK_SECRET` | Stripe | Verifies webhook signatures. Required for reliable fulfilment. |
| `RESEND_API_KEY` / `RESEND_FROM` | Resend | Transactional email; `RESEND_FROM` must be a verified sender. |
| `ORDER_NOTIFY_EMAIL` | Resend | Where internal "new order" notifications go. |
| `ORDER_TOKEN_SECRET` | - | HMAC secret for no-login links. **Set a long random value in production.** |
| `NEXT_PUBLIC_SITE_URL` | - | Absolute origin for success/cancel + email links. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV | Durable storage. Recommended in production. |
| `PUPPETEER_EXECUTABLE_PATH` | - | Local-dev path to system Chrome; leave unset on Vercel. |

See [docs/STRIPE_SETUP.md](docs/STRIPE_SETUP.md) for the Stripe dashboard
configuration.

## Deployment

Deployed on **Vercel**; pushing to `main` triggers an automatic edge build and
deployment, with SSL issuance/renewal fully automated.

1. Connect the GitHub repository to a Vercel project.
2. Add the environment variables above in **Project → Settings → Environment
   Variables**.
3. In the Stripe dashboard, add a webhook endpoint at
   `https://<your-domain>/api/webhooks/stripe` for `checkout.session.completed`,
   and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. (Recommended) Provision Vercel KV and add its `KV_REST_API_*` variables.

DNS uses an apex A record and a `www` CNAME to Vercel, with `www` permanently
redirected to the apex. The canonical host is configured in `middleware.js`
(`CANONICAL_HOST`) and `next.config.mjs` - change both together if the domain
changes.

## Security Considerations

- **Server-authoritative pricing** - amounts come only from the server catalogue;
  a tampered cart can never change what is charged.
- **Verified webhooks** - Stripe signatures checked against the raw request body.
- **Tokenised access** - the order portal and certificate downloads are gated by
  constant-time HMAC tokens; no accounts or passwords.
- **Email verification** - CSPRNG codes, per-email rate limiting, never logged.
- **Transport hardening** - HSTS (2-year, preload), TLS 1.2/1.3, HTTP→HTTPS and
  www→apex redirects at the edge and in middleware; `X-Powered-By` disabled; no
  third-party scripts beyond Three.js + fonts on the marketing page.

## Known Limitations

- **Working order state (`app/lib/orders.js`) and email codes
  (`app/api/verify-email/store.js`) are in-memory** - fine for a soft launch and
  warm instances, but lost on recycle. Durable fulfilment relies on the
  KV-backed `store.js`; **without Vercel KV, order-portal links can be unreliable
  across serverless instances.**
- **Two HTML files** (`public/index.html` + `astralis.html`) are kept in sync by
  hand.
- **No automated tests or linter.**
- The marketing front end is a single ~4,000-line file - deliberate, but large.

## Future Improvements

- Back `orders.js` and the verification store with KV/Postgres for fully durable,
  multi-instance state.
- A build step (or pre-commit hook) to generate `astralis.html` from
  `public/index.html` automatically.
- Public registry lookup endpoint keyed by certificate id.
- Unit tests for pricing/validation (`catalog.js`) and a Playwright end-to-end
  test for the claim → personalise → checkout funnel.
- WebGL post-processing (bloom) and instanced star glints.

## Author

**Tuna Nguyen (Anh Tuan Nguyen)** - Bachelor of Information Technology, Monash University

[LinkedIn](https://www.linkedin.com/in/anh-tuna-nguyen) · [GitHub](https://github.com/Lem0n-bot) · [Astralis Registry](https://astralisregistry.com)

**IMPORTANT: Tunafishy-T is my school account
[Monash Email](angu0207@student.monash.edu)
---

*Astralis star naming is symbolic and not affiliated with the International Astronomical Union.*
