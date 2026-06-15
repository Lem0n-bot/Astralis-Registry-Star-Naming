/**
 * Stripe client factory.
 *
 * Required env vars (server-side only — never exposed to the browser):
 *   STRIPE_SECRET_KEY       sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET   whsec_…   (for /api/webhooks/stripe)
 *   RESEND_API_KEY          for the confirmation email
 *   NEXT_PUBLIC_SITE_URL    optional fallback origin for success/cancel URLs
 * STRIPE_PUBLISHABLE_KEY is not needed: hosted Checkout redirects via the
 * session URL, so no Stripe.js (and no key) runs in the browser.
 *
 * Prices + order validation live in ./catalog (no SDK import, unit-testable).
 */
import Stripe from 'stripe';

let _stripe;
/** @returns {Stripe} */
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
