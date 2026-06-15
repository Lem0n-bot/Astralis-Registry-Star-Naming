/**
 * GET /api/checkout/order?session_id=cs_...
 * Used by the success page to display the confirmation. Retrieves the Stripe
 * session, and — if paid — fulfils the order idempotently as a fallback (in
 * case the webhook is delayed or not configured, e.g. local dev). Returns only
 * a sanitised summary; never secrets or internal store data.
 */
import { getStripe } from '../../../lib/stripe';
import { getOrder } from '../../../lib/orders';
import { fulfillOrder } from '../../../lib/fulfill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const order = orderId ? getOrder(orderId) : null;
  return Response.json({
    paid,
    orderNo: order?.orderNo || session.metadata?.orderNo || null,
    email: session.customer_email || order?.email || null,
    amountTotal: session.amount_total,
    currency: session.currency,
    items: order
      ? order.items.map((it) => ({ name: it.name, pkg: it.pkg, starId: it.star?.id || null, cons: it.cons || null }))
      : [],
  });
}
