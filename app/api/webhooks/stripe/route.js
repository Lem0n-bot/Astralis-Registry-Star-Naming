/**
 * POST /api/webhooks/stripe
 * Stripe sends events here. We verify the signature against STRIPE_WEBHOOK_SECRET
 * using the RAW request body (req.text() — never parse before verifying), then
 * fulfil the order on checkout.session.completed. Fulfilment is idempotent, so
 * retried webhooks are safe.
 *
 * This is the AUTHORITATIVE fulfilment path. It answers 2xx only when the order
 * is genuinely fulfilled; anything else is a 5xx so Stripe retries for up to
 * 3 days and the failure is visible in the dashboard. Returning 200 for an
 * order that was not fulfilled is exactly how a paid customer ends up with
 * nothing, so every exit below is deliberate.
 *
 * Configure in the Stripe dashboard (or `stripe listen --forward-to`):
 *   endpoint:  https://<your-domain>/api/webhooks/stripe
 *   events:    checkout.session.completed, checkout.session.async_payment_succeeded
 */
import { getStripe } from '../../../lib/stripe';
import { fulfillOrder } from '../../../lib/fulfill';
import { unpackOrder } from '../../../lib/order-codec';
import { log, errFields, now, since } from '../../../lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Fulfilment renders certificates with headless Chromium, which on a cold
// serverless instance can take far longer than the platform default. Without
// this the function is killed mid-render: no certificate, no email, and a
// timeout Stripe reports as a failed delivery. lib/fulfill.js additionally
// bounds the render work (CERT_RENDER_BUDGET_MS) so the email always goes out
// inside this window — raise both together if the plan allows a longer run.
export const maxDuration = 60;

const HANDLED = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

export async function POST(req) {
  const t0 = now();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    log.error('webhook.not_configured', {
      hasWebhookSecret: !!secret,
      hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    });
    return Response.json({ error: 'webhook_not_configured' }, { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    // Almost always a STRIPE_WEBHOOK_SECRET that does not match this endpoint's
    // signing secret (test secret on a live endpoint, or a rotated secret).
    log.error('webhook.signature_invalid', { hasSignature: !!sig, bodyBytes: raw.length, ...errFields(err) });
    return Response.json({ error: 'invalid_signature' }, { status: 400 });
  }

  if (!HANDLED.includes(event.type)) {
    log.debug('webhook.ignored', { eventId: event.id, type: event.type });
    return Response.json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  const orderId = session.metadata?.orderId;
  const orderNo = session.metadata?.orderNo;

  log.info('webhook.received', {
    eventId: event.id,
    type: event.type,
    sessionId: session.id,
    orderId: orderId || null,
    orderNo: orderNo || null,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    livemode: event.livemode,
  });

  if (!orderId) {
    // Nothing we can fulfil or retry into existence. 200 so Stripe stops, but
    // loud in the logs: it means a session was created without our metadata.
    log.error('webhook.missing_order_id', { eventId: event.id, sessionId: session.id });
    return Response.json({ received: true, error: 'missing_order_id' });
  }

  if (session.payment_status !== 'paid') {
    log.info('webhook.not_paid_yet', { eventId: event.id, sessionId: session.id, paymentStatus: session.payment_status });
    return Response.json({ received: true, pending: true });
  }

  try {
    const res = await fulfillOrder(
      orderId,
      {
        sessionId: session.id,
        paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
        amountTotal: session.amount_total,
      },
      // The order as Stripe stored it, for when this instance has no record.
      unpackOrder(session.metadata),
      { source: 'webhook' }
    );

    // The buyer has been charged. If we could not deliver, fail the webhook so
    // Stripe retries (up to 3 days) and the event shows as failed in the
    // dashboard — never swallow this, or the money is taken in silence.
    //
    // `fulfilment_in_progress` lands here too, and must: it means another
    // instance holds the lock and had not finished when we gave up waiting. A
    // 200 here is the bug that stranded paid orders — Stripe would stop
    // retrying while nothing had actually been delivered.
    if (!res || !res.ok) {
      log.error('webhook.fulfilment_failed', {
        eventId: event.id,
        orderId,
        orderNo,
        error: res?.error || 'fulfilment_failed',
        inFlight: !!res?.inFlight,
        ms: since(t0),
      });
      return Response.json({ error: res?.error || 'fulfilment_failed' }, { status: 500 });
    }

    const emailStatus = res.order?.emailStatus;
    if (emailStatus && !['sent', 'skipped'].includes(emailStatus)) {
      // Fulfilment secured the payment and the certificates, but the receipt did
      // not land. Retry so repairEmail() gets another go at the customer's inbox.
      log.error('webhook.email_not_delivered', { eventId: event.id, orderId, orderNo, emailStatus, ms: since(t0) });
      return Response.json({ error: 'email_not_delivered' }, { status: 500 });
    }

    log.info('webhook.fulfilled', {
      eventId: event.id,
      orderId,
      orderNo: res.order?.orderNo || orderNo,
      alreadyFulfilled: !!res.alreadyFulfilled,
      emailStatus: emailStatus || null,
      ms: since(t0),
    });
    return Response.json({ received: true, fulfilled: true });
  } catch (err) {
    // Unexpected throw on a verified event: 500 so Stripe retries rather than
    // marking a charged-but-unfulfilled order as successfully handled.
    log.error('webhook.fulfilment_error', { eventId: event.id, orderId, orderNo, ms: since(t0), ...errFields(err) });
    return Response.json({ error: 'fulfilment_error' }, { status: 500 });
  }
}
