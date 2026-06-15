/**
 * Order fulfilment — the single, idempotent place that runs after a successful
 * payment. Called from BOTH the Stripe webhook (reliable) and the success-page
 * lookup (fast fallback / works in local dev without the Stripe CLI). Running
 * it twice is safe: markPaid() reports alreadyFulfilled and we bail.
 *
 * On first fulfilment it:
 *   1. marks the order paid + records the payment,
 *   2. marks each purchased star as claimed,
 *   3. queues certificate generation,
 *   4. sends the confirmation email via Resend (best-effort).
 */
import { Resend } from 'resend';
import { getOrder, markPaid, claimStar, markEmailSent } from './orders';
import { queueCertificate } from './certificates';
import { orderConfirmationHtml } from './order-email';

const FROM = 'Astralis Registry <noreply@astralisregistry.com>';

/**
 * @param {string} orderId
 * @param {{sessionId?:string, paymentIntent?:string, amountTotal?:number}} [payment]
 */
export async function fulfillOrder(orderId, payment) {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: 'order_not_found' };

  const { order: o, alreadyFulfilled } = markPaid(orderId, payment);
  if (alreadyFulfilled) return { ok: true, alreadyFulfilled: true, order: o };

  // 2 + 3: claim stars and queue certificate generation
  for (const item of o.items) {
    claimStar(item.star?.id, { orderId: o.id, orderNo: o.orderNo, name: item.name, email: o.email });
    queueCertificate(o, item);
  }

  // 4: confirmation email (never let a mail failure undo a paid fulfilment)
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: FROM,
        to: o.email,
        subject: 'Your Astralis order is confirmed',
        html: orderConfirmationHtml(o),
      });
      markEmailSent(o.id);
    } catch (err) {
      console.error('[fulfill] confirmation email failed', o.orderNo, err?.message);
    }
  }

  return { ok: true, alreadyFulfilled: false, order: o };
}
