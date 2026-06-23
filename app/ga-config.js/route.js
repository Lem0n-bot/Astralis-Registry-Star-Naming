/**
 * GET /ga-config.js
 * Tiny runtime config shim for the STATIC marketing page (public/index.html),
 * which Next.js serves verbatim and therefore cannot have env vars inlined into.
 * It publishes the (non-secret) GA4 Measurement ID as `window.__GA4_ID__` so the
 * consent layer can read it at runtime — keeping the ID out of source and fully
 * env-driven (Vercel → NEXT_PUBLIC_GA4_ID). When the env var is unset this emits
 * an empty string, so analytics simply never loads. The React routes (e.g. the
 * checkout success page) read process.env.NEXT_PUBLIC_GA4_ID directly instead, so
 * the single source of truth is the env var, delivered the right way per page.
 */
export const dynamic = 'force-dynamic'; // read the env at request time, not build time

export function GET() {
  const id = process.env.NEXT_PUBLIC_GA4_ID || '';
  return new Response(`window.__GA4_ID__=${JSON.stringify(id)};`, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300', // 5 min; ID changes ~never
    },
  });
}
