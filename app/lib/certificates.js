/**
 * Certificate generation.
 *
 * Split deliberately into two phases, because the Chromium render is the one
 * step that can exceed the serverless time budget:
 *
 *   1. mintCertificate()   — cheap, synchronous-ish: allocate the certificate id
 *                            and persist its record. ALWAYS runs for every
 *                            purchased star, so the order snapshot, the email
 *                            links and the no-login portal are complete even if
 *                            nothing renders.
 *   2. renderCertificate() — expensive: headless Chromium -> PDF + PNG. Runs
 *                            best-effort under a time budget. The PDF buffer is
 *                            returned to the caller so the confirmation email can
 *                            attach it directly, and is cached in the durable
 *                            store only as a convenience for later downloads.
 *
 * A certificate with no stored blob is NOT a lost certificate: the download
 * route re-renders it on demand from the locked order data, and the client-side
 * viewer draws it without Chromium at all.
 */
import { newCertId } from './ids.js';
import { buildCertificateHtml } from './cert-template.js';
import { renderCertificate as renderWithChromium } from './render.js';
import { putCert, putBlob } from './store.js';
import { log, errFields, now, since } from './log.js';

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

/** Build the certificate record for a purchased star. No rendering. */
export function certificateRecord(order, item, itemIndex, certId = newCertId()) {
  return {
    certId,
    orderId: order.id,
    orderNo: order.orderNo,
    itemIndex,
    name: item.name,
    recip: item.recip,
    occ: item.occ,
    starId: (item.star && item.star.id) || null,
    cons: item.cons || (item.star && item.star.cons) || null,
    theme: item.theme === 'ivory' ? 'ivory' : 'midnight',
    pkg: item.pkg,
    createdAt: Date.now(),
  };
}

/**
 * Phase 1 — allocate + persist the certificate record. Cheap and must not block
 * fulfilment: a failure to cache the record still returns it, because the order
 * snapshot (written by the caller) is the real source of truth.
 * @returns {Promise<object>} the certificate record.
 */
export async function mintCertificate(order, item, itemIndex, certId) {
  const record = certificateRecord(order, item, itemIndex, certId);
  try {
    await putCert(record);
  } catch (err) {
    log.warn('cert.record_persist_failed', { orderNo: order.orderNo, certId: record.certId, ...errFields(err) });
  }
  return record;
}

/**
 * Phase 2 — render the certificate and cache the blobs. Returns the PDF buffer so
 * the caller can attach it to the confirmation email without a store round-trip
 * (the base64 PDF exceeds Vercel KV's per-value limit, so reading it back often
 * yields nothing).
 * @returns {Promise<{certId:string, pdf:Buffer|null, png:Buffer|null, ms:number}>}
 */
export async function renderAndStoreCertificate(item, certId, { orderNo } = {}) {
  const t0 = now();
  const { pdf, png } = await renderWithChromium(buildCertificateHtml(certDataFor(item, certId)));
  const renderMs = since(t0);

  // Caching is best-effort — never let a store failure discard a good render.
  await putBlob(certId, 'pdf', pdf).catch((err) =>
    log.warn('cert.blob_cache_failed', { orderNo, certId, format: 'pdf', ...errFields(err) })
  );
  if (png) {
    await putBlob(certId, 'png', png).catch((err) =>
      log.warn('cert.blob_cache_failed', { orderNo, certId, format: 'png', ...errFields(err) })
    );
  }

  log.info('cert.rendered', {
    orderNo,
    certId,
    renderMs,
    totalMs: since(t0),
    pdfBytes: pdf ? pdf.length : 0,
    pngBytes: png ? png.length : 0,
  });

  return { certId, pdf: pdf || null, png: png || null, ms: since(t0) };
}

/** Re-render a certificate blob on demand (download-route fallback). */
export async function renderCertificateBlob(item, certId, format) {
  const { pdf, png } = await renderWithChromium(buildCertificateHtml(certDataFor(item, certId)));
  return format === 'png' ? png : pdf;
}
