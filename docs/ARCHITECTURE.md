# Astralis — Architecture & Developer Guide

This document is the single place a new contributor should read to understand
how Astralis is built and how a request flows through it. It complements the
[README](../README.md) (product/overview) and `CLAUDE.md` (working conventions).

---

## 1. The big picture

Astralis is a **symbolic star‑naming e‑commerce site**. A customer explores an
interactive 3D galaxy, picks a star, personalises a certificate, pays, and
receives a high‑resolution PDF certificate by email (plus optional printed
keepsakes shipped within Australia).

The codebase has **two clearly separated halves**:

| Half | What it is | Where |
| --- | --- | --- |
| **Front end** | The entire customer experience — markup, CSS, and all JavaScript — in one dependency‑free HTML file (~4,000 lines). Only external requests are Three.js (CDN) and Google Fonts. | `public/index.html` |
| **Backend** | A thin Next.js 14 (App Router) application that provides the things a static file cannot: security headers, Stripe checkout, email, server‑rendered certificate PDFs, and a no‑login order portal. | `app/`, `middleware.js`, `next.config.mjs` |

The Next.js layer is intentionally minimal. The root URL is **rewritten** to
`public/index.html` (see `next.config.mjs`), so visitors get the static
single‑page app; the React routes under `app/` exist only for checkout, email,
certificates, and order management.

> **Dual‑file rule:** `astralis.html` at the repo root is a **byte‑identical
> copy** of `public/index.html`. `public/index.html` is the file actually
> served and is canonical — after editing it, re‑copy:
> `cp public/index.html astralis.html`. CI does not enforce this; it is a manual
> discipline.

---

## 2. Repository layout

```
astralis/
├── public/
│   ├── index.html          # ★ The entire front-end SPA (canonical)
│   ├── logo.png            # favicon / brand mark
│   ├── email-bg.png        # backdrop used by HTML emails (clients can't use data URIs)
│   └── signature.png       # CEO signature (also embedded as a data URI in index.html)
├── astralis.html           # Byte-identical copy of public/index.html (keep in sync)
│
├── app/                    # Next.js App Router (the backend)
│   ├── layout.js           # Root HTML shell + metadata for the React routes
│   ├── page.js             # Fallback for "/" (never reached — root is rewritten)
│   ├── checkout/
│   │   ├── success/page.js # Post-payment page: confirms payment, polls for certificates
│   │   └── cancel/page.js  # Stripe cancel return page
│   ├── orders/[id]/page.js # No-login order portal (HMAC-token gated)
│   ├── api/
│   │   ├── checkout/
│   │   │   ├── create-session/route.js  # POST → create Stripe Checkout Session
│   │   │   └── order/route.js           # GET → success-page lookup (read-only in prod)
│   │   ├── webhooks/stripe/route.js     # POST → Stripe events (reliable fulfilment)
│   │   ├── orders/[id]/
│   │   │   ├── data/route.js            # GET → cert personalisation for client-side viewer
│   │   │   └── certificate/[certId]/route.js # GET → download PDF/PNG (token-gated)
│   │   ├── verify-email/                # 6-digit email verification (send/check/store/template)
│   │   └── contact/route.js             # POST → contact form → support inbox (Resend)
│   └── lib/                # Backend logic (pure-ish modules, see §6)
│
├── middleware.js           # Edge: HTTPS + canonical-host enforcement; secure-cookie pattern
├── next.config.mjs         # Security headers, redirects, root → index.html rewrite, Chromium tracing
├── docs/                   # This guide + STRIPE_SETUP.md
├── .env.example            # All environment variables (documented)
├── CLAUDE.md               # Conventions / guidance for AI-assisted edits
└── README.md               # Product overview, setup, deployment
```

---

## 3. The front end (`public/index.html`)

One self‑contained file. It opens with an architectural comment that maps the
file; the same structure summarised:

- **CSS (in `<head>`)** — organised by `===== SECTION =====` banners. Begins
  with **design tokens** (`:root` custom properties: colours, fonts, the
  certificate theme variables `--p1/--p2/--cink/--cg…`), then per‑section styles
  in the same order as the markup.
- **Markup (`<body>`)** — Nav, Hero, the Galaxy Explorer overlay, Packages,
  Personalise + live certificate, Promo, Reviews, FAQ, the Checkout modal, and
  sub‑page (router) containers.
- **JavaScript (bottom `<script>`)** — banner‑marked blocks:
  - **Front‑of‑site interactions** — `$`/`$$` query helpers, a 2D canvas
    starfield, scroll reveals & animated counters (via `IntersectionObserver`),
    the 15‑minute reservation timer, the live registry counter, Web Audio
    ambience, and the reviews marquee. `reduceMotion` short‑circuits heavy
    animation throughout (the one exception is the loader/constellation, which
    must always animate).
  - **Certificate engine** — `certTemplate(d)` plus canvas texture generators
    (`certGalaxyTexture`, `certSealSVG`, `starMapSVG`, …) render three live
    certificate instances (hero, live preview, showcase) in two finishes
    (Midnight / Ivory). Certificates are measured entirely in `cqw` (container
    query width) units at a fixed **1:1.414 (A4)** ratio, so the same markup is
    pixel‑correct at any size. The same `certTemplate` runs server‑side for the
    PDF (see §7).
  - **Galaxy explorer** — a Three.js (r128) scene: 38,000 stars as
    `THREE.Points` split into three geometry groups by availability state
    (available / reserved / featured) so raycasting can skip unselectable
    groups. The CDN build has **no OrbitControls**, so navigation is a custom
    spherical‑coordinate controller with inertia, pinch, and a camera‑tween
    system; a GPU vertex‑displacement "gravity" effect pulls stars toward the
    pointer; a warp scene plays on entry. Performance budget: ~6 draw calls,
    `setPixelRatio` capped at 2, the loop suspends while the explorer is closed.
  - **Cart + checkout** — cart state, the multi‑step checkout modal, the email
    verification UX gate, and the Stripe redirect (`POST
    /api/checkout/create-session`).
  - **Sub‑pages** — a `PAGES` object and a lightweight client‑side router for
    FAQ/About/Contact/Terms/Privacy/Refunds.
  - **Certificate viewer** — when the page is opened with `?cert=<id>&token=<t>`
    (the link in the confirmation email), it fetches the order's personalisation
    data and renders the certificate(s) **client‑side** for view / print /
    download — this works even if the server‑side renderer is unavailable.

### Deterministic star catalogue (no database)

Every star's full record — id, RA/Dec coordinates, spectral class, magnitude,
galactic sector, and **availability** — is computed on demand from a hash of its
index (`h1(index, salt)` seeded into trigonometric noise). Consequences:

- A consistent "catalogue" of hundreds of thousands of records with **zero
  storage and zero network requests**.
- Scarcity ("Already Named", ~20%) and "featured" stars are one‑line
  deterministic predicates on the same hash.
- The only thing that needs real persistence is which stars a paying customer
  has claimed — and that lives in the backend store, not the catalogue.

---

## 4. The backend (Next.js)

### Configuration & edge

- **`next.config.mjs`** — security headers (HSTS, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`), the
  `www → apex` permanent redirect, the `/ → /index.html` rewrite that serves the
  SPA, and `outputFileTracingIncludes` that forces `@sparticuz/chromium`'s
  runtime binaries into the certificate‑rendering serverless functions (without
  this, PDF rendering fails on Vercel).
- **`middleware.js`** — a defensive edge layer that re‑enforces HTTPS and
  canonicalises the host to `astralis.com.au`. Also carries the documented
  `httpOnly`/`secure`/`sameSite` secure‑cookie pattern for future session work.
  Change `CANONICAL_HOST` here and the redirect in `next.config.mjs` together if
  the domain changes.

### React routes (server components)

- `checkout/success/page.js` — read after Stripe redirects back; calls
  `/api/checkout/order`, which confirms payment from Stripe and reports
  fulfilment separately, polling until the certificates appear. It does **not**
  render anything in production — doing so used to blow the 60s function limit
  and tell a charged customer their payment could not be confirmed. Shows
  per‑certificate downloads and a starfield background.
- `checkout/cancel/page.js` — friendly "no charge taken" page.
- `orders/[id]/page.js` — the **no‑login order portal**. The HMAC token in the
  URL is the only credential; it lists every certificate with a preview + PDF.

---

## 5. End‑to‑end flows

### 5.1 Star discovery → "registration"

Entirely client‑side and deterministic (§3). "Claiming" a star reserves it for
15 minutes (a client timer) and pre‑fills the certificate. A star is only
*permanently* recorded as claimed at fulfilment, server‑side
(`orders.claimStar`).

### 5.2 Email verification (before payment)

```
client → POST /api/verify-email/send-code {email}
         → 6-digit CSPRNG code saved in an in-memory store (10-min TTL),
           emailed via Resend; rate-limited (60s) per email
client → POST /api/verify-email/check-code {email, code}
         → consumes one of 5 attempts; success unlocks "Continue to payment"
```

This is a **UX gate**, not an authorisation boundary — the price and order are
still validated server‑side at checkout.

### 5.3 Checkout → payment → fulfilment

```
client (Pay) ─► POST /api/checkout/create-session
                  • validateOrderInput(): re-prices from the SERVER catalogue
                    (the client never sends amounts → tamper-proof)
                  • createOrder() → pending order (id, orderNo, items, delivery)
                  • stripe.checkout.sessions.create(): hosted Checkout,
                    shipping pushed into payment_intent_data.shipping
                  • putOrder(): durable snapshot so fulfilment survives a cold
                    serverless instance
                ◄ { url } → browser redirects to Stripe

Stripe ─► POST /api/webhooks/stripe  (reliable path)
            • verifies signature against the RAW body
            • on checkout.session.completed → fulfillOrder()

browser ─► GET /api/checkout/order?session_id=…  (read-only in production)
            • reports Stripe's `paid` + a separate `fulfilment` state
            • fulfils ONLY where no STRIPE_WEBHOOK_SECRET is set (local dev)
```

The webhook is the authoritative path and answers 2xx only when the order was
genuinely delivered; anything else is a 5xx so Stripe retries for up to 3 days.

`fulfillOrder()` (in `app/lib/fulfill.js`) is **idempotent** — a durable
"fulfilled" snapshot plus a best‑effort lock prevent double rendering/emailing.
If another instance holds the lock it reports failure rather than success, so a
retry still happens. On first run it:

1. marks the order paid and **claims each star**;
2. mints a certificate id for **every** star and persists the paid snapshot
   *before* rendering, then renders as many PDFs as fit in a time budget (§7).
   Chromium can outlive the function, and a killed function emails nothing, so
   rendering can never starve the email; an unrendered certificate still has a
   working link, because the download route re-renders on demand;
3. persists the durable order snapshot *before* emailing (so downloads work even
   if email later fails);
4. sends the **customer confirmation** (all PDFs attached) with retry; and
5. sends the **owner notification** — a separate internal email whose subject +
   banner state the fulfilment action: digital‑only ($39, nothing to post),
   print & ship ($79), or priority/framed ($139). Mixed carts resolve to the
   most involved action; each item is tagged individually.

### 5.4 Certificate rendering pipeline

```
certDataFor(item)          (app/lib/certificates.js)
  → buildCertificateHtml() (app/lib/cert-template.js)
      • extracts the cert CSS + generators from public/index.html at runtime
        and assembles a standalone HTML document
  → renderCertificate()    (app/lib/render.js)
      • puppeteer-core + Chromium (system Chrome locally via
        PUPPETEER_EXECUTABLE_PATH; @sparticuz/chromium on Vercel)
      • waits for fonts + window.__certReady, emulates SCREEN media, then
        page.pdf() + an element screenshot → { pdf, png }
  → putBlob()              (app/lib/store.js)  persist; downloads re-render if absent
```

Two subtleties worth knowing (both are commented at the source):

- The HTML assembled by `cert-template.js` renders the certificate **first**, in
  a separate `<script>`, then enhances the signature — so a generator hiccup
  under headless Chromium can never leave a blank certificate.
- `render.js` calls `page.emulateMediaType('screen')` before `page.pdf()`. The
  certificate CSS contains an `@media print` rule (used by the in‑browser
  viewer's print‑to‑PDF) that would hide everything in print media; emulating
  screen media is what makes the server PDF faithful to the preview.

### 5.5 Delivery & retrieval

- **Confirmation email** (`order-email.js → orderConfirmationHtml`) — all
  certificate PDFs attached, plus per‑certificate download links and a "View
  your certificate" link to the client‑side viewer.
- **Order portal** (`/orders/[id]?token=…`) and **certificate downloads**
  (`/api/orders/[id]/certificate/[certId]?token=…`) — both gated by the HMAC
  token; downloads re‑render on demand if the stored blob is missing.

---

## 6. Backend modules (`app/lib`)

| Module | Responsibility |
| --- | --- |
| `catalog.js` | **Single source of truth for prices** + `validateOrderInput()`. No SDK imports → unit‑testable; the client can never set amounts. |
| `stripe.js` | Lazy Stripe client factory (server‑side key only; no Stripe.js in the browser). |
| `orders.js` | In‑memory order lifecycle (create → paid), star‑claims, order numbers. *Working state* (see limitations). |
| `store.js` | **Durable** artifact store (order snapshots, cert records, PDF/PNG blobs) + the fulfilment lock. Vercel KV when configured, else a `globalThis`‑backed in‑memory fallback. Async API so KV is a drop‑in. |
| `fulfill.js` | The single idempotent post‑payment routine (§5.3). |
| `certificates.js` | Per‑star certificate generation + the `certDataFor` mapping; on‑demand re‑render. |
| `cert-template.js` | Assembles the standalone certificate HTML by extracting CSS + generators from `index.html`. |
| `render.js` | HTML → `{ pdf, png }` via Chromium; reuses one warm browser. |
| `order-email.js` | Customer confirmation + the tiered owner notification + `orderFulfilment()` classifier. |
| `ids.js` | Order/certificate id minting + HMAC link tokens (constant‑time verify). |
| `env.js` | Centralised env access + `is*Configured()` guards; never throws at import. |
| `retry.js` | Generic exponential‑backoff retry used for email sends. |

---

## 7. Storage & reliability

- **Two stores.** `orders.js` holds *working* state in memory; `store.js` holds
  the *durable* snapshot/blobs (KV or in‑memory). Fulfilment reads the working
  order if present, else the durable snapshot, so it works on a cold instance.
- **Idempotency.** `fulfillOrder` short‑circuits on a durable `fulfilled`
  snapshot and uses `acquireLock`/`releaseLock` so the webhook and the
  success‑page fallback never double‑render or double‑email.
- **Graceful degradation.** Missing blobs (KV size limits / instance recycle)
  are re‑rendered on demand by the download route. Missing env vars produce
  clear errors rather than crashes (`env.js` guards).
- **Without Vercel KV** (`KV_REST_API_URL` / `KV_REST_API_TOKEN` unset),
  snapshots live only in the instance that created them. The confirmation email
  is rendered inline at checkout so it still works, but the portal/download links
  may 404 from a different instance. **KV is recommended for production.**

---

## 8. Security model

- **Server‑authoritative pricing** — amounts come only from `catalog.js`.
- **Webhook integrity** — Stripe signatures verified against the raw body.
- **Tokenised access** — order portal + downloads gated by HMAC‑SHA256 tokens
  (`ids.js`), compared in constant time. Set `ORDER_TOKEN_SECRET` in production.
- **Email verification** — CSPRNG codes, rate‑limited, never logged or returned.
- **Transport** — HSTS (2 years, preload), TLS 1.2/1.3, HTTP→HTTPS and
  www→apex redirects at the edge and again in middleware; `X-Powered-By` off.
- **No third‑party scripts** beyond Three.js + Google Fonts on the marketing page.
- **Honest marketing** — UI and legal copy state naming is symbolic and not
  IAU‑recognised. Treat this as a trust feature; preserve it.

---

## 9. Configuration

All variables are documented in [`.env.example`](../.env.example). Summary:

| Variable | Required | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes (checkout) | Server‑side Stripe key (`sk_…`). |
| `STRIPE_WEBHOOK_SECRET` | Yes (reliable fulfilment) | Verifies webhook signatures (`whsec_…`). |
| `RESEND_API_KEY` | Yes (email) | Transactional email (verification, confirmation, contact, owner). |
| `RESEND_FROM` | Recommended | Verified sender; defaults to `noreply@astralisregistry.com`. |
| `ORDER_NOTIFY_EMAIL` | Recommended | Where internal "new order" notifications go. |
| `NEXT_PUBLIC_SITE_URL` | Recommended | Absolute origin for success/cancel + email links. |
| `ORDER_TOKEN_SECRET` | **Yes in prod** | HMAC secret for the no‑login link tokens. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Recommended in prod | Durable storage (Vercel KV / Upstash). |
| `PUPPETEER_EXECUTABLE_PATH` | Local dev only | Path to system Chrome so certificates render locally. Leave unset on Vercel. |

---

## 10. Local development

```bash
npm install
cp .env.example .env.local          # fill in keys; see notes below
npm run dev                          # http://localhost:3000
```

- The **marketing experience** needs no tooling at all — open
  `public/index.html` directly in a browser.
- For the **checkout/certificate backend**, set the env vars above. To render
  certificates locally, point `PUPPETEER_EXECUTABLE_PATH` at your system Chrome.
- To exercise webhooks locally: `stripe listen --forward-to
  localhost:3000/api/webhooks/stripe` and copy the `whsec_…` it prints into
  `STRIPE_WEBHOOK_SECRET`. (The success page also fulfils as a fallback, so
  basic flows work without the CLI.)

There is no test suite or linter configured.

---

## 11. Known limitations & technical debt

- **`orders.js` is in‑memory.** Working order state is per‑instance and lost on
  recycle. Durable fulfilment relies on `store.js` + KV; without KV, portal
  links are unreliable across instances. *Next step: back both with KV/Postgres.*
- **`verify-email/store.js` is in‑memory.** A code can be lost if the instance
  recycles between send and check (rare in the 10‑minute window). *Next step: KV.*
- **Dual HTML files.** `public/index.html` and `astralis.html` are kept in sync
  by hand. *Next step: a build step or pre‑commit hook to generate the copy.*
- **One ~4,000‑line front‑end file.** Deliberate (zero dependencies, trivially
  portable), but large. It is navigable via the section banners and the
  top‑of‑file map; a future modular build could split it without changing the
  shipped artifact.
- **No automated tests.** The checkout/fulfilment path is written to be
  idempotent and testable; *next step: unit tests for `catalog.js`
  (pricing/validation) and a Playwright flow for claim → personalise → checkout.*
- **`CLAUDE.md` describes an earlier build** (it predates the backend). Use this
  document and the README as the current reference.
