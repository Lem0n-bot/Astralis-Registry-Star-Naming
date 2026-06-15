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

  const order = createOrder(v.order);
  const origin = originOf(req);

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
      metadata: { orderId: order.id, orderNo: order.orderNo },
      payment_intent_data: { metadata: { orderId: order.id, orderNo: order.orderNo } },
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout/cancel`,
    });
  } catch (err) {
    console.error('[create-session] stripe error', err?.message);
    return Response.json({ error: 'stripe_error' }, { status: 502 });
  }

  attachSession(order.id, session.id);
  return Response.json({ url: session.url, orderNo: order.orderNo });
}
