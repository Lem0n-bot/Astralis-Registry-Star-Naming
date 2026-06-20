/**
 * POST /api/verify-email/send-code
 * Body: { email }
 * Emails a 6-digit code so we can confirm the buyer controls the address used
 * for delivery before they pay. Rate-limited per email (see ../store). The code
 * is generated with a CSPRNG and only ever leaves the server inside the email —
 * it is never logged or returned in the response.
 */
import { randomInt } from 'node:crypto';
import { Resend } from 'resend';
import { canSend, saveCode, normaliseEmail } from '../store';
import { verificationEmailHtml } from '../email-template';

export const runtime = 'nodejs';        // node crypto + the in-memory store
export const dynamic = 'force-dynamic'; // never cache

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FROM = 'Astralis Registry <noreply@astralisregistry.com>';

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const email = normaliseEmail(body && body.email);
  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: 'invalid_email' }, { status: 400 });
  }

  // 60-second per-email rate limit
  const gate = canSend(email);
  if (!gate.ok) {
    return Response.json({ error: 'rate_limited', retryAfter: gate.retryAfter }, { status: 429 });
  }

  // 6 numeric digits, leading zeros preserved, from a CSPRNG (never Math.random)
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  saveCode(email, code);

  // The code only ever leaves the server in the email — never logged, never
  // returned in the response.
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Your Astralis verification code',
      html: verificationEmailHtml(code),
    });
  } catch {
    return Response.json({ error: 'send_failed' }, { status: 502 });
  }

  return Response.json({ ok: true });
}
