/**
 * Astralis — production Next.js configuration for Vercel
 * Domain: astralis.com.au
 *
 * Notes:
 * - SSL certificates are provisioned and renewed automatically by Vercel
 *   (Let's Encrypt) once the domain is added to the project.
 * - Vercel terminates TLS (1.2 / 1.3 only) and redirects HTTP -> HTTPS
 *   at the edge automatically. middleware.js adds a defensive layer.
 */

const securityHeaders = [
  {
    // Enforce HTTPS for 2 years, on all subdomains, eligible for browser preload lists
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(self)',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

// Private surfaces: keep them out of search results and out of shared caches.
const noIndexHeaders = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet' },
  { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // hide X-Powered-By

  // Chromium + puppeteer-core ship a native binary — keep them external so Next
  // does not try to bundle them into the serverless function.
  experimental: {
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
    // @sparticuz/chromium loads its binaries (bin/*.br) via fs at runtime, so
    // Next's file tracing can't see them and they go missing on Vercel — which
    // makes the certificate PDF render (and thus the email attachment) fail.
    // Force them into the certificate-rendering functions.
    outputFileTracingIncludes: {
      '/api/webhooks/stripe': ['./node_modules/@sparticuz/chromium/bin/**'],
      '/api/checkout/order': ['./node_modules/@sparticuz/chromium/bin/**'],
      '/api/orders/[id]/certificate/[certId]': ['./node_modules/@sparticuz/chromium/bin/**'],
      // The manual fulfilment replay renders certificates too — without this it
      // would fail exactly when it is needed most (recovering a paid order).
      '/api/admin/fulfill': ['./node_modules/@sparticuz/chromium/bin/**'],
      // The private admin certificate generator renders with the same pipeline.
      '/api/admin/certificate/generate': ['./node_modules/@sparticuz/chromium/bin/**'],
    },
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // The admin pages are private and must never be indexed or cached by a
        // shared proxy. middleware.js is what actually enforces access; this is
        // the belt to its braces, and covers the 200 responses it lets through.
        source: '/admin/:path*',
        headers: noIndexHeaders,
      },
      {
        source: '/api/admin/:path*',
        headers: noIndexHeaders,
      },
    ];
  },

  async redirects() {
    return [
      // Canonical host: www -> apex (permanent, HTTPS)
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.astralis.com.au' }],
        destination: 'https://astralis.com.au/:path*',
        permanent: true,
      },
    ];
  },

  async rewrites() {
    return {
      // Serve the static Astralis site (public/index.html) at the root URL
      beforeFiles: [{ source: '/', destination: '/index.html' }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
