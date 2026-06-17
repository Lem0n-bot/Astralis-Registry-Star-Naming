/**
 * GET /api/orders/:id/certificate/:certId?token=…&format=pdf|png
 * Token-gated certificate download for the email links + the no-login portal.
 * Serves the stored blob; if a blob is missing (e.g. KV size limits / instance
 * recycle), it re-renders the certificate on demand from the locked order data.
 */
import { verifyToken } from '../../../../../lib/ids.js';
import { getOrder as getSnapshot, getBlob } from '../../../../../lib/store.js';
import { renderCertificateBlob } from '../../../../../lib/certificates.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // on-demand re-render fallback uses Chromium

export async function GET(req, { params }) {
  const { id, certId } = params;
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const format = url.searchParams.get('format') === 'png' ? 'png' : 'pdf';

  if (!verifyToken(id, token)) return new Response('Forbidden', { status: 403 });

  const order = await getSnapshot(id);
  if (!order || !order.fulfilled) return new Response('Not found', { status: 404 });
  const entry = (order.certificates || []).find((c) => c.certId === certId);
  if (!entry) return new Response('Not found', { status: 404 });

  let blob = await getBlob(certId, format);
  if (!blob) {
    const item = order.items?.[entry.itemIndex];
    if (item) {
      try {
        blob = await renderCertificateBlob(item, certId, format);
      } catch (e) {
        console.error('[certificate] on-demand re-render failed', certId, e?.message);
      }
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
    },
  });
}
