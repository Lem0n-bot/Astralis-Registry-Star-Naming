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

`degraded:true` with `warnings:["kv_unreachable"]` means orders still complete
but nothing is durable — go to §1a.

`ready:false` with `missing:["emailVerification"]` is a different complaint and
has its own section: new orders are being **refused at checkout** — go to §1b.

## 1a. The durable store is unreachable

`checks.kv` is a **live** write + read-back, not an env check, so this is the
case where `store.configured` is true and `store.reachable` is false.

This has happened in production: the free Upstash database is deleted after 14
days with no commands, and it was. Every KV call then failed with
`getaddrinfo ENOTFOUND`.

What still works, by design: fulfilment rebuilds the order from the Stripe
session metadata, renders the certificates and emails them with the PDFs
attached. `kv.unreachable` and `fulfil.degraded` are logged, and the owner copy
of the order carries an amber banner naming the Checkout Session to replay.

What does not work: the no-login portal and the certificate download links, for
every order fulfilled during the outage. They need the snapshot.

Recovery:

1. Create a new database (Vercel → Storage → Upstash Redis) and set
   `KV_REST_API_URL` + `KV_REST_API_TOKEN`. The Marketplace integration sets
   both for you. Redeploy.
2. Confirm: `curl -s "$SITE/api/health" | jq .store` → `reachable: true`.
3. Replay each order fulfilled during the outage (§3). It is idempotent and
   reuses certificate ids, so the links already in a customer's inbox start
   working — nothing is re-charged and no number changes.

Prevention: a daily Vercel Cron (`vercel.json` → `/api/keepalive`) does a real
write so the idle timer never expires. It needs `CRON_SECRET` set, or the route
404s and the cron run fails. Check it:

```bash
curl -s -H "x-cron-secret: $CRON_SECRET" "$SITE/api/keepalive" | jq
```

`reachable:true` with an advancing `hits` is healthy; a 503 means the store is
gone again. The cron's run history is in Vercel → Project → Cron Jobs.

## 1b. Nobody can check out ("please verify your email" / 503)

Symptom: buyers reach checkout step 2 and the code never arrives, or the status
line reads *"We couldn't start verification just now"*. `/api/health` shows
`ready:false`, `missing:["emailVerification"]`.

Cause: checkout email verification keeps its codes and its "this address was
verified" marker in the durable store, and in production it will not use
anything else. So either the store is unset, or it is not answering (§1a).

This is deliberate, and it is **not** a bug to route around. Memory is not a
weaker version of KV here, it is wrong: the instance that emails a code is
usually not the one that checks it, so a buyer would be told their correct code
is wrong — and `create-session`, which re-reads the marker, would refuse a buyer
who did verify. Both failures are silent and intermittent. Refusing loudly is
the same call the site already makes for a missing Resend key.

What is NOT affected: every order already paid for. Fulfilment rebuilds those
from the Stripe session metadata and still emails the certificates (§1a).

Logs, in order of what they tell you:

```bash
vercel logs --since 1h | grep -E 'verify\.send_refused|verify\.check_unavailable|create_session\.refused|kv\.unreachable'
```

| stage + reason | meaning |
|---|---|
| `verify.send_refused` · `store_not_configured` | `KV_REST_API_*` unset in this environment |
| `verify.send_refused` · `store_unavailable` | store configured, not answering — §1a |
| `verify.send_refused` · `resend_not_configured` | `RESEND_API_KEY` unset; no code can be delivered |
| `create_session.refused` · `verification_unavailable` | store died between verifying and paying |
| `create_session.refused` · `email_not_verified` | working as intended — the buyer skipped the code, or someone posted at the endpoint directly |

Fix: restore the store (§1a steps 1–2), then `curl -s "$SITE/api/health" | jq
'.ready, .checks.emailVerification'` → `true, true`. No replay is needed — no
order was created.

A rate-limited buyer is a different, benign case: `verify.send_rate_limited`
means the 60-second per-address claim or the per-IP cap did its job. Nothing to
do.

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
| `fulfil.snapshot_persist_failed` | The store answered and refused the write (rotated token, oversized value) — the portal and download links would be dead, so this is reported as a failure and retried. |
| `kv.unreachable` → `fulfil.degraded` | The store is gone, not refusing. See §1a. `delivered:true` means the customer has their certificates and the webhook deliberately returned 200; `delivered:false` means it returned 500 so Stripe retries. |

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
- **An unreachable store degrades; it never throws.** The unguarded KV read at
  the top of `fulfillOrder()` is what turned a deleted database into a webhook
  that answered 500 on every Stripe retry, so no customer email was ever sent.
  `lib/store.js` reports instead of throwing — keep it that way.
- **A delivered-but-not-durable order answers 200.** Retrying cannot create a
  snapshot while the store is down, and each retry would re-send the receipt.
  This applies *only* when the email went out with the PDFs attached; with
  nothing in the customer's hands it is still a 500.
- **Probe commands are unique per run.** A framework-cached HTTP response once
  made a healthy store report a 503 — and the same mechanism can make a dead
  store look alive, which is worse.
- **Email verification never falls back to memory, and `create-session` always
  re-checks it.** Codes in per-instance memory told real buyers their correct
  code was wrong; a browser flag alone let an order be placed for an address
  nobody had proved they controlled. Do not "fix" the 503 by degrading to
  memory, and do not drop the `isVerified()` call to save a round trip — the
  check costs one KV read and is the only thing standing between an unverified
  address and a charge.
- **The verified marker is read, not consumed.** A customer who bounces off the
  Stripe page and retries must be able to pay without verifying again; the
  30-minute TTL is what bounds the permission.
