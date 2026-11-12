/**
 * Durable artifact store for fulfilment: order snapshots, certificate records,
 * and rendered blobs (PDF/PNG). Uses Vercel KV (Upstash Redis) when its env is
 * present, otherwise a per-instance in-memory fallback (globalThis-backed so it
 * survives Next.js dev hot-reload). The API is async so the KV path is a drop-in
 * with no caller changes — this is the "store certificate in a database"
 * reliability layer + the source the no-login portal reads from.
 */
import { isKvConfigured } from './env.js';
import { log, errFields } from './log.js';

const mem =
  globalThis.__astralisStore ||
  (globalThis.__astralisStore = {
    orders: new Map(), // orderId -> fulfilled snapshot
    certs: new Map(), // certId -> record
    blobs: new Map(), // `${certId}:${format}` -> Buffer
    locks: new Map(), // orderId -> expiry timestamp
    rates: new Map(), // rate-limit key -> { n, until }
  });

let _kv = null;
async function kv() {
  if (!isKvConfigured()) return null;
  if (!_kv) _kv = (await import('@vercel/kv')).kv;
  return _kv;
}

const OKEY = (id) => `astralis:order:${id}`;
const CKEY = (id) => `astralis:cert:${id}`;
const BKEY = (id, f) => `astralis:blob:${id}:${f}`;
const LKEY = (id) => `astralis:lock:${id}`;

/**
 * Vercel KV / Upstash reject values above a per-plan request-size ceiling (1 MB
 * on the entry tiers). A rendered A4 certificate is ~800 KB of PDF -> ~1.1 MB of
 * base64, i.e. reliably over it, so the write used to fail on every order and
 * the confirmation email silently lost its attachment. Fulfilment now attaches
 * the in-memory buffer instead and treats this store purely as a download cache,
 * so an oversized blob is skipped up front rather than burned on a doomed
 * upload. Raise KV_MAX_VALUE_BYTES if the store's plan allows larger values.
 */
const KV_MAX_VALUE_BYTES = Number(process.env.KV_MAX_VALUE_BYTES || 900_000);

export async function putOrder(order) {
  const k = await kv();
  if (k) await k.set(OKEY(order.id), order);
  else mem.orders.set(order.id, order);
  return order;
}
export async function getOrder(id) {
  if (!id) return null;
  const k = await kv();
  if (k) return (await k.get(OKEY(id))) || null;
  return mem.orders.get(id) || null;
}

export async function putCert(cert) {
  const k = await kv();
  if (k) await k.set(CKEY(cert.certId), cert);
  else mem.certs.set(cert.certId, cert);
  return cert;
}
export async function getCert(certId) {
  if (!certId) return null;
  const k = await kv();
  if (k) return (await k.get(CKEY(certId))) || null;
  return mem.certs.get(certId) || null;
}

/** Cache a rendered blob. Best-effort by design — callers must stay correct when
 *  this stores nothing, since the download route re-renders on demand. */
export async function putBlob(certId, format, buf) {
  const data = Buffer.from(buf);
  const k = await kv();
  if (!k) {
    mem.blobs.set(`${certId}:${format}`, data);
    return false;
  }

  const encoded = data.toString('base64');
  if (encoded.length > KV_MAX_VALUE_BYTES) {
    log.info('store.blob_too_large', {
      certId,
      format,
      bytes: data.length,
      encodedBytes: encoded.length,
      limit: KV_MAX_VALUE_BYTES,
    });
    return false;
  }

  try {
    await k.set(BKEY(certId, format), encoded);
    return true;
  } catch (err) {
    log.warn('store.blob_persist_failed', { certId, format, encodedBytes: encoded.length, ...errFields(err) });
    return false;
  }
}

export async function getBlob(certId, format) {
  const k = await kv();
  if (k) {
    try {
      const b64 = await k.get(BKEY(certId, format));
      return b64 ? Buffer.from(b64, 'base64') : null;
    } catch (err) {
      log.warn('store.blob_read_failed', { certId, format, ...errFields(err) });
      return null;
    }
  }
  return mem.blobs.get(`${certId}:${format}`) || null;
}

/**
 * Best-effort fulfilment lock so a webhook + the success-page fallback don't
 * both render/email the same order. Returns true if acquired.
 *
 * The TTL must stay just above the function's own maxDuration: if the instance
 * is killed mid-render the `finally` that releases the lock never runs, and a
 * long TTL would then strand the order behind a lock nobody holds.
 */
export async function acquireLock(orderId, ttlSec = 75) {
  const k = await kv();
  if (k) {
    try {
      const ok = await k.set(LKEY(orderId), String(Date.now()), { nx: true, ex: ttlSec });
      return ok === 'OK' || ok === true;
    } catch (err) {
      // A store outage must not block fulfilment — proceed unlocked and accept
      // the small risk of a duplicate email over the certainty of no email.
      log.warn('store.lock_unavailable', { orderId, ...errFields(err) });
      return true;
    }
  }
  const until = mem.locks.get(orderId);
  if (until && until > Date.now()) return false;
  mem.locks.set(orderId, Date.now() + ttlSec * 1000);
  return true;
}

/**
 * Increment a counter that expires, for rate limiting. KV-backed when
 * configured, so the limit holds across serverless instances instead of being
 * trivially bypassed by hitting a cold one; per-instance memory otherwise.
 * @returns {Promise<number>} the count after this hit (1 on the first).
 */
export async function incrWithTtl(key, ttlSec) {
  const k = await kv();
  if (k) {
    try {
      const n = await k.incr(`astralis:rl:${key}`);
      // Set the window on the first hit only, so the window is fixed from the
      // first attempt rather than sliding forward with every retry.
      if (n === 1) await k.expire(`astralis:rl:${key}`, ttlSec);
      return n;
    } catch (err) {
      // A store outage must not lock the owner out of their own admin page.
      log.warn('store.ratelimit_unavailable', { key, ...errFields(err) });
      return 1;
    }
  }
  const now = Date.now();
  const cur = mem.rates.get(key);
  if (!cur || cur.until <= now) {
    mem.rates.set(key, { n: 1, until: now + ttlSec * 1000 });
    return 1;
  }
  cur.n += 1;
  return cur.n;
}

export async function releaseLock(orderId) {
  const k = await kv();
  if (k) {
    try { await k.del(LKEY(orderId)); } catch (err) {
      log.warn('store.lock_release_failed', { orderId, ...errFields(err) });
    }
    return;
  }
  mem.locks.delete(orderId);
}
