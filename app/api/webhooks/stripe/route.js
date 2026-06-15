/**
 * POST /api/webhooks/stripe
 * Stripe sends events here. We verify the signature against STRIPE_WEBHOOK_SECRET
 * using the RAW request body (req.text() — never parse before verifying), then
 * fulfil the order on checkout.session.completed. Fulfilment is idempotent, so
 * retried webhooks are safe. Always 2xx once verified so Stripe stops retrying.
 *
 * Configure in the Stripe dashboard (or `stripe listen --forward-to`):
 *   endpoint:  https://<your-domain>/api/webhooks/stripe
 *   events:    checkout.session.completed
 */
import { getStripe } from '../../../lib/stripe';
import { fulfillOrder } from '../../../lib/fulfill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    return Response.json({ error: 'webhook_not_configured' }, { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('[webhook] signature verification failed', err?.message);
    return Response.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;
      if (orderId && session.payment_status === 'paid') {
        await fulfillOrder(orderId, {
          sessionId: session.id,
          paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
          amountTotal: session.amount_total,
        });
      }
    }
  } catch (err) {
    // Log but still 200 — the event was valid; re-driving fulfilment can be
    // handled separately. (markPaid is idempotent if Stripe retries.)
    console.error('[webhook] fulfilment error', err?.message);
  }

  return Response.json({ received: true });
}
