/**
 * GET /api/orders/:id/certificate/:certId?token=…&format=pdf|png
 * Token-gated certificate download for the email links + the no-login portal.
 * Serves the cached blob; if a blob is missing it re-renders the certificate on
 * demand from the locked order data.
 *
 * The on-demand render is load-bearing, not a nicety: a base64 certificate PDF
 * is larger than Vercel KV's per-value limit, and fulfilment deliberately
 * renders only as many certificates as fit in its time budget. So a certificate
 * with no cached blob is normal, and this route is what makes its link work.
 */
import { verifyToken } from '../../../../../lib/ids.js';
import { getOrder as getSnapshot, getBlob } from '../../../../../lib/store.js';
import { renderCertificateBlob } from '../../../../../lib/certificates.js';
import { withTimeout } from '../../../../../lib/retry.js';
import { log, errFields, now, since } from '../../../../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // on-demand re-render fallback uses Chromium

// Leaves room inside maxDuration to still answer with a clean error instead of
// a platform timeout the customer sees as a dead link.
const RENDER_TIMEOUT_MS = Number(process.env.CERT_DOWNLOAD_RENDER_TIMEOUT_MS || 45_000);

export async function GET(req, { params }) {
  const { id, certId } = params;
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const format = url.searchParams.get('format') === 'png' ? 'png' : 'pdf';

  if (!verifyToken(id, token)) {
    log.warn('download.forbidden', { orderId: id, certId, format });
    return new Response('Forbidden', { status: 403 });
  }

  const order = await getSnapshot(id);
  if (!order || !order.fulfilled) {
    log.warn('download.order_unavailable', { orderId: id, certId, hasSnapshot: !!order, fulfilled: !!order?.fulfilled });
    return new Response('Not found', { status: 404 });
  }
  const entry = (order.certificates || []).find((c) => c.certId === certId);
  if (!entry) {
    log.warn('download.cert_not_in_order', { orderId: id, orderNo: order.orderNo, certId });
    return new Response('Not found', { status: 404 });
  }

  let blob = await getBlob(certId, format);
  let renderedNow = false;
  if (!blob) {
    const item = order.items?.[entry.itemIndex];
    if (item) {
      const t0 = now();
      try {
        blob = await withTimeout(renderCertificateBlob(item, certId, format), RENDER_TIMEOUT_MS, 'cert_render');
        renderedNow = true;
        log.info('download.rendered_on_demand', { orderNo: order.orderNo, certId, format, ms: since(t0) });
      } catch (err) {
        log.error('download.render_failed', { orderNo: order.orderNo, certId, format, ms: since(t0), ...errFields(err) });
      }
    } else {
      log.error('download.item_missing', { orderNo: order.orderNo, certId, itemIndex: entry.itemIndex });
    }
  }
  if (!blob) return new Response('Certificate unavailable', { status: 404 });

  const contentType = format === 'png' ? 'image/png' : 'application/pdf';
  const disposition = format === 'png' ? 'inline' : 'attachment';
  return new Response(new Uint8Array(blob), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="Astralis-Certificate-${certId}.${format}"`,
      'Cache-Control': 'private, max-age=86400',
      'X-Astralis-Render': renderedNow ? 'on-demand' : 'cached',
    },
  });
}
