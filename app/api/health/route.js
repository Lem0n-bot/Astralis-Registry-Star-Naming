/**
 * GET /api/health
 * Reports which fulfilment dependencies are configured in THIS environment, so a
 * misconfigured production deploy is visible in one request instead of being
 * discovered through a customer who paid and received nothing.
 *
 * Reports booleans only — never a key, a prefix or a length. Safe to call
 * publicly, though `ready:false` is the signal that matters.
 */
import { ENV, isStripeConfigured, isWebhookConfigured, isResendConfigured, isKvConfigured } from '../../lib/env.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** anhtuanasd35@gmail.com -> anh***@gmail.com — enough to verify, not to harvest. */
function mask(value) {
  const str = String(value || '');
  const m = str.match(/([^\s<>@]+)@([^\s<>]+)/);
  if (!m) return str ? 'set' : null;
  const [, local, domain] = m;
  return `${local.slice(0, 3)}***@${domain}`;
}

export async function GET() {
  const checks = {
    // Payments
    stripeSecret: isStripeConfigured(),
    // Without this the webhook returns 500 and NOTHING is ever fulfilled.
    stripeWebhookSecret: isWebhookConfigured(),
    // Without this there is no receipt email; checkout refuses to start.
    resend: isResendConfigured(),
    resendFrom: !!ENV.RESEND_FROM,
    ownerNotifyEmail: !!ENV.ORDER_NOTIFY_EMAIL,
    // Signs the no-login certificate/portal links. Falls back to a dev secret,
    // which would invalidate every previously issued link on change.
    orderTokenSecret: !!ENV.ORDER_TOKEN_SECRET,
    siteUrl: !!ENV.SITE_URL,
    // Optional: orders also survive via Stripe session metadata (lib/order-codec).
    kv: isKvConfigured(),
  };

  // Everything an order needs to be taken, fulfilled and acknowledged. siteUrl,
  // resendFrom and ownerNotifyEmail are deliberately NOT required — each has a
  // working code default, so demanding them would report a healthy site as down.
  const required = ['stripeSecret', 'stripeWebhookSecret', 'resend', 'orderTokenSecret'];
  const missing = required.filter((k) => !checks[k]);

  return Response.json(
    {
      ready: missing.length === 0,
      missing,
      checks,
      // Orders are recoverable from Stripe metadata even without KV, so this is
      // informational rather than a failure.
      durableStore: checks.kv ? 'vercel-kv' : 'stripe-metadata-fallback',
      // Masked so you can confirm WHICH inbox receives the order copies for
      // printing, without publishing the address.
      ordersCopiedTo: mask(ENV.ORDER_NOTIFY_EMAIL),
      sendingAs: mask(ENV.RESEND_FROM),
    },
    { status: missing.length === 0 ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
