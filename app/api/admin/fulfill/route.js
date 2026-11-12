/**
 * Manual fulfilment replay — the break-glass tool for an order that was charged
 * but never delivered.
 *
 *   GET  /api/admin/fulfill?session_id=cs_live_…   inspect only, changes nothing
 *   POST /api/admin/fulfill  { session_id, … }     re-run fulfilment
 *
 * Auth: `x-admin-token: <ADMIN_API_TOKEN>` (or `Authorization: Bearer …`),
 * compared in constant time. With ADMIN_API_TOKEN unset the route 404s, so it is
 * inert by default and cannot be probed into existence.
 *
 * SAFETY PROPERTIES
 *  - It can never charge anyone. It takes no payment input; it reads an existing
 *    Stripe Checkout Session and refuses unless Stripe already reports it paid.
 *  - It is idempotent. An order that is already fulfilled is reported, not
 *    re-fulfilled; certificate ids are reused rather than reissued, so a replay
 *    does not invalidate links or certificate numbers already in a customer's
 *    inbox. Resending the receipt takes an explicit `force_email`.
 *  - It works with no durable record at all. The order is rebuilt from the
 *    session metadata (lib/order-codec.js) when KV holds nothing.
 *  - GET is read-only, so you can always look before you touch.
 *
 * Typical recovery:
 *   curl -s -H "x-admin-token: $ADMIN_API_TOKEN" \
 *     "https://astralisregistry.com/api/admin/fulfill?session_id=cs_live_…" | jq
 *   curl -s -X POST -H "x-admin-token: $ADMIN_API_TOKEN" \
 *     -H 'content-type: application/json' \
 *     -d '{"session_id":"cs_live_…"}' \
 *     https://astralisregistry.com/api/admin/fulfill | jq
 */
import crypto from 'node:crypto';
import { getStripe } from '../../../lib/stripe';
import { fulfillOrder } from '../../../lib/fulfill';
import { unpackOrder } from '../../../lib/order-codec';
import { getOrder as getSnapshot, releaseLock } from '../../../lib/store.js';
import { ENV, isAdminApiConfigured } from '../../../lib/env.js';
import { log, errFields, now, since } from '../../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });

function presentedToken(req) {
  const header = req.headers.get('x-admin-token');
  if (header) return header.trim();
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/**
 * @returns {Response|null} a response to return immediately, or null when authorised.
 */
function authorise(req) {
  const expected = ENV.ADMIN_API_TOKEN;
  // Disabled unless explicitly configured, and short tokens are refused rather
  // than silently accepted — this endpoint can email customers.
  if (!isAdminApiConfigured()) {
    if (expected) log.error('admin.token_too_short', { minLength: 24 });
    return json({ error: 'not_found' }, 404);
  }
  const got = presentedToken(req);
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn('admin.unauthorised', { hasToken: !!got });
    return json({ error: 'unauthorised' }, 401);
  }
  return null;
}

/** Resolve the Stripe session + the order it carries. */
async function resolve(sessionId) {
  if (!sessionId) return { error: 'missing_session_id', status: 400 };
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { error: 'invalid_session_id', status: 400 };
  if (!process.env.STRIPE_SECRET_KEY) return { error: 'stripe_not_configured', status: 500 };

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    log.warn('admin.session_lookup_failed', { sessionId, ...errFields(err) });
    return { error: 'session_not_found', status: 404 };
  }

  const orderId = session.metadata?.orderId || null;
  const recovered = unpackOrder(session.metadata);
  const snapshot = orderId ? await getSnapshot(orderId) : null;
  return { session, orderId, recovered, snapshot };
}

/** Operator-facing view of where an order stands. */
function describe({ session, orderId, recovered, snapshot }) {
  return {
    sessionId: session.id,
    livemode: !!session.livemode,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
    customerEmail: session.customer_email || recovered?.email || snapshot?.email || null,
    orderId,
    orderNo: snapshot?.orderNo || session.metadata?.orderNo || recovered?.orderNo || null,
    recoverableFromStripeMetadata: !!recovered,
    hasDurableSnapshot: !!snapshot,
    fulfilled: !!snapshot?.fulfilled,
    fulfilledAt: snapshot?.fulfilledAt || null,
    emailStatus: snapshot?.emailStatus || null,
    ownerEmailStatus: snapshot?.ownerEmailStatus || null,
    items: (snapshot?.items || recovered?.items || []).map((it) => ({
      name: it.name,
      pkg: it.pkg,
      starId: it.star?.id || null,
    })),
    certificates: (snapshot?.certificates || []).map((c) => ({
      certId: c.certId,
      name: c.name,
      itemIndex: c.itemIndex,
      rendered: !!c.rendered,
    })),
    deliveryLog: snapshot?.deliveryLog || [],
  };
}

export async function GET(req) {
  const denied = authorise(req);
  if (denied) return denied;

  const sessionId = new URL(req.url).searchParams.get('session_id');
  const r = await resolve(sessionId);
  if (r.error) return json({ error: r.error }, r.status);

  log.info('admin.inspect', { sessionId: r.session.id, orderId: r.orderId, fulfilled: !!r.snapshot?.fulfilled });
  return json({ action: 'inspect', ...describe(r) });
}

export async function POST(req) {
  const denied = authorise(req);
  if (denied) return denied;

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const sessionId = body.session_id || body.sessionId;
  const r = await resolve(sessionId);
  if (r.error) return json({ error: r.error }, r.status);

  const { session, orderId, recovered } = r;

  // Never fulfil something Stripe has not actually collected.
  if (session.payment_status !== 'paid') {
    log.warn('admin.refused_unpaid', { sessionId: session.id, paymentStatus: session.payment_status });
    return json({ error: 'not_paid', paymentStatus: session.payment_status, ...describe(r) }, 409);
  }
  if (!orderId) {
    log.error('admin.no_order_id', { sessionId: session.id });
    return json({ error: 'missing_order_id', ...describe(r) }, 422);
  }

  // Escape hatch for the failure this whole route exists to clean up: an
  // instance killed mid-render leaves its lock behind, and every later attempt
  // then backs off instead of fulfilling.
  if (body.break_lock) {
    await releaseLock(orderId);
    log.warn('admin.lock_broken', { sessionId: session.id, orderId });
  }

  const t0 = now();
  log.info('admin.replay_start', {
    sessionId: session.id,
    orderId,
    forceEmail: !!body.force_email,
    brokeLock: !!body.break_lock,
  });

  let res;
  try {
    res = await fulfillOrder(
      orderId,
      {
        sessionId: session.id,
        paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
        amountTotal: session.amount_total,
      },
      recovered,
      {
        source: 'admin',
        // Re-sends the receipt even for an order already marked delivered. Off by
        // default so an accidental replay cannot spam a customer.
        forceEmail: !!body.force_email,
        // Nothing else is racing a manual replay, so do not sit on the lock.
        lockWaitMs: 3_000,
        ...(Number.isFinite(+body.budget_ms) ? { budgetMs: +body.budget_ms } : {}),
      }
    );
  } catch (err) {
    log.error('admin.replay_error', { sessionId: session.id, orderId, ms: since(t0), ...errFields(err) });
    return json({ error: 'fulfilment_error', detail: String(err?.message || err) }, 500);
  }

  const after = await resolve(sessionId);
  const out = {
    action: 'replay',
    ok: !!res?.ok,
    error: res?.ok ? null : res?.error || 'fulfilment_failed',
    alreadyFulfilled: !!res?.alreadyFulfilled,
    inFlight: !!res?.inFlight,
    elapsedMs: since(t0),
    ...(after.error ? {} : describe(after)),
  };

  log.info('admin.replay_done', {
    sessionId: session.id,
    orderId,
    ok: out.ok,
    error: out.error,
    emailStatus: out.emailStatus,
    ms: out.elapsedMs,
  });

  // 409 on a held lock tells the operator to retry (or pass break_lock), rather
  // than reading a 200 as "delivered".
  if (!out.ok) return json(out, out.inFlight ? 409 : 500);
  return json(out);
}
