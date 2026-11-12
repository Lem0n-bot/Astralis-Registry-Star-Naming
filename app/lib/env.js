// Centralised environment access. Never throws at import time — callers gate on
// the is*Configured() helpers so missing keys degrade to clear errors, not crashes.
export const ENV = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  // Verified sender (matches the existing verification email). Override per-env.
  RESEND_FROM: process.env.RESEND_FROM || 'Astralis Registry <noreply@astralisregistry.com>',
  // Internal recipient for "new order" fulfilment notifications (name, phone,
  // address + items) so the owner can ship via AusPost. Override per-env.
  // OWNER_EMAIL is the current name; ORDER_NOTIFY_EMAIL is kept as a fallback so
  // notifications never go dark between setting the new var and deploying.
  ORDER_NOTIFY_EMAIL: process.env.OWNER_EMAIL || process.env.ORDER_NOTIFY_EMAIL || 'anhtuanasd35@gmail.com',
  ORDER_TOKEN_SECRET: process.env.ORDER_TOKEN_SECRET || '',
  // Gates POST /api/admin/fulfill, the manual fulfilment replay for an order
  // that was charged but never delivered. Unset = route disabled (404).
  ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || '',
  // Password for the private certificate generator at /admin/certificate. Kept
  // separate from ADMIN_API_TOKEN on purpose: that one is a machine bearer token
  // for curl, this one is typed into a browser form by a human.
  ADMIN_SECRET: process.env.ADMIN_SECRET || '',
  SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || '',
  KV_URL: process.env.KV_REST_API_URL || '',
  KV_TOKEN: process.env.KV_REST_API_TOKEN || '',
  PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '',
};

export const isStripeConfigured = () => !!ENV.STRIPE_SECRET_KEY;
export const isWebhookConfigured = () => !!ENV.STRIPE_WEBHOOK_SECRET;
export const isResendConfigured = () => !!ENV.RESEND_API_KEY;
export const isKvConfigured = () => !!(ENV.KV_URL && ENV.KV_TOKEN);

/**
 * Which packages get the rendered certificate PDF attached to the owner's copy
 * of an order. The owner is emailed about EVERY order regardless — that is how
 * a Premium/Ultimate order awaiting postage gets noticed — so this controls the
 * attachment only, not whether the email is sent. Comma-separated; `none`
 * disables attachments entirely.
 */
export const OWNER_COPY_PACKAGES = new Set(
  (process.env.OWNER_COPY_PACKAGES ?? 'standard,premium,ultimate')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p !== 'none')
);
/** True when this order should carry PDFs to the owner. */
export const ownerCopyWanted = (items = []) => items.some((it) => OWNER_COPY_PACKAGES.has(it.pkg));
// Short tokens are treated as unconfigured: this endpoint can email customers.
export const isAdminApiConfigured = () => ENV.ADMIN_API_TOKEN.length >= 24;

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
