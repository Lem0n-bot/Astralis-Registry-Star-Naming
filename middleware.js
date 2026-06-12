import { NextResponse } from 'next/server';

/**
 * Astralis edge middleware
 *
 * Vercel already performs HTTP -> HTTPS redirection and TLS termination
 * (TLS 1.2 / 1.3) at the edge. This middleware is a defensive second
 * layer that also canonicalises the host to the apex domain.
 */
const CANONICAL_HOST = 'astralis.com.au';

export function middleware(req) {
  const url = req.nextUrl.clone();
  const host = req.headers.get('host') || '';
  const proto = req.headers.get('x-forwarded-proto') || 'https';

  // 1. Force HTTPS (defensive; Vercel handles this at the edge too)
  if (proto === 'http') {
    url.protocol = 'https:';
    return NextResponse.redirect(url, 301);
  }

  // 2. Canonical host: www -> apex (skip Vercel preview deployments)
  if (host === `www.${CANONICAL_HOST}`) {
    url.host = CANONICAL_HOST;
    return NextResponse.redirect(url, 301);
  }

  const res = NextResponse.next();

  /**
   * 3. Secure cookie pattern.
   * The Astralis site is currently static and sets no cookies, but when
   * sessions/carts are added, set every cookie like this:
   *
   * res.cookies.set('astralis_session', token, {
   *   httpOnly: true,   // not readable from JS (XSS protection)
   *   secure: true,     // HTTPS only
   *   sameSite: 'lax',  // CSRF protection
   *   path: '/',
   *   maxAge: 60 * 60 * 24 * 7, // 7 days
   * });
   */

  return res;
}

export const config = {
  // Run on everything except Next.js internals and static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)).*)'],
};
