/**
 * GET /api/checkout/order?session_id=cs_...
 * Used by the success page to display the confirmation. Retrieves the Stripe
 * session and returns a sanitised summary plus signed certificate download links
 * and the portal URL. Never returns secrets or internal store data.
 *
 * This route is READ-ONLY whenever a Stripe webhook is configured, which is the
 * single most important thing about it. It used to run the full fulfilment —
 * cold-start Chromium plus one render per purchased star — inside the customer's
 * page load, on a 60s function. The render outlived the limit, the function was
 * killed before anything was persisted or emailed, the browser got a 504 instead
 * of JSON, and the page told a customer who had just been charged that their
 * payment "could not be confirmed". It also held the fulfilment lock while dying,
 * which made the concurrent webhook give up and report success to Stripe.
 *
 * So: the webhook fulfils (and Stripe retries it for 3 days if it fails). This
 * route only reports. The one exception is an environment with no webhook secret
 * — local dev without `stripe listen` — where it stays the fallback, because
 * there is nothing else to deliver the order.
 */
import { getStripe } from '../../../lib/stripe';
import { getOrder } from '../../../lib/orders';
import { fulfillOrder } from '../../../lib/fulfill';
import { getOrder as getSnapshot } from '../../../lib/store.js';
import { unpackOrder } from '../../../lib/order-codec';
import { isWebhookConfigured } from '../../../lib/env.js';
import { log, errFields } from '../../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // only used by the no-webhook dev fallback

export async function GET(req) {
  const sessionId = new URL(req.url).searchParams.get('session_id');
  if (!sessionId) return Response.json({ error: 'missing_session' }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return Response.json({ error: 'stripe_not_configured' }, { status: 500 });

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    log.warn('order_lookup.session_not_found', { sessionId, ...errFields(err) });
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const orderId = session.metadata?.orderId;
  const paid = session.payment_status === 'paid';

  // Order as Stripe stored it — lets this instance describe (and, in dev, fulfil)
  // an order it never saw. See lib/order-codec.js.
  const recovered = unpackOrder(session.metadata);

  let snap = orderId ? await getSnapshot(orderId) : null;

  // Dev fallback only: with no webhook configured nothing else will ever fulfil
  // this order. In production this branch is skipped, so the response is fast
  // and cannot be killed mid-render.
  if (paid && orderId && !isWebhookConfigured() && !(snap && snap.fulfilled)) {
    log.info('order_lookup.dev_fallback_fulfil', { sessionId, orderId });
    try {
      const res = await fulfillOrder(
        orderId,
        {
          sessionId: session.id,
          paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
          amountTotal: session.amount_total,
        },
        recovered,
        { source: 'success_page' }
      );
      if (res?.order) snap = res.order;
    } catch (err) {
      // Never let the fallback turn a successful payment into an error page.
      log.error('order_lookup.dev_fallback_failed', { sessionId, orderId, ...errFields(err) });
    }
  }

  const order = snap || (orderId ? getOrder(orderId) : null) || recovered;
  const token = snap?.token || null;

  const certificates =
    token && snap?.certificates
      ? snap.certificates.map((c) => ({
          certId: c.certId,
          name: c.name,
          pdfUrl: `/api/orders/${orderId}/certificate/${c.certId}?format=pdf&token=${token}`,
          pngUrl: `/api/orders/${orderId}/certificate/${c.certId}?format=png&token=${token}`,
        }))
      : [];

  // The payment is confirmed the moment Stripe says `paid`. Fulfilment is a
  // separate, slower fact — the page must never present a delay in one as a
  // failure of the other.
  const fulfilment = !paid ? 'unpaid' : snap?.fulfilled ? 'complete' : 'pending';

  if (paid && fulfilment === 'pending') {
    log.info('order_lookup.awaiting_fulfilment', { sessionId, orderId, orderNo: order?.orderNo || null });
  }

  return Response.json({
    paid,
    fulfilment,
    orderId: orderId || null,
    orderNo: order?.orderNo || session.metadata?.orderNo || null,
    email: session.customer_email || order?.email || null,
    amountTotal: session.amount_total,
    currency: session.currency,
    items: order
      ? order.items.map((it) => ({ name: it.name, pkg: it.pkg, starId: it.star?.id || null, cons: it.cons || null }))
      : [],
    certificates,
    portalUrl: token ? `/orders/${orderId}?token=${token}` : null,
    certViewUrl: token ? `/?cert=${orderId}&token=${token}` : null,
    emailStatus: snap?.emailStatus || null,
  });
}
