/**
 * Order <-> Stripe-metadata codec.
 *
 * WHY THIS EXISTS: orders are created on one serverless instance and fulfilled
 * on another (the webhook, minutes later). Without Vercel KV, ./store.js falls
 * back to per-instance memory, so the fulfilling instance finds nothing and the
 * buyer is charged with no certificate and no email — a silent, money-taking
 * failure.
 *
 * Stripe is itself a durable store we already write to, so we stash the whole
 * order inside the Checkout Session's metadata. Fulfilment can then rebuild the
 * order from the webhook payload alone, with zero infrastructure. KV remains the
 * preferred path when configured; this is the safety net underneath it.
 *
 * Encoding: JSON -> raw deflate -> base64url -> 500-char chunks across numbered
 * metadata keys (Stripe allows 50 keys x 500 chars). `packOrder` returns null
 * when an order is too large to fit, and callers must then refuse the sale
 * rather than take an unfulfillable payment.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CHUNK = 500; // Stripe's per-value limit
const MAX_CHUNKS = 40; // leaves room for orderId / orderNo / count / future keys
const PREFIX = 'od';
const COUNT_KEY = 'odN';

/** Strip an order down to exactly what fulfilment + the certificate need. */
function slim(order) {
  return {
    i: order.id,
    n: order.orderNo,
    e: order.email,
    c: order.createdAt || Date.now(),
    t: order.totalCents,
    u: order.currency,
    d: order.delivery || null,
    m: (order.items || []).map((it) => ({
      p: it.pkg,
      c: it.priceCents,
      n: it.name,
      r: it.recip,
      o: it.occ,
      g: it.msg,
      h: it.theme,
      s: it.cons,
      d: it.seed,
      t: it.star || null,
    })),
  };
}

/** Inverse of slim() — returns an order object shaped like createOrder()'s. */
function fatten(s) {
  return {
    id: s.i,
    orderNo: s.n,
    status: 'pending',
    createdAt: s.c,
    paidAt: null,
    email: s.e,
    totalCents: s.t,
    currency: s.u,
    delivery: s.d || null,
    items: (s.m || []).map((it) => ({
      pkg: it.p,
      priceCents: it.c,
      name: it.n,
      recip: it.r,
      occ: it.o,
      msg: it.g,
      theme: it.h,
      cons: it.s,
      seed: it.d,
      star: it.t || null,
    })),
    sessionId: null,
    paymentIntent: null,
  };
}

/**
 * Encode an order into Stripe metadata keys.
 * @returns {Record<string,string>|null} null when it will not fit.
 */
export function packOrder(order) {
  let b64;
  try {
    b64 = deflateRawSync(Buffer.from(JSON.stringify(slim(order)), 'utf8')).toString('base64url');
  } catch (err) {
    console.error('[order-codec] pack failed', err?.message);
    return null;
  }

  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
  if (chunks.length > MAX_CHUNKS) return null;

  const meta = { [COUNT_KEY]: String(chunks.length) };
  chunks.forEach((c, i) => {
    meta[`${PREFIX}${i}`] = c;
  });
  return meta;
}

/**
 * Rebuild an order from Stripe session metadata.
 * @returns {object|null} null when the metadata carries no packed order.
 */
export function unpackOrder(metadata) {
  if (!metadata || !metadata[COUNT_KEY]) return null;
  const count = parseInt(metadata[COUNT_KEY], 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) return null;

  let b64 = '';
  for (let i = 0; i < count; i++) {
    const part = metadata[`${PREFIX}${i}`];
    if (typeof part !== 'string') {
      console.error('[order-codec] missing chunk', i, 'of', count);
      return null;
    }
    b64 += part;
  }

  try {
    const order = fatten(JSON.parse(inflateRawSync(Buffer.from(b64, 'base64url')).toString('utf8')));
    return order && order.id && Array.isArray(order.items) && order.items.length ? order : null;
  } catch (err) {
    console.error('[order-codec] unpack failed', err?.message);
    return null;
  }
}
