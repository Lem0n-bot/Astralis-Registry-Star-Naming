/**
 * GET /api/checkout/order?session_id=cs_...
 * Used by the success page to display the confirmation. Retrieves the Stripe
 * session, and — if paid — fulfils the order idempotently as a fallback (in case
 * the webhook is delayed or not configured, e.g. local dev). Returns a sanitised
 * summary plus signed certificate download links + the portal URL. Never returns
 * secrets or internal store data.
 */
import { getStripe } from '../../../lib/stripe';
import { getOrder } from '../../../lib/orders';
import { fulfillOrder } from '../../../lib/fulfill';
import { getOrder as getSnapshot } from '../../../lib/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // certificate rendering can run here as a fallback

export async function GET(req) {
  const sessionId = new URL(req.url).searchParams.get('session_id');
  if (!sessionId) return Response.json({ error: 'missing_session' }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return Response.json({ error: 'stripe_not_configured' }, { status: 500 });

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const orderId = session.metadata?.orderId;
  const paid = session.payment_status === 'paid';

  if (paid && orderId) {
    await fulfillOrder(orderId, {
      sessionId: session.id,
      paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
      amountTotal: session.amount_total,
    });
  }

  const snap = orderId ? await getSnapshot(orderId) : null;
  const order = snap || (orderId ? getOrder(orderId) : null);
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

  return Response.json({
    paid,
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
    emailStatus: snap?.emailStatus || null,
  });
}
