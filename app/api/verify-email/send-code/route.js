/**
 * POST /api/verify-email/send-code
 * Body: { email }
 * Emails a 6-digit code so we can confirm the buyer controls the address the
 * certificates will be delivered to, before they pay.
 *
 * The code is generated with a CSPRNG, stored only as a salted hash, and leaves
 * the server exactly once — inside the email. It is never logged, never returned
 * in a response, and not recoverable from the store.
 *
 * Three limits, in order of how specific they are: a 60-second claim per address
 * (atomic, in ../store), then per-IP and global ceilings, because an endpoint
 * that sends email to an arbitrary address on an unauthenticated POST is
 * otherwise a spam relay pointed at our own sending reputation.
 */
import { randomInt } from 'node:crypto';
import { Resend } from 'resend';
import { ENV, isResendConfigured } from '../../../lib/env.js';
import { incrWithTtl } from '../../../lib/store.js';
import { log, errFields } from '../../../lib/log.js';
import {
  beginSend,
  releaseSend,
  saveCode,
  normaliseEmail,
  isVerificationStoreReady,
  RESEND_COOLDOWN_SEC,
} from '../store';
import { verificationEmailHtml } from '../email-template';

export const runtime = 'nodejs'; // node:crypto
export const dynamic = 'force-dynamic'; // never cache
// Belt to the braces of the unique-key probes in lib/store.js: a framework-cached
// fetch must never answer a store command on this path.
export const fetchCache = 'force-no-store';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Per-IP: 12 codes per 10 minutes — far above one buyer mistyping an address. */
const IP_MAX = 12;
const IP_WINDOW_SEC = 600;
/** Global backstop so a distributed run cannot sidestep the per-IP ceiling. */
const GLOBAL_MAX = 300;
const GLOBAL_WINDOW_SEC = 600;

const clientIp = (req) =>
  (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

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

  // No mail provider means no code can arrive. Say so instead of claiming a
  // cooldown and leaving the buyer watching an inbox.
  if (!isResendConfigured()) {
    log.error('verify.send_refused', { reason: 'resend_not_configured', email });
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  // No shared store means no verification: a code written here would be
  // invisible to check-code on the next instance. Refuse before the buyer waits
  // on an inbox. (/api/health reports the same fact as `checks.emailVerification`.)
  if (!isVerificationStoreReady()) {
    log.error('verify.send_refused', { reason: 'store_not_configured', email });
    return Response.json({ error: 'verification_unavailable' }, { status: 503 });
  }

  const ip = clientIp(req);
  const [ipHits, globalHits] = await Promise.all([
    incrWithTtl(`verifysend:ip:${ip}`, IP_WINDOW_SEC),
    incrWithTtl('verifysend:global', GLOBAL_WINDOW_SEC),
  ]);
  if (ipHits > IP_MAX || globalHits > GLOBAL_MAX) {
    log.warn('verify.send_rate_limited', { scope: ipHits > IP_MAX ? 'ip' : 'global', ip, ipHits, globalHits });
    return Response.json({ error: 'rate_limited', retryAfter: IP_WINDOW_SEC }, { status: 429 });
  }

  // The 60-second per-address claim. Atomic, and KV-backed, so it holds across
  // serverless instances rather than only the one that happens to answer.
  const gate = await beginSend(email);
  if (!gate.ok) {
    if (gate.reason === 'rate_limited') {
      return Response.json({ error: 'rate_limited', retryAfter: gate.retryAfter }, { status: 429 });
    }
    // The store is configured and did not answer. A code saved now would be
    // invisible to check-code, so refuse rather than send one that cannot work.
    log.error('verify.send_refused', { reason: 'store_unavailable', email });
    return Response.json({ error: 'verification_unavailable' }, { status: 503 });
  }

  // 6 numeric digits, leading zeros preserved, from a CSPRNG (never Math.random).
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

  const saved = await saveCode(email, code);
  if (!saved.ok) {
    await releaseSend(email);
    log.error('verify.send_refused', { reason: 'code_persist_failed', email });
    return Response.json({ error: 'verification_unavailable' }, { status: 503 });
  }

  try {
    const resend = new Resend(ENV.RESEND_API_KEY);
    // Resend answers with { error } rather than throwing, so an unverified
    // sender or a rejected address reads as success unless this is checked.
    const r = await resend.emails.send({
      from: ENV.RESEND_FROM,
      to: email,
      subject: 'Your Astralis verification code',
      html: verificationEmailHtml(code),
    });
    if (r && r.error) throw new Error(r.error.message || 'resend_error');
    log.info('verify.code_sent', { email, providerId: r?.data?.id || null, durable: saved.durable });
  } catch (err) {
    // Hand the cooldown back: the send failed on our side, so the buyer should
    // be able to retry immediately rather than wait out a minute.
    await releaseSend(email);
    log.error('verify.send_failed', { email, ...errFields(err) });
    return Response.json({ error: 'send_failed' }, { status: 502 });
  }

  // Nothing about the code itself — only how long until another may be asked for.
  return Response.json({ ok: true, resendIn: RESEND_COOLDOWN_SEC });
}
