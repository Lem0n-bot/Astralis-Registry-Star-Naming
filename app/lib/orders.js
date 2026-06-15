/**
 * Orders + star-claims store.
 *
 * TODO: This is an in-memory store (Maps on globalThis). It is fine for a soft
 * launch but is NOT durable — orders and claims are lost when a serverless
 * instance recycles, and are not shared across instances. Before scaling, move
 * this to Vercel KV / Postgres. The fulfilment path is written to be idempotent
 * so swapping the storage layer is the only change needed.
 */
import { randomUUID, randomInt } from 'node:crypto';

const orders = globalThis.__astralisOrders || (globalThis.__astralisOrders = new Map());
const bySession = globalThis.__astralisOrderBySession || (globalThis.__astralisOrderBySession = new Map());
const claims = globalThis.__astralisClaims || (globalThis.__astralisClaims = new Map());

function orderNumber() {
  return 'AST-ORD-' + String(randomInt(10000, 99999));
}

/**
 * Create a pending order from a validated payload.
 * @param {{email:string,items:object[],delivery:object,totalCents:number,currency:string}} data
 */
export function createOrder(data) {
  const id = randomUUID();
  const order = {
    id,
    orderNo: orderNumber(),
    status: 'pending', // pending -> paid
    createdAt: Date.now(),
    paidAt: null,
    email: data.email,
    items: data.items,
    delivery: data.delivery,
    totalCents: data.totalCents,
    currency: data.currency,
    sessionId: null,
    paymentIntent: null,
    emailSent: false,
    certificate: 'not_started', // not_started -> pending -> generated
  };
  orders.set(id, order);
  return order;
}

export function getOrder(id) {
  return id ? orders.get(id) || null : null;
}

export function attachSession(id, sessionId) {
  const o = orders.get(id);
  if (o && sessionId) {
    o.sessionId = sessionId;
    bySession.set(sessionId, id);
  }
}

export function getOrderBySession(sessionId) {
  const id = bySession.get(sessionId);
  return id ? orders.get(id) || null : null;
}

/**
 * Mark an order paid. Idempotent: if already paid, reports alreadyFulfilled so
 * callers don't double-send emails or re-claim stars.
 * @returns {{order:object|null, alreadyFulfilled:boolean}}
 */
export function markPaid(id, payment) {
  const o = orders.get(id);
  if (!o) return { order: null, alreadyFulfilled: false };
  if (o.status === 'paid') return { order: o, alreadyFulfilled: true };
  o.status = 'paid';
  o.paidAt = Date.now();
  o.certificate = 'pending';
  if (payment) {
    if (payment.paymentIntent) o.paymentIntent = payment.paymentIntent;
    if (payment.sessionId) {
      o.sessionId = payment.sessionId;
      bySession.set(payment.sessionId, id);
    }
  }
  return { order: o, alreadyFulfilled: false };
}

export function markEmailSent(id) {
  const o = orders.get(id);
  if (o) o.emailSent = true;
}

export function markCertificate(id, status) {
  const o = orders.get(id);
  if (o) o.certificate = status;
}

/** Record a star as claimed (first claim wins). */
export function claimStar(starId, info) {
  if (!starId) return false;
  if (claims.has(starId)) return false;
  claims.set(starId, { ...info, claimedAt: Date.now() });
  return true;
}

export function isClaimed(starId) {
  return !!starId && claims.has(starId);
}

export function getClaim(starId) {
  return (starId && claims.get(starId)) || null;
}
