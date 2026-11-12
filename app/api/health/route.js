/**
 * GET /api/health
 * Reports which fulfilment dependencies are configured in THIS environment, so a
 * misconfigured production deploy is visible in one request instead of being
 * discovered through a customer who paid and received nothing.
 *
 * The durable store is checked for real, not just for env vars. A deleted
 * Upstash database (the free tier drops one after 14 idle days) leaves
 * KV_REST_API_URL and KV_REST_API_TOKEN perfectly intact while every command
 * fails with `getaddrinfo ENOTFOUND`, so `checks.kv` is a live write + read-back
 * via lib/store.js -> pingKv(). `checks.store` separates the two causes:
 * unconfigured vs unreachable.
 *
 * Reports booleans, latencies and a store error string only — never a key, a
 * prefix or a length. Safe to call publicly: the ping is memoised per instance,
 * so this cannot be used to generate load against the store. `ready:false` is
 * the signal that matters.
 */
import {
  ENV,
  isStripeConfigured,
  isWebhookConfigured,
  isResendConfigured,
  isKvConfigured,
  isAdminApiConfigured,
} from '../../lib/env.js';
import { pingKv } from '../../lib/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A cached KV response would make a dead store look alive — the one thing this
// endpoint must never do. lib/store.js additionally makes each ping's commands
// unique so no cache can answer them.
export const fetchCache = 'force-no-store';

/** anhtuanasd35@gmail.com -> anh***@gmail.com — enough to verify, not to harvest. */
function mask(value) {
  const str = String(value || '');
  const m = str.match(/([^\s<>@]+)@([^\s<>]+)/);
  if (!m) return str ? 'set' : null;
  const [, local, domain] = m;
  return `${local.slice(0, 3)}***@${domain}`;
}

export async function GET() {
  // Live round trip. Never throws, and is bounded + memoised inside the store.
  const kv = await pingKv();

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
    // Optional, and TRUE ONLY IF THE STORE ANSWERS. Orders also survive via
    // Stripe session metadata (lib/order-codec), so this is degraded, not down.
    kv: kv.configured && kv.reachable,
    // Keeps the free Upstash database from being deleted for inactivity.
    keepaliveCron: (process.env.CRON_SECRET || '').length >= 16,
    // Optional: enables the manual fulfilment replay at /api/admin/fulfill.
    adminReplay: isAdminApiConfigured(),
  };

  // Everything an order needs to be taken, fulfilled and acknowledged. siteUrl,
  // resendFrom and ownerNotifyEmail are deliberately NOT required — each has a
  // working code default, so demanding them would report a healthy site as down.
  // KV is not required either: fulfilment rebuilds the order from Stripe
  // metadata, renders and emails without it. It is a warning, not an outage.
  const required = ['stripeSecret', 'stripeWebhookSecret', 'resend', 'orderTokenSecret'];
  const missing = required.filter((k) => !checks[k]);

  const warnings = [];
  if (kv.configured && !kv.reachable) warnings.push('kv_unreachable');
  if (kv.configured && !checks.keepaliveCron) warnings.push('keepalive_cron_unconfigured');

  return Response.json(
    {
      ready: missing.length === 0,
      // True when orders still complete but something needs attention — today
      // that means certificate links and the no-login portal are not durable.
      degraded: warnings.length > 0,
      missing,
      warnings,
      checks,
      // Which of "no store configured" and "store not answering" is the case,
      // with the round-trip latency. `error` is the store's own message.
      store: {
        configured: kv.configured,
        reachable: kv.reachable,
        latencyMs: kv.latencyMs ?? null,
        error: kv.error || null,
        ...(kv.cached ? { cached: true } : {}),
        ...(kv.breakerOpen ? { breakerOpen: true } : {}),
      },
      // Orders are recoverable from Stripe metadata even without KV, so an
      // unreachable store changes which path is load-bearing, not whether the
      // site can sell.
      durableStore: checks.kv
        ? 'vercel-kv'
        : isKvConfigured()
          ? 'stripe-metadata-fallback (kv unreachable)'
          : 'stripe-metadata-fallback',
      // Which path fulfils an order, and the render budget it works inside.
      // Certificate rendering is deliberately bounded so the confirmation email
      // always goes out within the function's maxDuration.
      fulfilment: {
        path: checks.stripeWebhookSecret ? 'stripe-webhook' : 'success-page-fallback',
        renderBudgetMs: Number(process.env.CERT_RENDER_BUDGET_MS || 34000),
        perCertificateTimeoutMs: Number(process.env.CERT_RENDER_TIMEOUT_MS || 22000),
      },
      // Masked so you can confirm WHICH inbox receives the order copies for
      // printing, without publishing the address.
      ordersCopiedTo: mask(ENV.ORDER_NOTIFY_EMAIL),
      sendingAs: mask(ENV.RESEND_FROM),
    },
    { status: missing.length === 0 ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
