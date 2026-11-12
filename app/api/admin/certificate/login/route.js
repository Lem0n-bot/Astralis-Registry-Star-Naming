/**
 * POST /api/admin/certificate/login
 * Exchanges ADMIN_SECRET for the signed session cookie that opens
 * /admin/certificate. Accepts the form post from the 401 page in middleware.js.
 *
 * The secret only ever travels in a POST body — never a query string, never a
 * path — so it cannot end up in browser history, a Referer header or an access
 * log. Attempts are rate limited per IP and globally, because a single shared
 * password with no account lockout is otherwise a standing invitation to
 * guessing.
 */
import { NextResponse } from 'next/server';
import { signSession, cookieOptions, isAdminSecretConfigured, ADMIN_COOKIE } from '../../../../lib/admin-session.js';
import { incrWithTtl } from '../../../../lib/store.js';
import { log } from '../../../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Per-IP: 8 attempts per 10 minutes. */
const IP_MAX = 8;
const IP_WINDOW_SEC = 600;
/** Global backstop, so a distributed attempt cannot sidestep the per-IP limit.
 *  Generous enough that one person fumbling their password is never affected. */
const GLOBAL_MAX = 40;
const GLOBAL_WINDOW_SEC = 600;

const clientIp = (req) =>
  (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

/** Back to the 401 login form with a reason code, never a description. */
function back(req, code) {
  const url = new URL('/admin/certificate', req.url);
  if (code) url.searchParams.set('e', code);
  return NextResponse.redirect(url, { status: 303, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req) {
  if (!isAdminSecretConfigured(process.env.ADMIN_SECRET)) {
    log.error('admin_login.not_configured', {});
    return back(req, 'off');
  }

  const ip = clientIp(req);
  const [ipHits, globalHits] = await Promise.all([
    incrWithTtl(`adminlogin:ip:${ip}`, IP_WINDOW_SEC),
    incrWithTtl('adminlogin:global', GLOBAL_WINDOW_SEC),
  ]);
  if (ipHits > IP_MAX || globalHits > GLOBAL_MAX) {
    log.warn('admin_login.rate_limited', { ip, ipHits, globalHits });
    return back(req, 'rate');
  }

  // Accept the form post from the 401 page, or a JSON body.
  let secret = '';
  const type = req.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) {
      secret = String((await req.json())?.secret || '');
    } else {
      secret = String((await req.formData()).get('secret') || '');
    }
  } catch {
    return back(req, 'bad');
  }

  const expected = process.env.ADMIN_SECRET;
  // Length-independent comparison. Not timing-safe in the strict sense, but the
  // rate limit above is what actually bounds guessing here, and the secret is
  // high-entropy rather than a short PIN.
  if (secret.length !== expected.length || secret !== expected) {
    log.warn('admin_login.rejected', { ip, ipHits });
    return back(req, 'bad');
  }

  const session = await signSession(expected);
  if (!session) return back(req, 'off');

  log.info('admin_login.success', { ip, expires: session.expires.toISOString() });
  const res = NextResponse.redirect(new URL('/admin/certificate', req.url), {
    status: 303,
    headers: { 'Cache-Control': 'no-store' },
  });
  res.cookies.set(ADMIN_COOKIE, session.value, cookieOptions(req.headers.get('host'), session.expires));
  return res;
}

/** A GET here is never useful; keep it from looking like an oracle. */
export async function GET() {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
