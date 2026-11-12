/**
 * POST /api/verify-email/check-code
 * Body: { email, code }
 * Verifies a code previously emailed by send-code, consuming one of the five
 * attempts allowed against it. On success the code is burned and a 30-minute
 * verification marker is written to the store.
 *
 * That marker is the point of this route: /api/checkout/create-session re-reads
 * it server-side before opening a Stripe session, so this is an authorisation
 * boundary and not only a UX gate. (The price and the order are still validated
 * independently at checkout — the client never sends amounts.)
 *
 * The per-code attempt limit bounds guessing at one code; the per-IP limit below
 * bounds an attacker cycling addresses to get fresh codes to guess at.
 */
import { incrWithTtl } from '../../../lib/store.js';
import { log } from '../../../lib/log.js';
import { checkCode, normaliseEmail, MAX_ATTEMPTS } from '../store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // never cache
export const fetchCache = 'force-no-store';

/** Per-IP: 40 guesses per 10 minutes, across however many addresses. */
const IP_MAX = 40;
const IP_WINDOW_SEC = 600;

const clientIp = (req) =>
  (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const email = normaliseEmail(body && body.email);
  // Strip whitespace — people paste codes with spaces.
  const code = String((body && body.code) || '').replace(/\s+/g, '');
  if (!email || !code) {
    return Response.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const ip = clientIp(req);
  const ipHits = await incrWithTtl(`verifycheck:ip:${ip}`, IP_WINDOW_SEC);
  if (ipHits > IP_MAX) {
    log.warn('verify.check_rate_limited', { ip, ipHits });
    return Response.json({ ok: false, error: 'too_many_attempts' }, { status: 429 });
  }

  const res = await checkCode(email, code);
  if (res.ok) {
    log.info('verify.code_accepted', { email });
    return Response.json({ ok: true });
  }

  switch (res.reason) {
    case 'too_many':
      log.warn('verify.code_attempts_exhausted', { email, maxAttempts: MAX_ATTEMPTS });
      return Response.json({ ok: false, error: 'too_many_attempts' }, { status: 429 });
    case 'no_code':
      // An expired code is indistinguishable from one that was never sent — the
      // store's TTL is the expiry — and both are fixed by asking for another.
      return Response.json({ ok: false, error: 'no_code' }, { status: 404 });
    case 'store_unavailable':
      log.error('verify.check_unavailable', { email });
      return Response.json({ ok: false, error: 'verification_unavailable' }, { status: 503 });
    default:
      return Response.json({ ok: false, error: 'mismatch', attemptsRemaining: res.attemptsRemaining });
  }
}
