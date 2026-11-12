/**
 * POST /api/checkout/create-session
 * Body: { items: CartItem[], email: string, delivery: Delivery }
 * Validates server-side, creates a pending order, opens a Stripe Checkout
 * Session (hosted), and returns { url } for the browser to redirect to.
 * Prices are taken from the server catalogue — the client cannot set amounts.
 */
import { getStripe } from '../../../lib/stripe';
import { validateOrderInput, PACKAGES, CURRENCY } from '../../../lib/catalog';
import { createOrder, attachSession } from '../../../lib/orders';
import { putOrder as putSnapshot, pingKv } from '../../../lib/store.js';
import { packOrder } from '../../../lib/order-codec';
import { isResendConfigured, isWebhookConfigured } from '../../../lib/env.js';
import { log, errFields } from '../../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function originOf(req) {
  const o = req.headers.get('origin');
  if (o) return o.replace(/\/$/, '');
  const host = req.headers.get('host');
  if (host) return `https://${host}`;
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://astralisregistry.com').replace(/\/$/, '');
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const v = validateOrderInput(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  if (!process.env.STRIPE_SECRET_KEY) {
    return Response.json({ error: 'stripe_not_configured' }, { status: 500 });
  }

  // Never take money we cannot acknowledge: without Resend there is no receipt
  // and no certificate delivery, so refuse the sale instead of charging silently.
  if (!isResendConfigured()) {
    log.error('create_session.refused', { reason: 'resend_not_configured' });
    return Response.json({ error: 'fulfilment_not_configured' }, { status: 503 });
  }

  // Without a webhook secret nothing authoritative will ever fulfil the order:
  // the success page is only a dev-time fallback, so a customer who closes the
  // tab would be charged and receive nothing. Refuse rather than risk that.
  if (!isWebhookConfigured() && process.env.NODE_ENV === 'production') {
    log.error('create_session.refused', { reason: 'webhook_not_configured' });
    return Response.json({ error: 'fulfilment_not_configured' }, { status: 503 });
  }

  const order = createOrder(v.order);
  const origin = originOf(req);

  // The order travels with the Stripe session, so whichever instance handles the
  // webhook can fulfil it even with no shared storage. If it will not fit, the
  // store is the ONLY way the webhook will ever see this order — and being
  // configured is not enough: a deleted Upstash database passes every env check
  // and answers no commands. Ping it for real before taking the money.
  const packed = packOrder(order);
  if (!packed) {
    const kv = await pingKv();
    if (!kv.reachable) {
      log.error('create_session.refused', {
        reason: 'order_unrecoverable',
        kvConfigured: kv.configured,
        kvReachable: kv.reachable,
        kvError: kv.error || null,
        orderNo: order.orderNo,
        items: order.items.length,
      });
      return Response.json({ error: 'fulfilment_not_configured' }, { status: 503 });
    }
  }

  // Attach the shipping name / phone / address to the PaymentIntent so every
  // order is visible (and exportable) in the Stripe Dashboard for fulfilment.
  const dl = order.delivery || {};
  const shipping = dl.address1
    ? {
        name: dl.name || order.email,
        ...(dl.phone ? { phone: dl.phone } : {}),
        address: {
          line1: dl.address1,
          ...(dl.address2 ? { line2: dl.address2 } : {}),
          city: dl.suburb || dl.city || '',
          state: dl.state || '',
          postal_code: dl.postcode || '',
          country: 'AU',
        },
      }
    : null;

  let session;
  try {
    const stripe = getStripe();
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: order.email,
      line_items: order.items.map((it) => {
        const p = PACKAGES[it.pkg];
        const cons = it.star.cons || it.cons;
        return {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: p.priceCents,
            product_data: {
              name: `${p.name} · ${it.name}`.slice(0, 250),
              description: `Star ${it.star.id || 'to be assigned'}${cons ? ' · ' + cons : ''}`.slice(0, 250),
            },
          },
        };
      }),
      metadata: { orderId: order.id, orderNo: order.orderNo, ...(packed || {}) },
      payment_intent_data: {
        metadata: { orderId: order.id, orderNo: order.orderNo },
        ...(shipping ? { shipping } : {}),
      },
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout/cancel`,
    });
  } catch (err) {
    log.error('create_session.stripe_error', { orderNo: order.orderNo, ...errFields(err) });
    return Response.json({ error: 'stripe_error' }, { status: 502 });
  }

  attachSession(order.id, session.id);
  // Persist a durable copy so fulfilment works even if the webhook lands on a
  // cold/other serverless instance (and so KV-backed deploys survive restarts).
  // Reports rather than throws; `durable` is false when the store is unreachable
  // or unconfigured, in which case the session metadata is what carries the
  // order to the webhook. The .catch is belt-and-braces only.
  const snap = await putSnapshot(order).catch((err) => {
    log.error('create_session.snapshot_persist_failed', { orderNo: order.orderNo, ...errFields(err) });
    return { ok: false, durable: false, store: 'none', reason: 'unexpected' };
  });
  if (!snap.ok) {
    log.error('create_session.snapshot_persist_failed', {
      orderNo: order.orderNo,
      reason: snap.reason || 'unknown',
      error: snap.error || null,
      recoverableFromMetadata: !!packed,
    });
  }

  // The last line logged before the customer leaves for Stripe. Pair it with
  // webhook.received on the same orderId to see exactly where an order stopped.
  log.info('create_session.created', {
    orderId: order.id,
    orderNo: order.orderNo,
    email: order.email,
    sessionId: session.id,
    items: order.items.length,
    totalCents: order.totalCents,
    snapshotted: !!snap.ok,
    snapshotStore: snap.store || 'none',
    recoverableFromMetadata: !!packed,
  });

  return Response.json({ url: session.url, orderNo: order.orderNo });
}
