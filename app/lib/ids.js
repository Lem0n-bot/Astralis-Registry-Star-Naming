/**
 * Identifier + token minting for the order/fulfilment system.
 *
 * - newOrderId / newCertId — collision-resistant ids from a CSPRNG. newCertId is
 *   the human-readable certificate number printed on each PDF (AST-CERT-YYYY-XXXX).
 * - signToken / verifyToken — HMAC-SHA256 tokens that gate the no-login order
 *   portal and certificate downloads. The token IS the only credential (there
 *   are no accounts), so it must be unguessable — set ORDER_TOKEN_SECRET in
 *   production — and is compared in constant time to resist timing attacks.
 */
import crypto from 'node:crypto';
import { ENV } from './env.js';

// Falls back to a derived/dev secret so links work locally; set ORDER_TOKEN_SECRET
// (a long random string) in production so tokens can't be forged.
const TOKEN_SECRET =
  ENV.ORDER_TOKEN_SECRET || ENV.STRIPE_SECRET_KEY || 'astralis-dev-secret-change-me';

export function newOrderId() {
  return 'ord_' + crypto.randomBytes(12).toString('hex');
}

// Unique, human-readable certificate id minted once per star at fulfilment.
export function newCertId() {
  const yr = new Date().getFullYear();
  return `AST-CERT-${yr}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// HMAC token that gates the no-login order portal + certificate downloads.
export function signToken(orderId) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(String(orderId)).digest('hex').slice(0, 32);
}

export function verifyToken(orderId, token) {
  if (!token) return false;
  const a = Buffer.from(signToken(orderId));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
