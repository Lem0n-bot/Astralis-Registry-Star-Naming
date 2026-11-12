/**
 * Order fulfilment — the single, idempotent place that runs after a successful
 * payment. Called from the Stripe webhook (the authoritative path), the
 * success-page lookup (fallback when no webhook is configured, e.g. local dev
 * without the Stripe CLI) and the admin replay route. Running it twice is safe:
 * a durable "fulfilled" snapshot + a best-effort lock guard re-entry.
 *
 * On first fulfilment it:
 *   1. marks the order paid + records the payment,
 *   2. marks each purchased star as claimed,
 *   3. mints a certificate id for EVERY purchased star and persists the paid
 *      snapshot — before any rendering, so what the customer is owed is durable
 *      even if the renderer never finishes,
 *   4. renders + caches as many certificate PDFs as fit in a time budget,
 *   5. emails one confirmation with the rendered PDFs attached and working links
 *      for every certificate, with retry + per-order delivery logging.
 *
 * ORDERING IS THE WHOLE POINT. Headless Chromium is the only step that can blow
 * the serverless time limit, and when it did, the function was killed before the
 * email step and the customer got nothing. Rendering is therefore bounded, runs
 * AFTER the durable snapshot, and can never starve the email: a certificate with
 * no PDF still has a working download link, because the download route
 * re-renders on demand and the client-side viewer needs no Chromium at all.
 */
import { Resend } from 'resend';
import { getOrder, markPaid, claimStar, markEmailSent, markCertificate } from './orders';
import { mintCertificate, renderAndStoreCertificate } from './certificates';
import { orderConfirmationHtml, fulfillmentNotificationHtml, orderFulfilment } from './order-email';
import {
  putOrder as putSnapshot,
  getOrder as getSnapshot,
  getBlob,
  acquireLock,
  releaseLock,
} from './store.js';
import { signToken } from './ids.js';
import { ENV, isResendConfigured, OWNER_COPY_PACKAGES, ownerCopyWanted } from './env.js';
import { withRetry, withTimeout } from './retry.js';
import { log, errFields, now, since } from './log.js';

const publicBase = () => (ENV.SITE_URL || 'https://astralisregistry.com').replace(/\/+$/, '');

/** Total wall-clock allowed for ALL certificate renders in one invocation. Must
 *  leave room inside the route's maxDuration for the snapshot write + both
 *  emails, which are what the customer actually needs. */
const RENDER_BUDGET_MS = Number(process.env.CERT_RENDER_BUDGET_MS || 34_000);
/** Ceiling for a single render, so one wedged page cannot eat the whole budget. */
const PER_CERT_TIMEOUT_MS = Number(process.env.CERT_RENDER_TIMEOUT_MS || 22_000);
/** How long to wait for another instance's in-flight fulfilment to finish before
 *  reporting failure (and letting Stripe retry). */
const LOCK_WAIT_MS = Number(process.env.FULFIL_LOCK_WAIT_MS || 12_000);
/** Cap on total attachment bytes per email, before base64 expansion. */
const MAX_ATTACH_BYTES = Number(process.env.MAX_ATTACH_BYTES || 12_000_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll for another instance to finish fulfilling this order. */
async function waitForFulfilment(orderId, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(750);
    const cur = await getSnapshot(orderId);
    if (cur && cur.fulfilled) return cur;
  }
  return null;
}

/**
 * @param {string} orderId
 * @param {object} payment
 * @param {object} [recovered] Order rebuilt from Stripe metadata. Used only when
 *   neither the in-memory order nor a durable snapshot is available — i.e. the
 *   fulfilling instance is not the one that created the order and KV is not
 *   configured. Without it, that case silently charges the buyer and delivers
 *   nothing. See ./order-codec.js.
 * @param {{source?:string, budgetMs?:number, lockWaitMs?:number, forceEmail?:boolean}} [opts]
 */
export async function fulfillOrder(orderId, payment, recovered, opts = {}) {
  const source = opts.source || 'unknown';
  const t0 = now();
  if (!orderId) {
    log.error('fulfil.no_order_id', { source });
    return { ok: false, error: 'order_not_found' };
  }

  // Idempotency: a durable fulfilled snapshot short-circuits any re-entry
  // (webhook + success page, retried webhooks, a cold serverless instance).
  const existing = await getSnapshot(orderId);
  if (existing && existing.fulfilled) {
    log.info('fulfil.already_fulfilled', {
      source,
      orderId,
      orderNo: existing.orderNo,
      emailStatus: existing.emailStatus,
    });
    return { ok: true, alreadyFulfilled: true, order: await repairEmail(existing, opts) };
  }

  // Resolve the order data: in-memory working order, else the durable pending
  // snapshot, else the copy Stripe carried back to us.
  const working = getOrder(orderId);
  const order = working || existing || recovered || null;
  if (!order) {
    log.error('fulfil.order_not_found', { source, orderId, hasRecovered: !!recovered });
    return { ok: false, error: 'order_not_found' };
  }
  log.info('fulfil.start', {
    source,
    orderId,
    orderNo: order.orderNo,
    email: order.email,
    items: (order.items || []).length,
    resolvedFrom: working ? 'memory' : existing ? 'snapshot' : 'stripe_metadata',
  });

  // Best-effort lock so the webhook and the success-page fallback do not both
  // render/email. If somebody else holds it, wait for them to finish — and if
  // they do not, report FAILURE. Reporting success here is what stranded paid
  // orders: the webhook saw ok:true, returned 200, and Stripe stopped retrying.
  if (!(await acquireLock(orderId))) {
    const finished = await waitForFulfilment(orderId, opts.lockWaitMs ?? LOCK_WAIT_MS);
    if (finished) {
      log.info('fulfil.completed_elsewhere', { source, orderId, orderNo: finished.orderNo, waitedMs: since(t0) });
      return { ok: true, alreadyFulfilled: true, order: finished };
    }
    log.warn('fulfil.in_progress_elsewhere', { source, orderId, orderNo: order.orderNo, waitedMs: since(t0) });
    return { ok: false, error: 'fulfilment_in_progress', inFlight: true, order: existing || order };
  }

  try {
    const again = await getSnapshot(orderId);
    if (again && again.fulfilled) {
      log.info('fulfil.already_fulfilled', { source, orderId, orderNo: again.orderNo, raced: true });
      return { ok: true, alreadyFulfilled: true, order: await repairEmail(again, opts) };
    }

    if (working) markPaid(orderId, payment); // in-memory lifecycle + claims

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

    // 2 + 3: claim stars and mint a certificate id for EVERY item, reusing any id
    // a previous attempt already issued so replays do not churn certificate
    // numbers. This happens before rendering so the snapshot records exactly what
    // the customer is owed even if the renderer never gets there.
    const priorIds = new Map(((existing && existing.certificates) || []).map((c) => [c.itemIndex, c.certId]));
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      claimStar(item.star?.id, { orderId: order.id, orderNo: order.orderNo, name: item.name, email: order.email });
      const rec = await mintCertificate(order, item, i, priorIds.get(i));
      snap.certificates.push({
        certId: rec.certId,
        itemIndex: i,
        name: rec.name,
        starId: rec.starId,
        theme: rec.theme,
        rendered: false,
      });
    }

    await persistSnapshot(snap, 'paid');

    // 4: render what fits in the budget. Each failure/skip is recorded and the
    // certificate stays deliverable through its on-demand download link.
    const budgetMs = opts.budgetMs ?? RENDER_BUDGET_MS;
    const renderStart = now();
    const certs = [];
    let rendered = 0;
    for (const entry of snap.certificates) {
      const item = order.items[entry.itemIndex];
      const elapsed = since(renderStart);
      if (elapsed >= budgetMs) {
        snap.deliveryLog.push({
          ts: Date.now(),
          stage: 'certificate',
          itemIndex: entry.itemIndex,
          status: 'deferred',
          reason: 'render_budget_exhausted',
        });
        log.warn('cert.deferred', { orderNo: snap.orderNo, certId: entry.certId, itemIndex: entry.itemIndex, elapsedMs: elapsed, budgetMs });
        certs.push({ certId: entry.certId, name: entry.name, pdf: null });
        continue;
      }
      const slice = Math.min(PER_CERT_TIMEOUT_MS, budgetMs - elapsed);
      try {
        const out = await withTimeout(
          renderAndStoreCertificate(item, entry.certId, { orderNo: snap.orderNo }),
          slice,
          'cert_render'
        );
        entry.rendered = true;
        rendered++;
        certs.push({ certId: entry.certId, name: entry.name, pdf: out.pdf });
        snap.deliveryLog.push({ ts: Date.now(), stage: 'certificate', itemIndex: entry.itemIndex, status: 'rendered', ms: out.ms });
      } catch (err) {
        snap.deliveryLog.push({
          ts: Date.now(),
          stage: 'certificate',
          itemIndex: entry.itemIndex,
          status: 'error',
          error: String(err?.message || err),
        });
        log.error('cert.render_failed', { orderNo: snap.orderNo, certId: entry.certId, itemIndex: entry.itemIndex, timeoutMs: slice, ...errFields(err) });
        certs.push({ certId: entry.certId, name: entry.name, pdf: null });
      }
    }
    log.info('cert.batch_done', { orderNo: snap.orderNo, total: snap.certificates.length, rendered, ms: since(renderStart) });

    // 5: confirmation email. Always attempted, whatever rendering managed.
    snap.emailStatus = await sendConfirmation(snap, certs);
    // 5b: internal "new order to ship" notification to the owner, carrying the
    // rendered certificates so printing can start straight from the inbox.
    snap.ownerEmailStatus = await sendOwnerNotification(snap, certs);

    snap.fulfilled = true;
    snap.fulfilledAt = Date.now();
    const persisted = await persistSnapshot(snap, 'fulfilled');
    if (working) {
      markCertificate(orderId, rendered === order.items.length ? 'generated' : 'partial');
      if (snap.emailStatus === 'sent') markEmailSent(orderId);
    }

    log.info('fulfil.done', {
      source,
      orderId,
      orderNo: snap.orderNo,
      certificates: snap.certificates.length,
      rendered,
      emailStatus: snap.emailStatus,
      ownerEmailStatus: snap.ownerEmailStatus,
      persisted,
      totalMs: since(t0),
    });

    // The customer email is the deliverable, but a snapshot that would not
    // persist means the portal and every download link are dead. Report failure
    // so the caller retries — a duplicate email beats an unreachable certificate.
    if (!persisted) return { ok: false, error: 'snapshot_persist_failed', order: snap };

    return { ok: true, alreadyFulfilled: false, order: snap };
  } finally {
    await releaseLock(orderId);
  }
}

/** Persist the order snapshot, retried — this is the record that makes the
 *  no-login portal and every certificate download link work. */
async function persistSnapshot(snap, phase) {
  try {
    await withRetry(() => putSnapshot(snap), { tries: 3, baseDelayMs: 300 });
    return true;
  } catch (err) {
    log.error('fulfil.snapshot_persist_failed', { orderNo: snap.orderNo, orderId: snap.id, phase, ...errFields(err) });
    return false;
  }
}

/**
 * Re-send the receipt for an order that is already fulfilled but whose email
 * never landed. Without this, a retried webhook keeps short-circuiting on the
 * fulfilled snapshot and the buyer never receives anything. Certificates are
 * re-attached from the cached blobs (and their links re-render on demand);
 * nothing is re-rendered inline and nothing is re-charged.
 */
async function repairEmail(snap, opts = {}) {
  const force = !!opts.forceEmail;
  if (!snap || (!force && snap.emailStatus !== 'failed')) return snap;
  const certs = (snap.certificates || []).map((c) => ({ certId: c.certId, name: c.name, pdf: null }));
  log.warn('fulfil.email_repair', { orderNo: snap.orderNo, previousStatus: snap.emailStatus, forced: force });
  snap.emailStatus = await sendConfirmation(snap, certs);
  if (force) snap.ownerEmailStatus = await sendOwnerNotification(snap, certs);
  await persistSnapshot(snap, 'email_repair');
  return snap;
}

/** Signed, no-login download links for each certificate. Present for every
 *  purchased star, rendered or not — the download route renders on demand. */
function certLinksFor(snap, certs) {
  const base = publicBase();
  return certs.map((c) => ({
    certId: c.certId,
    name: c.name,
    pdfUrl: `${base}/api/orders/${snap.id}/certificate/${c.certId}?format=pdf&token=${snap.token}`,
    pngUrl: `${base}/api/orders/${snap.id}/certificate/${c.certId}?format=png&token=${snap.token}`,
  }));
}

/**
 * Build the PDF attachment list. Prefers the buffer we just rendered — reading it
 * back from the store usually returns nothing, because a base64 certificate PDF
 * is over Vercel KV's per-value limit. Anything missing is simply not attached;
 * its link still works.
 */
async function pdfAttachments(certs, orderNo) {
  const out = [];
  let bytes = 0;
  for (const c of certs) {
    let pdf = c.pdf;
    if (!pdf) pdf = await getBlob(c.certId, 'pdf');
    if (!pdf) continue;
    if (bytes + pdf.length > MAX_ATTACH_BYTES) {
      log.warn('email.attachments_capped', { orderNo, certId: c.certId, bytes, limit: MAX_ATTACH_BYTES });
      break;
    }
    bytes += pdf.length;
    out.push({ filename: `Astralis-Certificate-${c.certId}.pdf`, content: Buffer.from(pdf).toString('base64') });
  }
  return out;
}

/** Send the confirmation email with PDF attachments, retrying on failure and
 *  recording the outcome on the order's delivery log. Returns the email status. */
async function sendConfirmation(snap, certs) {
  if (!isResendConfigured()) {
    snap.deliveryLog.push({ ts: Date.now(), stage: 'email', status: 'skipped', reason: 'resend_not_configured' });
    log.warn('email.skipped', { orderNo: snap.orderNo, reason: 'resend_not_configured' });
    return 'skipped';
  }

  const base = publicBase();
  const token = snap.token;
  const portalUrl = `${base}/orders/${snap.id}?token=${token}`;
  const certViewUrl = `${base}/?cert=${snap.id}&token=${token}`;   // client-rendered, downloadable viewer
  const certLinks = certLinksFor(snap, certs);
  const attachments = await pdfAttachments(certs, snap.orderNo);

  const html = orderConfirmationHtml(snap, { certificates: certLinks, portalUrl, certViewUrl });
  const resend = new Resend(ENV.RESEND_API_KEY);
  const plural = certs.length > 1;
  const t0 = now();

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
        onError: (err, attempt) => {
          snap.deliveryLog.push({ ts: Date.now(), stage: 'email', attempt, status: 'retry', error: String(err?.message || err) });
          log.warn('email.retry', { orderNo: snap.orderNo, attempt, ...errFields(err) });
        },
      }
    );
    snap.deliveryLog.push({ ts: Date.now(), stage: 'email', status: 'sent', providerId: res?.data?.id || null });
    log.info('email.sent', {
      orderNo: snap.orderNo,
      email: snap.email,
      providerId: res?.data?.id || null,
      attachments: attachments.length,
      certificates: certLinks.length,
      ms: since(t0),
    });
    return 'sent';
  } catch (err) {
    // Fallback: payment + certificate ids are already secured; the portal serves
    // the downloads, and the order is flagged failed for a retried re-send.
    snap.deliveryLog.push({ ts: Date.now(), stage: 'email', status: 'failed', error: String(err?.message || err) });
    log.error('email.failed', {
      orderNo: snap.orderNo,
      email: snap.email,
      attachments: attachments.length,
      ms: since(t0),
      ...errFields(err),
    });
    return 'failed';
  }
}

/** The owner's copy of an order: buyer, address, items and the rendered
 *  certificates (linked always, attached per OWNER_COPY_PACKAGES).
 *
 *  Sent for EVERY order, deliberately — it is how a Premium/Ultimate order
 *  awaiting postage gets noticed, so narrowing it by package would cause missed
 *  shipments. OWNER_COPY_PACKAGES controls only whether the PDFs ride along, so
 *  a digital-only Standard order can still be forwarded straight from the inbox
 *  when a customer asks support for their certificate again.
 *
 *  Retried like the customer receipt — if this never lands, the order is never
 *  printed, so it is not fire-and-forget. A failure here cannot undo the
 *  already-secured payment, certificates or customer email: it is recorded on
 *  the delivery log, logged, and returned as a status that no caller treats as
 *  fatal.
 *  @returns {Promise<'sent'|'failed'|'skipped'>}
 */
async function sendOwnerNotification(snap, certs = []) {
  if (!isResendConfigured() || !ENV.ORDER_NOTIFY_EMAIL) {
    snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', status: 'skipped' });
    return 'skipped';
  }

  const base = publicBase();
  const certLinks = certLinksFor(snap, certs);
  const needsShip = orderFulfilment(snap).needsShip;
  // Attach when the order has anything to print, or when any of its packages is
  // configured for an owner copy of the PDF.
  const attachPdfs = needsShip || ownerCopyWanted(snap.items || []);
  const attachments = attachPdfs ? await pdfAttachments(certs, snap.orderNo) : [];
  const shipTo = (snap.delivery && snap.delivery.name) || snap.email;

  try {
    const resend = new Resend(ENV.RESEND_API_KEY);
    const res = await withRetry(
      async () => {
        const r = await resend.emails.send({
          from: ENV.RESEND_FROM,
          to: ENV.ORDER_NOTIFY_EMAIL,
          replyTo: snap.email,
          // subject leads with the fulfilment action so digital ($39) vs ship
          // ($79) vs priority ($139) orders are obvious in the inbox.
          subject: `${orderFulfilment(snap).subject} · ${snap.orderNo} · ${shipTo}`,
          html: fulfillmentNotificationHtml(snap, {
            certificates: certLinks,
            portalUrl: `${base}/orders/${snap.id}?token=${snap.token}`,
          }),
          attachments,
        });
        if (r && r.error) throw new Error(r.error.message || 'resend_error');
        return r;
      },
      {
        tries: 3,
        baseDelayMs: 600,
        onError: (err, attempt) =>
          snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', attempt, status: 'retry', error: String(err?.message || err) }),
      }
    );
    snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', status: 'sent', providerId: res?.data?.id || null });
    log.info('owner_email.sent', {
      orderNo: snap.orderNo,
      providerId: res?.data?.id || null,
      attachments: attachments.length,
      packages: (snap.items || []).map((it) => it.pkg).join(','),
      copyPackages: [...OWNER_COPY_PACKAGES].join(',') || 'none',
    });
    return 'sent';
  } catch (err) {
    // Deliberately terminal: the customer already has their certificate and
    // their receipt, so this is logged and never rethrown.
    snap.deliveryLog.push({ ts: Date.now(), stage: 'owner_email', status: 'failed', error: String(err?.message || err) });
    log.error('owner_email.failed', { orderNo: snap.orderNo, attachments: attachments.length, ...errFields(err) });
    return 'failed';
  }
}
