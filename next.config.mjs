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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // hide X-Powered-By

  // Chromium + puppeteer-core ship a native binary — keep them external so Next
  // does not try to bundle them into the serverless function.
  experimental: {
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
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
