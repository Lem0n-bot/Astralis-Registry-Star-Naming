/**
 * Durable artifact store for fulfilment: order snapshots, certificate records,
 * and rendered blobs (PDF/PNG). Uses Vercel KV (Upstash Redis) when its env is
 * present, otherwise a per-instance in-memory fallback (globalThis-backed so it
 * survives Next.js dev hot-reload). The API is async so the KV path is a drop-in
 * with no caller changes — this is the "store certificate in a database"
 * reliability layer + the source the no-login portal reads from.
 */
import { isKvConfigured } from './env.js';

const mem =
  globalThis.__astralisStore ||
  (globalThis.__astralisStore = {
    orders: new Map(), // orderId -> fulfilled snapshot
    certs: new Map(), // certId -> record
    blobs: new Map(), // `${certId}:${format}` -> Buffer
    locks: new Set(), // orderIds currently being fulfilled
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

export async function putBlob(certId, format, buf) {
  const data = Buffer.from(buf);
  const k = await kv();
  if (k) {
    // Stored base64. Large blobs can exceed KV value limits — never let that
    // break fulfilment; the download route re-renders on demand if absent.
    try {
      await k.set(BKEY(certId, format), data.toString('base64'));
    } catch (e) {
      console.error('[store] blob persist skipped', certId, format, e?.message);
    }
  } else {
    mem.blobs.set(`${certId}:${format}`, data);
  }
}
export async function getBlob(certId, format) {
  const k = await kv();
  if (k) {
    const b64 = await k.get(BKEY(certId, format));
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
  return mem.blobs.get(`${certId}:${format}`) || null;
}

/** Best-effort fulfilment lock so a webhook + the success-page fallback don't
 *  both render/email the same order. Returns true if acquired. */
export async function acquireLock(orderId, ttlSec = 120) {
  const k = await kv();
  if (k) {
    const ok = await k.set(LKEY(orderId), '1', { nx: true, ex: ttlSec });
    return ok === 'OK' || ok === true;
  }
  if (mem.locks.has(orderId)) return false;
  mem.locks.add(orderId);
  return true;
}
export async function releaseLock(orderId) {
  const k = await kv();
  if (k) {
    try { await k.del(LKEY(orderId)); } catch {}
    return;
  }
  mem.locks.delete(orderId);
}
