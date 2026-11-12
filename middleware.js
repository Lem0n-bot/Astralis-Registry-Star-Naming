import { NextResponse } from 'next/server';
import { ADMIN_COOKIE, verifySession, isAdminSecretConfigured } from './app/lib/admin-session.js';

/**
 * Astralis edge middleware
 *
 * Vercel already performs HTTP -> HTTPS redirection and TLS termination
 * (TLS 1.2 / 1.3) at the edge. This middleware is a defensive second
 * layer that also canonicalises the host to the apex domain, and it is where
 * the private admin pages are gated.
 */
const CANONICAL_HOST = 'astralis.com.au';

/**
 * Paths behind the admin cookie. Deliberately NOT all of /api/admin:
 * /api/admin/fulfill authenticates with the ADMIN_API_TOKEN bearer header so it
 * can be driven from curl during an incident, and a cookie check there would
 * break it.
 */
const COOKIE_GATED = [/^\/admin(?:\/|$)/, /^\/api\/admin\/certificate(?:\/|$)/];
const isGated = (pathname) => COOKIE_GATED.some((re) => re.test(pathname));

/**
 * The 401 body. Carries nothing but a password field — no admin markup, no
 * field names, no hint that a certificate generator is behind it — so an
 * unauthenticated visitor learns only that something here needs a password.
 */
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Astralis</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100svh;display:grid;place-items:center;background:#05070F;
    font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#F2ECDD}
  form{width:min(320px,calc(100vw - 32px));text-align:center}
  .b{font:600 22px/1 Georgia,serif;letter-spacing:2px;color:#D9B96C;margin-bottom:22px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;margin:0 0 10px;border-radius:10px;
    border:1px solid rgba(217,185,108,.3);background:rgba(255,255,255,.04);color:#F2ECDD;font-size:15px}
  button{width:100%;padding:12px;border:0;border-radius:999px;font-size:15px;font-weight:600;
    color:#1a1405;background:linear-gradient(135deg,#F2DCA2,#D9B96C);cursor:pointer}
  p{min-height:1.2em;margin:12px 0 0;font-size:13px;color:#E4807A}
</style></head><body>
<form method="post" action="/api/admin/certificate/login">
  <div class="b">ASTRALIS</div>
  <input type="password" name="secret" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Continue</button>
  <p id="e"></p>
</form>
<script>
  var q = new URLSearchParams(location.search);
  var m = { bad: 'Incorrect password.', rate: 'Too many attempts. Try again later.', off: 'Not configured.' };
  if (q.get('e') && m[q.get('e')]) document.getElementById('e').textContent = m[q.get('e')];
</script>
</body></html>`;

const unauthorised = () =>
  new NextResponse(LOGIN_PAGE, {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });

export async function middleware(req) {
  const url = req.nextUrl.clone();
  const host = req.headers.get('host') || '';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

  // 1. Force HTTPS (defensive; Vercel handles this at the edge too). Never
  //    locally: a dev server has no TLS listener, so redirecting there makes
  //    every local request unreachable (and a 301 on a POST would drop the
  //    request body).
  if (!isLocal && proto === 'http') {
    url.protocol = 'https:';
    return NextResponse.redirect(url, 301);
  }

  // 2. Canonical host: www -> apex (skip Vercel preview deployments)
  if (host === `www.${CANONICAL_HOST}`) {
    url.host = CANONICAL_HOST;
    return NextResponse.redirect(url, 301);
  }

  // 3. Admin gate. Runs before the page is rendered, so an unauthenticated
  //    request never receives any part of the admin UI — only a 401 and a bare
  //    password form. The login endpoint itself must stay reachable.
  const { pathname } = req.nextUrl;
  if (isGated(pathname) && pathname !== '/api/admin/certificate/login') {
    if (!isAdminSecretConfigured(process.env.ADMIN_SECRET)) return unauthorised();
    if (!(await verifySession(req.cookies.get(ADMIN_COOKIE)?.value))) return unauthorised();
  }

  const res = NextResponse.next();

  /**
   * 4. Secure cookie pattern.
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
   *
   * See app/lib/admin-session.js for the live example.
   */

  return res;
}

export const config = {
  // Run on everything except Next.js internals and static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)).*)'],
};
