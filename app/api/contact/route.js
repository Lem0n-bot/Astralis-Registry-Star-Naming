/**
 * POST /api/contact
 * Body: { name, email, message }
 * Sends the contact form to the support inbox (help.astralis@gmail.com) via
 * Resend, from the verified sender, with the visitor's address as reply-to.
 * Degrades to a clear error when Resend isn't configured (the client then tells
 * the visitor to email support directly).
 */
import { Resend } from 'resend';
import { ENV, isResendConfigured } from '../../lib/env.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPORT_INBOX = 'help.astralis@gmail.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STR = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const name = STR(body.name, 120);
  const email = STR(body.email, 200).toLowerCase();
  const message = STR(body.message, 4000);
  if (!name || !EMAIL_RE.test(email) || !message) {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  if (!isResendConfigured()) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  try {
    const resend = new Resend(ENV.RESEND_API_KEY);
    const r = await resend.emails.send({
      from: ENV.RESEND_FROM,
      to: SUPPORT_INBOX,
      replyTo: email,
      subject: `Contact form · ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
      html:
        `<p style="margin:0 0 12px"><b>From:</b> ${esc(name)} &lt;${esc(email)}&gt;</p>` +
        `<p style="white-space:pre-wrap;margin:0">${esc(message)}</p>`,
    });
    if (r && r.error) throw new Error(r.error.message || 'send_failed');
    return Response.json({ ok: true });
  } catch (e) {
    console.error('[contact] send failed', e?.message);
    return Response.json({ error: 'send_failed' }, { status: 502 });
  }
}
