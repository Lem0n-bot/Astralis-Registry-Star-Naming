// Centralised environment access. Never throws at import time — callers gate on
// the is*Configured() helpers so missing keys degrade to clear errors, not crashes.
export const ENV = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  // Verified sender (matches the existing verification email). Override per-env.
  RESEND_FROM: process.env.RESEND_FROM || 'Astralis Registry <noreply@astralisregistry.com>',
  ORDER_TOKEN_SECRET: process.env.ORDER_TOKEN_SECRET || '',
  SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || '',
  KV_URL: process.env.KV_REST_API_URL || '',
  KV_TOKEN: process.env.KV_REST_API_TOKEN || '',
  PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '',
};

export const isStripeConfigured = () => !!ENV.STRIPE_SECRET_KEY;
export const isWebhookConfigured = () => !!ENV.STRIPE_WEBHOOK_SECRET;
export const isResendConfigured = () => !!ENV.RESEND_API_KEY;
export const isKvConfigured = () => !!(ENV.KV_URL && ENV.KV_TOKEN);

// Resolve the public origin used to build success / cancel / portal / asset URLs.
export function siteUrl(req) {
  if (ENV.SITE_URL) return ENV.SITE_URL.replace(/\/+$/, '');
  if (req && req.headers) {
    const origin = req.headers.get('origin');
    if (origin) return origin.replace(/\/+$/, '');
    const host = req.headers.get('host');
    if (host) {
      const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
      return `${proto}://${host}`.replace(/\/+$/, '');
    }
  }
  return 'http://localhost:3000';
}
