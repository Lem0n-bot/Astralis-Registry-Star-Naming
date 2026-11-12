# Runbook — a customer paid but received nothing

Real money moves through this path. When it breaks, the customer has already
been charged, so recovery is the priority and diagnosis comes second.

## 0. One-time setup

```bash
# A long random token. The replay route 404s until this is set.
vercel env add ADMIN_API_TOKEN production    # paste `openssl rand -hex 32`
```

Then export it locally for the commands below:

```bash
export ADMIN_TOKEN='…'
export SITE='https://astralisregistry.com'
```

## 1. Is the site able to fulfil at all?

```bash
curl -s "$SITE/api/health" | jq
```

`ready:false` means orders **cannot** be fulfilled — `missing` names the env vars
to set. `fulfilment.path` should read `stripe-webhook`; `success-page-fallback`
means `STRIPE_WEBHOOK_SECRET` is unset and only the success page would deliver,
which is a dev-only configuration.

## 2. Look at the order (read-only, changes nothing)

Get the Checkout Session id from Stripe → Payments → the payment → *Checkout
session* (`cs_live_…`).

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  "$SITE/api/admin/fulfill?session_id=cs_live_…" | jq
```

Read it like this:

| Field | Meaning |
| --- | --- |
| `paymentStatus: "paid"` | Stripe collected the money. Required before any replay. |
| `hasDurableSnapshot: false` | KV holds nothing for this order. |
| `recoverableFromStripeMetadata: true` | The order can still be rebuilt from the session, so it **is** recoverable. |
| `fulfilled: false` | Nothing was delivered. This is the stranded case. |
| `emailStatus: "failed"` | Certificates exist; the receipt did not land. |
| `certificates[].rendered: false` | No cached PDF. The download link still works — it renders on demand. |
| `deliveryLog` | Per-stage history: which certificate failed, and why. |

If `recoverableFromStripeMetadata` **and** `hasDurableSnapshot` are both false,
stop: the order cannot be reconstructed and the customer must be contacted (or
refunded) directly.

## 3. Deliver it

```bash
curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"session_id":"cs_live_…"}' \
  "$SITE/api/admin/fulfill" | jq
```

Success is `"ok": true` with `emailStatus: "sent"`. The route is idempotent: it
will not re-fulfil an order that is already fulfilled, and it reuses existing
certificate ids, so links and certificate numbers already in a customer's inbox
stay valid. It can never charge anyone — it takes no payment input and refuses
unless Stripe already reports the session paid.

Options:

| Body field | Use when |
| --- | --- |
| `"force_email": true` | The order is fulfilled but the customer needs the receipt again. Off by default so a replay cannot spam them. |
| `"break_lock": true` | Reply is `409` / `fulfilment_in_progress` and no other instance is really working. An instance killed mid-render leaves its lock behind for up to 75s; this clears it. |
| `"budget_ms": 45000` | A large order needs more render time in one pass. Keep it inside the route's `maxDuration`. |

Response codes: `200` delivered · `409` locked or unpaid · `422` no order id in
the session metadata · `500` fulfilment failed (the body says why) · `401` bad
token · `404` `ADMIN_API_TOKEN` unset.

## 4. Then find out why

Search the Vercel function logs. Every stage logs one JSON line, so an order's
whole history comes back from its order number:

```bash
vercel logs --since 2h | grep AST-ORD-12345
```

The sequence for a healthy order is:

```
create_session.created → webhook.received → fulfil.start
  → cert.rendered (×N) → cert.batch_done → email.sent
  → owner_email.sent → fulfil.done → webhook.fulfilled
```

Where it stops tells you what broke:

| Last line | Cause |
| --- | --- |
| `create_session.created`, no `webhook.received` | Stripe never delivered. Check the endpoint URL and the events it subscribes to. |
| `webhook.signature_invalid` | `STRIPE_WEBHOOK_SECRET` does not match this endpoint's signing secret — usually a test secret on a live endpoint, or a rotated secret. |
| `cert.deferred` / `cert.render_failed` | Rendering ran out of budget. Not a delivery failure: the email still goes out and the links render on demand. |
| `fulfil.in_progress_elsewhere` | Two paths raced. The webhook returns 500 on purpose so Stripe retries. |
| `email.failed` | Resend rejected the send. The webhook returns 500 so the retry re-sends via `repairEmail`. |
| `fulfil.snapshot_persist_failed` | KV write failed — the portal and download links would be dead, so this is reported as a failure and retried. |

## Invariants — do not "fix" these back

- **The webhook returns 500 when fulfilment fails**, including when another
  instance holds the lock. Stripe then retries for up to 3 days. A 200 here is
  what stranded paid orders: Stripe stopped retrying while nothing had been
  delivered.
- **The success page never renders certificates in production.** It used to run
  the whole fulfilment inside the customer's page load, blow the 60s limit, and
  tell a charged customer their payment "could not be confirmed".
- **Rendering is bounded and runs after the durable snapshot.** The confirmation
  email must be reachable no matter what Chromium does.
- **A certificate with no cached PDF is not a lost certificate.** The download
  route re-renders on demand and the client-side viewer needs no Chromium.
