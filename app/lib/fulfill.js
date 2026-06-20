/**
 * Order fulfilment — the single, idempotent place that runs after a successful
 * payment. Called from BOTH the Stripe webhook (reliable) and the success-page
 * lookup (fast fallback / local dev without the Stripe CLI). Running it twice is
 * safe: a durable "fulfilled" snapshot + a best-effort lock guard re-entry.
 *
 * On first fulfilment it:
 *   1. marks the order paid + records the payment,
 *   2. marks each purchased star as claimed,
 *   3. mints a certificate id per star and renders + stores a PDF/PNG,
 *   4. persists a durable order snapshot (so the no-login portal works even if
 *      email fails), then
 *   5. emails one confirmation with all PDFs attached + preview/download links,
 *      with retry + per-order delivery logging.
 */
import { Resend } from 'resend';
import { getOrder, markPaid, claimStar, markEmailSent, markCertificate } from './orders';
import { generateCertificate } from './certificates';
import { orderConfirmationHtml, fulfillmentNotificationHtml, orderFulfilment } from './order-email';
import {
  putOrder as putSnapshot,
  getOrder as getSnapshot,
  getBlob,
  acquireLock,
  releaseLock,
} from './store.js';
import { signToken } from './ids.js';
import { ENV, isResendConfigured } from './env.js';
import { withRetry } from './retry.js';

const publicBase = () => (ENV.SITE_URL || 'https://astralisregistry.com').replace(/\/+$/, '');

export async function fulfillOrder(orderId, payment) {
  if (!orderId) return { ok: false, error: 'order_not_found' };

  // Idempotency: a durable fulfilled snapshot short-circuits any re-entry
  // (webhook + success page, retried webhooks, a cold serverless instance).
  const existing = await getSnapshot(orderId);
  if (existing && existing.fulfilled) return { ok: true, alreadyFulfilled: true, order: existing };

  // Resolve the order data: in-memory working order, else the durable pending snapshot.
  const order = getOrder(orderId) || existing;
  if (!order) return { ok: false, error: 'order_not_found' };

  // Best-effort lock so the webhook and the success-page fallback don't both render/email.
  if (!(await acquireLock(orderId))) {
    const cur = await getSnapshot(orderId);
    return { ok: true, alreadyFulfilled: !!(cur && cur.fulfilled), order: cur || order, inFlight: true };
  }

  try {
    const again = await getSnapshot(orderId);
    if (again && again.fulfilled) return { ok: true, alreadyFulfilled: true, order: again };

    if (getOrder(orderId)) markPaid(orderId, payment); // in-memory lifecycle + claims

    const snap = {
      id: order.id,
      orderNo: order.orderNo,
      status: 'paid',
      createdAt: order.createdAt || Date.now(),
      paidAt: Date.now(),
      email: order.email,
      items: order.items,
      delivery: order.delivery || null,
      totalCents: order.totalCents,
      currency: order.currency,
      sessionId: payment?.sessionId || order.sessionId || null,
      paymentIntent: payment?.paymentIntent || order.paymentIntent || null,
      token: signToken(order.id),
      fulfilled: false,
      fulfilledAt: null,
      certificates: [],
      emailStatus: 'pending',
      deliveryLog: [],
    };

    // 2 + 3: claim stars, mint cert ids, render + store each certificate
    const certs = [];
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      claimStar(item.star?.id, { orderId: order.id, orderNo: order.orderNo, name: item.name, email: order.email });
      try {
        const rec = await generateCertificate(order, item, i);
        certs.push(rec);
        snap.certificates.push({ certId: rec.certId, itemIndex: i, name: rec.name, starId: rec.starId, theme: rec.theme });
      } catch (err) {
        console.error('[fulfill] certificate render failed', order.orderNo, i, err?.message);
        snap.deliveryLog.push({ ts: Date.now(), stage: 'certificate', itemIndex: i, status: 'error', error: String(err?.message || err) });
      }
    }

    // 4: persist the durable snapshot BEFORE emailing — the portal + downloads
    // must work even if email delivery later fails.
    snap.fulfilled = true;
    snap.fulfilledAt = Date.now();
    await putSnapshot(snap);
    if (getOrder(orderId)) markCertificate(orderId, certs.length === order.items.length ? 'generated' : 'partial');

    // 5: confirmation email (retry + logging; never undoes a paid fulfilment)
    snap.emailStatus = await sendConfirmation(snap, certs);
    // 5b: internal "new order to ship" notification to the owner (best-effort).
    await sendOwnerNotification(snap);
    await putSnapshot(snap);
    if (snap.emailStatus === 'sent' && getOrder(orderId)) markEmailSent(orderId);

    return { ok: true, alreadyFulfilled: false, order: snap };
  } finally {
    await releaseLock(orderId);
  }
}

/** Send the confirmation email with PDF attachments, retrying on failure and
 *  recording the outcome on the order's delivery log. Returns the email status. */
async function sendConfirmation(snap, certs) {
  if (!isResendConfigured()) {
    snap.deliveryLog.push({ ts: Date.now(), stage: 'email', status: 'skipped', reason: 'resend_not_configured' });
    return 'skipped';
  }

  const base = publicBase();
  const token = snap.token;
  const portalUrl = `${base}/orders/${snap.id}?token=${token}`;
  const certViewUrl = `${base}/?cert=${snap.id}&token=${token}`;   // client-rendered, downloadable viewer
  const certLinks = certs.map((c) => ({
    certId: c.certId,
    name: c.name,
    pdfUrl: `${base}/api/orders/${snap.id}/certificate/${c.certId}?format=pdf&token=${token}`,
    pngUrl: `${base}/api/orders/${snap.id}/certificate/${c.certId}?format=png&token=${token}`,
  }));

  const attachments = [];
  for (const c of certs) {
    const pdf = await getBlob(c.certId, 'pdf');
    if (pdf) attachments.push({ filename: `Astralis-Certificate-${c.certId}.pdf`, content: pdf.toString('base64') });
  }

  const html = orderConfirmationHtml(snap, { certificates: certLinks, portalUrl, certViewUrl });
  const resend = new Resend(ENV.RESEND_API_KEY);
  const plural = certs.length > 1;

  try {
    const res = await withRetry(
      async () => {
        const r = await resend.emails.send({
          from: ENV.RESEND_FROM,
          to: snap.email,
          subject: `Your Astralis certificate${plural ? 's are' : ' is'} ready · ${snap.orderNo}`,
          html,
          attachments,
        });
        if (r && r.error) throw new Error(r.error.message || 'resend_error');
        return r;
      },
      {
        tries: 3,
        baseDelayMs: 600,
        onError: (err, attempt) =>
          snap.deliveryLog.push({ ts: Date.now(), stage: 'email', attempt, status: 'retry', error: String(err?.message || err) }),
      }
    );
    snap.deliveryLog.push({ ts: Date.now(), stage: 'email', status: 'sent', providerId: res?.data?.id || null });
    return 'sent';
  } catch (err) {
    // Fallback: payment + certificates are already secured; the portal serves the
    // downloads, and the order is flagged email_failed for a manual re-send.
    snap.deliveryLog.push({ ts: Date.now(), stage: 'email', status: 'failed', error: String(err?.message || err) });
    console.error('[fulfill] confirmation email failed after retries', snap.orderNo, err?.message);
    return 'failed';
  }
}

/** Internal notification so the owner can ship the order via AusPost. Best-effort:
 *  a failure here never affects the (already secured) payment, certificates or
 *  customer email. */
async function sendOwnerNotification(snap) {
  if (!isResendConfigured() || !ENV.ORDER_NOTIFY_EMAIL) {
    snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', status: 'skipped' });
    return;
  }
  try {
    const resend = new Resend(ENV.RESEND_API_KEY);
    const shipTo = (snap.delivery && snap.delivery.name) || snap.email;
    const r = await resend.emails.send({
      from: ENV.RESEND_FROM,
      to: ENV.ORDER_NOTIFY_EMAIL,
      replyTo: snap.email,
      // subject leads with the fulfilment action so digital ($39) vs ship
      // ($79) vs priority ($139) orders are obvious in the inbox.
      subject: `${orderFulfilment(snap).subject} · ${snap.orderNo} · ${shipTo}`,
      html: fulfillmentNotificationHtml(snap),
    });
    if (r && r.error) throw new Error(r.error.message || 'resend_error');
    snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', status: 'sent', providerId: r?.data?.id || null });
  } catch (err) {
    snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', status: 'failed', error: String(err?.message || err) });
    console.error('[fulfill] owner notification failed', snap.orderNo, err?.message);
  }
}
