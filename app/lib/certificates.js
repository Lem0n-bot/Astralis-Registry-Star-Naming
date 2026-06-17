/**
 * Certificate generation. For each purchased star we mint a unique certificate
 * id, render a faithful A4 certificate (PDF + PNG) with Chromium, and persist
 * the record + blobs to the durable store. This replaces the earlier queue stub
 * with real, inline generation invoked from fulfilment.
 */
import { newCertId } from './ids.js';
import { buildCertificateHtml } from './cert-template.js';
import { renderCertificate } from './render.js';
import { putCert, putBlob } from './store.js';

/** Deterministic star-map seed (matches the seed the client captured, else
 *  derives a stable one from the star id so the PDF still looks intentional). */
function seedFor(item) {
  if (Number.isFinite(+item.seed)) return +item.seed % 1000;
  const s = String((item.star && item.star.id) || item.name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1000;
}

/** Map a validated order item to the certificate-template data object. */
export function certDataFor(item, certId) {
  const star = item.star || {};
  return {
    name: item.name,
    msg: item.msg,
    recip: item.recip,
    occ: item.occ,
    ra: star.ra,
    dec: star.dec,
    cons: item.cons || star.cons,
    mag: star.mag,
    sec: star.sec,
    cls: star.cls,
    id: star.id, // registry id
    seed: seedFor(item),
    theme: item.theme === 'ivory' ? 'ivory' : 'midnight',
    certId,
  };
}

/**
 * Generate + persist one certificate for a purchased star.
 * @returns {Promise<object>} the stored certificate record.
 */
export async function generateCertificate(order, item, itemIndex) {
  const certId = newCertId();
  const data = certDataFor(item, certId);
  const { pdf, png } = await renderCertificate(buildCertificateHtml(data));

  await putBlob(certId, 'pdf', pdf);
  if (png) await putBlob(certId, 'png', png);

  const record = {
    certId,
    orderId: order.id,
    orderNo: order.orderNo,
    itemIndex,
    name: item.name,
    recip: item.recip,
    occ: item.occ,
    starId: (item.star && item.star.id) || null,
    cons: item.cons || (item.star && item.star.cons) || null,
    theme: data.theme,
    pkg: item.pkg,
    createdAt: Date.now(),
  };
  await putCert(record);
  return record;
}

/** Re-render a certificate blob on demand (download-route fallback). */
export async function renderCertificateBlob(item, certId, format) {
  const { pdf, png } = await renderCertificate(buildCertificateHtml(certDataFor(item, certId)));
  return format === 'png' ? png : pdf;
}
