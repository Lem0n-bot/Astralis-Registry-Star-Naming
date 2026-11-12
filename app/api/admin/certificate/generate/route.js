/**
 * POST /api/admin/certificate/generate
 * Renders a certificate from hand-entered details and returns the PDF, with no
 * Stripe session and no charge. Optionally emails it to an address.
 *
 * Reuses the exact production pipeline — lib/cert-template.js then
 * lib/render.js — so what comes out of here is byte-for-byte the kind of file a
 * paying customer receives. Nothing about the certificate is special-cased.
 *
 * Gated by the admin session cookie in middleware.js; the check is repeated here
 * so the endpoint is never reachable on its own if that matcher ever changes.
 *
 * GET /api/admin/certificate/generate?star_id=AST-660055 resolves star details
 * for the form's auto-fill.
 */
import { buildCertificateHtml } from '../../../../lib/cert-template.js';
import { renderCertificate } from '../../../../lib/render.js';
import { starFromId } from '../../../../lib/star-catalog.js';
import { newCertId } from '../../../../lib/ids.js';
import { verifySession, ADMIN_COOKIE } from '../../../../lib/admin-session.js';
import { withTimeout } from '../../../../lib/retry.js';
import { ENV, isResendConfigured } from '../../../../lib/env.js';
import { orderConfirmationHtml } from '../../../../lib/order-email.js';
import { log, errFields, now, since } from '../../../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RENDER_TIMEOUT_MS = Number(process.env.CERT_DOWNLOAD_RENDER_TIMEOUT_MS || 45_000);
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STR = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** Field limits mirror the live personalisation form in public/index.html. */
function certInputFrom(body) {
  const star = {
    id: STR(body.starId, 30),
    ra: STR(body.ra, 30),
    dec: STR(body.dec, 30),
    cons: STR(body.cons, 40),
    mag: STR(body.mag, 20),
    sec: STR(body.sec, 40),
    cls: STR(body.cls, 40),
  };
  return {
    name: STR(body.name, 28),
    recip: STR(body.recip, 40),
    occ: STR(body.occ, 40),
    msg: STR(body.msg, 120),
    theme: body.theme === 'ivory' ? 'ivory' : 'midnight',
    seed: Number.isFinite(+body.seed) ? ((Math.floor(+body.seed) % 1000) + 1000) % 1000 : null,
    star,
  };
}

async function authorised(req) {
  return verifySession(req.cookies?.get?.(ADMIN_COOKIE)?.value ?? readCookie(req, ADMIN_COOKIE));
}

/** Route handlers get a plain Request, so parse the cookie header directly. */
function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/** Star auto-fill for the form. */
export async function GET(req) {
  if (!(await authorised(req))) return Response.json({ error: 'unauthorised' }, { status: 401, headers: NO_STORE });

  const starId = new URL(req.url).searchParams.get('star_id');
  const star = starFromId(starId);
  if (!star) return Response.json({ error: 'unknown_star' }, { status: 404, headers: NO_STORE });
  return Response.json({ star }, { headers: NO_STORE });
}

export async function POST(req) {
  if (!(await authorised(req))) return Response.json({ error: 'unauthorised' }, { status: 401, headers: NO_STORE });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE });
  }

  const input = certInputFrom(body);
  if (!input.name) return Response.json({ error: 'missing_star_name' }, { status: 400, headers: NO_STORE });

  const emailTo = STR(body.emailTo, 200).toLowerCase();
  const wantsEmail = !!body.sendEmail;
  if (wantsEmail && !EMAIL_RE.test(emailTo)) {
    return Response.json({ error: 'invalid_email' }, { status: 400, headers: NO_STORE });
  }
  if (wantsEmail && !isResendConfigured()) {
    return Response.json({ error: 'email_not_configured' }, { status: 503, headers: NO_STORE });
  }

  const certId = newCertId();
  const t0 = now();
  let pdf;
  try {
    const out = await withTimeout(
      renderCertificate(
        buildCertificateHtml({
          name: input.name,
          msg: input.msg,
          recip: input.recip,
          occ: input.occ,
          ra: input.star.ra,
          dec: input.star.dec,
          cons: input.star.cons,
          mag: input.star.mag,
          sec: input.star.sec,
          cls: input.star.cls,
          id: input.star.id,
          seed: input.seed,
          theme: input.theme,
          certId,
        })
      ),
      RENDER_TIMEOUT_MS,
      'cert_render'
    );
    pdf = out.pdf;
  } catch (err) {
    log.error('admin_cert.render_failed', { certId, theme: input.theme, ms: since(t0), ...errFields(err) });
    return Response.json({ error: 'render_failed' }, { status: 500, headers: NO_STORE });
  }

  // Traceability without a store write: an orphan certificate record with no
  // order would just be litter, but the log line lets support answer "which
  // certificate did I send them?" months later.
  log.info('admin_cert.generated', {
    certId,
    starName: input.name,
    starId: input.star.id || null,
    theme: input.theme,
    pdfBytes: pdf.length,
    ms: since(t0),
    emailed: wantsEmail ? emailTo : null,
  });

  if (wantsEmail) {
    const sent = await emailCertificate({ certId, input, pdf, to: emailTo });
    // The PDF is the deliverable; report an email failure without withholding it.
    return Response.json(
      { ok: true, certId, emailStatus: sent.status, ...(sent.error ? { emailError: sent.error } : {}) },
      { status: sent.status === 'sent' ? 200 : 502, headers: NO_STORE }
    );
  }

  const filename = `Astralis-Certificate-${certId}.pdf`;
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Astralis-Cert-Id': certId,
    },
  });
}

/**
 * Send the certificate with the customer confirmation template, in its `manual`
 * mode — the normal one is a receipt (order number, line prices, "Total paid",
 * order portal), none of which exists for a certificate issued by hand.
 */
async function emailCertificate({ certId, input, pdf, to }) {
  const { Resend } = await import('resend');
  const order = {
    orderNo: null,
    email: to,
    items: [
      {
        name: input.name,
        pkg: 'standard',
        priceCents: 0,
        theme: input.theme,
        cons: input.star.cons,
        recip: input.recip,
        star: input.star,
      },
    ],
    totalCents: 0,
    currency: 'aud',
  };

  try {
    const resend = new Resend(ENV.RESEND_API_KEY);
    const r = await resend.emails.send({
      from: ENV.RESEND_FROM,
      to,
      subject: `Your Astralis certificate is ready`,
      html: orderConfirmationHtml(order, {
        certificates: [{ certId, name: input.name }],
        manual: true,
      }),
      attachments: [{ filename: `Astralis-Certificate-${certId}.pdf`, content: Buffer.from(pdf).toString('base64') }],
    });
    if (r && r.error) throw new Error(r.error.message || 'resend_error');
    log.info('admin_cert.emailed', { certId, to, providerId: r?.data?.id || null });
    return { status: 'sent' };
  } catch (err) {
    log.error('admin_cert.email_failed', { certId, to, ...errFields(err) });
    return { status: 'failed', error: String(err?.message || err) };
  }
}
