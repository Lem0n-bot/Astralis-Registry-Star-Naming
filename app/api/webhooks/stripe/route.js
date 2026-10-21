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
import { unpackOrder } from '../../../lib/order-codec';

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
        const res = await fulfillOrder(
          orderId,
          {
            sessionId: session.id,
            paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
            amountTotal: session.amount_total,
          },
          // The order as Stripe stored it, for when this instance has no record.
          unpackOrder(session.metadata)
        );

        // The buyer has been charged. If we could not deliver, fail the webhook
        // so Stripe retries (up to 3 days) and the event shows as failed in the
        // dashboard — never swallow this, or the money is taken in silence.
        if (!res || !res.ok) {
          console.error('[webhook] fulfilment failed', orderId, res?.error);
          return Response.json({ error: res?.error || 'fulfilment_failed' }, { status: 500 });
        }
        if (res.order && res.order.emailStatus && !['sent', 'skipped'].includes(res.order.emailStatus)) {
          console.error('[webhook] receipt email not delivered', orderId, res.order.emailStatus);
          return Response.json({ error: 'email_not_delivered' }, { status: 500 });
        }
      }
    }
  } catch (err) {
    // Unexpected throw on a verified event: 500 so Stripe retries rather than
    // marking a charged-but-unfulfilled order as successfully handled.
    console.error('[webhook] fulfilment error', err?.message);
    return Response.json({ error: 'fulfilment_error' }, { status: 500 });
  }

  return Response.json({ received: true });
}
