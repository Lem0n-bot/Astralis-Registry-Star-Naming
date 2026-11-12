# Stripe Checkout — setup & operations

Production-ready hosted Stripe Checkout for Astralis. Card data is entered on
Stripe's hosted page, so **no card details or keys ever touch the browser**.

## 1. Install the dependency

```bash
npm install            # picks up "stripe" added to package.json
```

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Var | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | ✅ | `sk_test_…` / `sk_live_…`. Server-only. |
| `STRIPE_WEBHOOK_SECRET` | ✅ | `whsec_…` from the webhook endpoint (step 4). |
| `RESEND_API_KEY` | ✅ | Verification + the order-confirmation email (with certificate PDFs attached). |
| `RESEND_FROM` | optional | Verified sender. Default `Astralis Registry <noreply@astralisregistry.com>`. |
| `NEXT_PUBLIC_SITE_URL` | ✅ (prod) | Origin for success/cancel URLs **and** the absolute certificate-download + portal links in the email. |
| `ORDER_TOKEN_SECRET` | ✅ (prod) | HMAC secret for the tokenised (no-login) order/certificate links. Long random string. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | optional | Vercel KV / Upstash Redis. Set both to persist orders + certificates across instances; else in-memory fallback. |
| `PUPPETEER_EXECUTABLE_PATH` | local only | System Chrome path for cert PDF rendering in dev. Unset on Vercel → `@sparticuz/chromium`. |
| `OWNER_EMAIL` | ✅ (prod) | Where the owner's copy of every order goes. `ORDER_NOTIFY_EMAIL` is the old name, still honoured. |
| `OWNER_COPY_PACKAGES` | optional | Which packages attach the PDF to that copy. Default all three; does **not** gate whether the email is sent. |
| `ADMIN_SECRET` | optional | Password for the private certificate generator at `/admin/certificate`. Min 16 chars; unset → the page 401s. |
| `ADMIN_API_TOKEN` | recommended | Bearer token for the fulfilment replay at `/api/admin/fulfill`. Min 24 chars; unset → the route 404s. See `docs/RUNBOOK-FULFILMENT.md`. |
| `STRIPE_PUBLISHABLE_KEY` | not used | Hosted Checkout redirects via the session URL; no Stripe.js runs client-side. |

See `.env.example` for a copy-paste template. Prices are **not** an env var — they
live in `app/lib/catalog.js` (`PACKAGES`), the single server-side source of truth.
The client never sends amounts.

## 3. Flow

```
public/index.html  ──POST /api/checkout/create-session──►  creates pending order
        │                                                   + Stripe Checkout Session
        └────────────── redirect to session.url ──────────► Stripe hosted page
                                                                   │
        success_url  /checkout/success?session_id=…  ◄────────────┤ (paid)
        cancel_url   /checkout/cancel                ◄────────────┘ (cancelled)

Stripe ──event checkout.session.completed──► /api/webhooks/stripe ──► fulfillOrder()
        success page calls /api/checkout/order — READ-ONLY in production;
        it fulfils only where STRIPE_WEBHOOK_SECRET is unset (local dev)
```

The webhook is the authoritative path. It returns 2xx only when the order was
genuinely delivered — including a 500 when another instance holds the fulfilment
lock — so Stripe retries for up to 3 days rather than recording a charged-but-
undelivered order as handled.

`fulfillOrder()` (idempotent) records the order paid, marks each star claimed,
**mints a certificate id for every star and persists the paid snapshot before
rendering**, then renders as many A4 PDFs as fit in `CERT_RENDER_BUDGET_MS`, then
sends one Resend confirmation email with the rendered PDFs attached and working
links for all of them — with retry + per-order delivery logging. Rendering is
bounded on purpose: Chromium is the only step that can outlive the function, and
a killed function emails nothing.

## Certificates, email & the order portal

- **Generation** (`app/lib/certificates.js` → `cert-template.js` + `render.js`):
  each star gets a unique id `AST-CERT-<year>-<8hex>`; the certificate is rendered
  by reusing the live preview's own generators from `public/index.html` (so the PDF
  always matches the site), via headless Chromium.
- **Storage** (`app/lib/store.js`): order snapshots, certificate records and the
  PDF/PNG blobs persist to Vercel KV when configured, else an in-memory fallback.
  Certificate ids and the paid snapshot are persisted **before** rendering and
  emailing, so a render or mail failure never loses what the customer is owed.
- **Email** (`app/lib/order-email.js`): luxury, table-based HTML with a personalised
  greeting, per-star cards (preview + download), order summary, and a portal button.
- **Order portal** (`/orders/:id?token=…`) + **downloads**
  (`/api/orders/:id/certificate/:certId?token=…&format=pdf|png`): no login — the
  signed HMAC token (`ORDER_TOKEN_SECRET`) in the email link is the credential. If a
  blob is missing, the route re-renders it on demand from the locked order data.

## 4. Webhook

**Production:** Stripe Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://<your-domain>/api/webhooks/stripe`
- Events: `checkout.session.completed` (and optionally `checkout.session.async_payment_succeeded`)
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**Local dev:**
```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# copy the printed whsec_… into .env.local as STRIPE_WEBHOOK_SECRET
```
Even without the CLI, the success page fulfils the order as a fallback, so local
testing still records the order and sends the email.

## 5. Test cards (test mode)

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 9995` | Declined (insufficient funds) |
| `4000 0027 6000 3184` | 3DS authentication required |

Any future expiry, any CVC, any AU postcode.

## 6. Notes & limitations (soft-launch)

- **Storage is pluggable** (`app/lib/store.js` + `app/lib/orders.js`): set
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` for durable, cross-instance orders +
  certificates; otherwise an in-memory fallback runs (fine for dev / warm
  instances). The in-memory `orders.js` still tracks pending orders + star claims.
- **Certificates are rendered inline** in fulfilment with Chromium (~5s/cert warm,
  considerably more on a cold instance). Rendering is capped by
  `CERT_RENDER_BUDGET_MS` with a per-certificate ceiling, and anything that does
  not fit is still deliverable via its on-demand download link. For large
  multi-star orders consider a background queue/worker; fulfilment is idempotent
  and the webhook 500s on failure, so Stripe retries are safe.
- **KV value size:** a base64 certificate PDF is ~1.1 MB against Vercel KV's 1 MB
  per-value limit, so blob caching is skipped for them by design
  (`KV_MAX_VALUE_BYTES`). Emails attach the in-memory render buffer rather than
  reading back from the store, and the download route re-renders on demand. For
  heavy volume, store blobs in object storage (S3/Blob).
- The in-page cart is in-memory; leaving for Stripe and cancelling loses the cart.
  Consider persisting the cart to `localStorage` before redirect.
- Buyer name isn't collected, so the email greeting is derived from the email
  local-part. Add a name field to the delivery form for a cleaner greeting.
