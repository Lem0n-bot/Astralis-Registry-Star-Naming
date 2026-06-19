/**
 * GET /api/orders/:id/data?token=…
 * Returns the per-certificate personalisation data for an order (no rendered
 * blob needed) so the certificate can be drawn CLIENT-SIDE in the browser — the
 * same way the homepage preview is drawn. This works even when the server-side
 * (Chromium) PDF render is unavailable. Token-gated; never returns secrets.
 * (Cert data is mapped inline here so this route stays lean — no render stack.)
 */
import { verifyToken } from '../../../../lib/ids.js';
import { getOrder as getSnapshot } from '../../../../lib/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// deterministic star-map seed (mirrors certDataFor in lib/certificates.js)
function seedFor(item) {
  if (Number.isFinite(+item.seed)) return ((Math.floor(+item.seed) % 1000) + 1000) % 1000;
  const s = String((item.star && item.star.id) || item.name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1000;
}
function certDataFor(item, certId) {
  const star = item.star || {};
  return {
    name: item.name, msg: item.msg, recip: item.recip, occ: item.occ,
    ra: star.ra, dec: star.dec, cons: item.cons || star.cons, mag: star.mag,
    sec: star.sec, cls: star.cls, id: star.id, seed: seedFor(item),
    theme: item.theme === 'ivory' ? 'ivory' : 'midnight', certId,
  };
}

export async function GET(req, { params }) {
  const { id } = params;
  const token = new URL(req.url).searchParams.get('token');
  if (!verifyToken(id, token)) return Response.json({ error: 'forbidden' }, { status: 403 });

  const order = await getSnapshot(id);
  if (!order) return Response.json({ error: 'not_found' }, { status: 404 });

  const items = order.items || [];
  const entries = order.certificates && order.certificates.length
    ? order.certificates
    : items.map((_, i) => ({ itemIndex: i, certId: null }));

  const certs = entries.map((c) => {
    const item = items[c.itemIndex] || {};
    return {
      certId: c.certId || null,
      theme: item.theme === 'ivory' ? 'ivory' : 'midnight',
      name: item.name || '',
      // high-res PDF via the existing render route (works when server render is available)
      pdfUrl: c.certId && token ? `/api/orders/${id}/certificate/${c.certId}?format=pdf&token=${encodeURIComponent(token)}` : null,
      data: certDataFor(item, c.certId || ''),
    };
  });

  return Response.json({ orderNo: order.orderNo, email: order.email || null, certs });
}
