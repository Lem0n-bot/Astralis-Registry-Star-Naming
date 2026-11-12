/**
 * Durable artifact store for fulfilment: order snapshots, certificate records,
 * and rendered blobs (PDF/PNG). Uses Vercel KV (Upstash Redis) when its env is
 * present, otherwise a per-instance in-memory fallback (globalThis-backed so it
 * survives Next.js dev hot-reload). The API is async so the KV path is a drop-in
 * with no caller changes — this is the "store certificate in a database"
 * reliability layer + the source the no-login portal reads from.
 *
 * NOTHING HERE THROWS. A free Upstash database is deleted after 14 days without
 * commands, and when ours was, every KV call started failing with
 * `getaddrinfo ENOTFOUND`. Because the order read at the top of fulfillOrder()
 * was unguarded, that exception escaped before any work was done: the webhook
 * answered 500 on every one of Stripe's retries and no customer email was ever
 * sent. So each operation is now wrapped, classified, and falls back to memory:
 *
 *   - UNREACHABLE (DNS / connect / timeout — a deleted or down database) is
 *     logged once per breaker window as `kv.unreachable`, opens a short circuit
 *     breaker so the rest of the invocation does not pay the same timeout again,
 *     and DEGRADES: reads answer null, writes land in memory. Fulfilment then
 *     rebuilds the order from the Stripe session metadata (lib/order-codec.js),
 *     renders, and still emails the certificates.
 *   - REJECTED while reachable (rotated token, oversized value) is a real
 *     failure and is reported as one, so a misconfiguration stays loud instead
 *     of quietly dropping every order snapshot.
 *
 * /api/keepalive (daily Vercel Cron) writes through touchKv() so the database
 * never idles out again; /api/health calls pingKv() so an unreachable store is
 * visible in one request instead of through a customer who paid and got nothing.
 */
import { randomUUID } from 'node:crypto';
import { isKvConfigured } from './env.js';
import { log, errFields } from './log.js';
import { withTimeout } from './retry.js';

const mem =
  globalThis.__astralisStore ||
  (globalThis.__astralisStore = {
    orders: new Map(), // orderId -> fulfilled snapshot
    certs: new Map(), // certId -> record
    blobs: new Map(), // `${certId}:${format}` -> Buffer
    locks: new Map(), // orderId -> expiry timestamp
    rates: new Map(), // rate-limit key -> { n, until }
    short: new Map(), // short-lived key -> { value, expires }
  });

/** Breaker + last-ping state. Kept on the shared object so it survives a dev
 *  hot-reload, and tolerated as missing on an object an older build created. */
const kvState = (mem.kv ||= { downUntil: 0, lastLogAt: 0, lastError: null, ping: null });

let _kv = null;

/**
 * The KV client, or null when there is nothing to call: env unset, or the
 * breaker is open because the store just failed to answer.
 */
async function kvClient({ ignoreBreaker = false } = {}) {
  if (!isKvConfigured()) return null;
  if (!ignoreBreaker && kvState.downUntil > Date.now()) return null;
  if (!_kv) _kv = (await import('@vercel/kv')).kv;
  return _kv;
}

const OKEY = (id) => `astralis:order:${id}`;
const CKEY = (id) => `astralis:cert:${id}`;
const BKEY = (id, f) => `astralis:blob:${id}:${f}`;
const LKEY = (id) => `astralis:lock:${id}`;
const KEEPALIVE_KEY = 'astralis:keepalive';
const KEEPALIVE_HITS_KEY = 'astralis:keepalive:hits';
/**
 * Probe keys are UNIQUE PER RUN, and that is load-bearing, not tidiness.
 *
 * The KV client talks to Upstash over HTTP, and a framework-patched fetch (Next
 * does this) can serve a repeated POST from cache. With a fixed probe key, every
 * run sent a byte-identical `get`, so the second health/keepalive run read the
 * FIRST run's answer: the store never saw the request, and the keepalive
 * reported a 503 against a perfectly healthy database. The same mechanism can
 * fail the other way and make a DEAD store look alive, which is worse.
 *
 * A unique key per run makes every probe command unique, so a cache can neither
 * answer it nor hide an outage. The routes also set `fetchCache` to
 * 'force-no-store'; this is the belt to that braces.
 */
const probeKey = (stamp) => `astralis:probe:${stamp}`;

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
/** Ceiling for a single KV command, so a blackholed host cannot eat the whole
 *  invocation the way an unbounded fetch would. */
const KV_OP_TIMEOUT_MS = Number(process.env.KV_OP_TIMEOUT_MS || 4_000);
/** Ceiling for the health / keepalive round trip. */
const KV_PING_TIMEOUT_MS = Number(process.env.KV_PING_TIMEOUT_MS || 3_000);
/** How long to stop calling an unreachable store for. Short on purpose: long
 *  enough to save one invocation from repeating a dead lookup, short enough that
 *  a restored database is picked up again within a minute. */
const KV_BREAKER_MS = Number(process.env.KV_BREAKER_MS || 30_000);
/** How often an unreachable store may log, so a burst of orders cannot flood. */
const KV_LOG_EVERY_MS = Number(process.env.KV_LOG_EVERY_MS || 30_000);
/** How long /api/health may reuse a ping result, so a public endpoint cannot be
 *  turned into load against the store. */
const PING_CACHE_MS = Number(process.env.KV_PING_CACHE_MS || 10_000);

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Is this "the database is not there" rather than "the database said no"?
 * Only the former may degrade quietly — a rejected command (401 from a rotated
 * token, a value over the size ceiling) must still be reported as a failure.
 */
function isUnreachable(err) {
  if (!err) return false;
  const code = String(err.code || err.cause?.code || '');
  if (UNREACHABLE_CODES.has(code)) return true;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('getaddrinfo') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('connect timeout') ||
    msg.includes('network') ||
    msg.includes('timeout')
  );
}

/**
 * Upstash puts the WHOLE failing command in its error message — which for an
 * order write is the snapshot JSON: buyer name, email, phone, street address.
 * lib/log.js promises never to log PII beyond an email domain, and these errors
 * also travel into the order's delivery log, so cut the command off and cap the
 * length before anything sees it.
 */
function cleanError(err) {
  const raw = String(err?.message || err || 'unknown');
  return raw.split(', command was:')[0].slice(0, 200);
}

/** errFields(), with the message sanitised the same way. */
const errSafe = (err) => ({ ...errFields(err), error: cleanError(err) });

/** Open the breaker and log `kv.unreachable` at most once per window. */
function noteUnreachable(op, err) {
  const t = Date.now();
  kvState.downUntil = t + KV_BREAKER_MS;
  kvState.lastError = cleanError(err);
  if (t - kvState.lastLogAt < KV_LOG_EVERY_MS) return;
  kvState.lastLogAt = t;
  log.error('kv.unreachable', {
    op,
    breakerMs: KV_BREAKER_MS,
    // Op-specific, because the consequence differs: an order snapshot degrades
    // and the order is still delivered, whereas email verification has nowhere
    // to degrade to and refuses (see the short-lived helpers below).
    hint: op.startsWith('short_')
      ? 'email verification cannot degrade to memory; the checkout funnel refuses while this lasts'
      : 'snapshots degrade to memory; fulfilment rebuilds the order from Stripe metadata',
    ...errSafe(err),
  });
}

/**
 * Run one KV command. Never throws.
 * @returns {Promise<{ok:true, value:any} | {ok:false, unreachable:boolean, error:string}>}
 */
async function kvOp(op, fn, { timeoutMs = KV_OP_TIMEOUT_MS } = {}) {
  try {
    const value = await withTimeout(Promise.resolve().then(fn), timeoutMs, `kv_${op}`);
    // A command that answered means the store is back; close the breaker.
    if (kvState.downUntil) kvState.downUntil = 0;
    return { ok: true, value };
  } catch (err) {
    const unreachable = isUnreachable(err);
    if (unreachable) noteUnreachable(op, err);
    else log.error('kv.rejected', { op, ...errSafe(err) });
    return { ok: false, unreachable, error: cleanError(err) };
  }
}

/** Shape returned by every write, so callers can tell durable from degraded. */
const wrote = (store, extra = {}) => ({ ok: true, durable: store === 'kv', store, degraded: false, ...extra });
const writeFailed = (r, extra = {}) => ({
  ok: false,
  durable: false,
  store: 'memory',
  degraded: !!r.unreachable,
  reason: r.unreachable ? 'kv_unreachable' : 'kv_rejected',
  error: r.error,
  ...extra,
});
/** The store is configured but the breaker is open — it was down moments ago, so
 *  this write was never attempted. Says so, rather than reporting the unrelated
 *  earlier command as if it were this one's error. */
const breakerOpenWrite = () =>
  writeFailed({
    unreachable: true,
    error: kvState.lastError ? `breaker_open; last error: ${kvState.lastError}` : 'breaker_open',
  });

/** There was no client to call. No store configured at all is the documented
 *  metadata-fallback / local-dev mode, not a failure; configured-but-breaker-open
 *  means the store is down, which is. */
const noClientWrite = () => (isKvConfigured() ? breakerOpenWrite() : wrote('memory'));

/**
 * Persist an order snapshot.
 * @returns {Promise<{ok:boolean, durable:boolean, degraded:boolean, store:string, reason?:string}>}
 *   `ok:false, degraded:true` means the store was unreachable and the snapshot
 *   exists only on this instance — the caller decides what that is worth (see
 *   lib/fulfill.js, which still delivers the order and says so in the logs).
 */
export async function putOrder(order) {
  const k = await kvClient();
  if (!k) {
    mem.orders.set(order.id, order);
    return noClientWrite();
  }
  const r = await kvOp('order_write', () => k.set(OKEY(order.id), order));
  if (r.ok) return wrote('kv');
  // Keep it reachable at least from this instance for the rest of the request.
  mem.orders.set(order.id, order);
  return writeFailed(r);
}

export async function getOrder(id) {
  if (!id) return null;
  const k = await kvClient();
  if (!k) return mem.orders.get(id) || null;
  const r = await kvOp('order_read', () => k.get(OKEY(id)));
  if (r.ok) return r.value || null;
  return mem.orders.get(id) || null;
}

export async function putCert(cert) {
  const k = await kvClient();
  if (!k) {
    mem.certs.set(cert.certId, cert);
    return noClientWrite();
  }
  const r = await kvOp('cert_write', () => k.set(CKEY(cert.certId), cert));
  if (r.ok) return wrote('kv');
  mem.certs.set(cert.certId, cert);
  return writeFailed(r);
}

export async function getCert(certId) {
  if (!certId) return null;
  const k = await kvClient();
  if (!k) return mem.certs.get(certId) || null;
  const r = await kvOp('cert_read', () => k.get(CKEY(certId)));
  if (r.ok) return r.value || null;
  return mem.certs.get(certId) || null;
}

/** Cache a rendered blob. Best-effort by design — callers must stay correct when
 *  this stores nothing, since the download route re-renders on demand. */
export async function putBlob(certId, format, buf) {
  const data = Buffer.from(buf);
  const k = await kvClient();
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

  const r = await kvOp('blob_write', () => k.set(BKEY(certId, format), encoded));
  if (r.ok) return true;
  log.warn('store.blob_persist_failed', { certId, format, encodedBytes: encoded.length, error: r.error });
  return false;
}

export async function getBlob(certId, format) {
  const k = await kvClient();
  if (!k) return mem.blobs.get(`${certId}:${format}`) || null;
  const r = await kvOp('blob_read', () => k.get(BKEY(certId, format)));
  if (!r.ok) {
    log.warn('store.blob_read_failed', { certId, format, error: r.error });
    return mem.blobs.get(`${certId}:${format}`) || null;
  }
  return r.value ? Buffer.from(r.value, 'base64') : null;
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
  const k = await kvClient();
  if (k) {
    const r = await kvOp('lock_acquire', () => k.set(LKEY(orderId), String(Date.now()), { nx: true, ex: ttlSec }));
    if (r.ok) return r.value === 'OK' || r.value === true;
    // A store outage must not block fulfilment — proceed unlocked and accept
    // the small risk of a duplicate email over the certainty of no email.
    log.warn('store.lock_unavailable', { orderId, error: r.error });
    return true;
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
  const k = await kvClient();
  if (k) {
    const r = await kvOp('ratelimit_incr', () => k.incr(`astralis:rl:${key}`));
    if (r.ok) {
      // Set the window on the first hit only, so the window is fixed from the
      // first attempt rather than sliding forward with every retry.
      if (r.value === 1) await kvOp('ratelimit_expire', () => k.expire(`astralis:rl:${key}`, ttlSec));
      return r.value;
    }
    // A store outage must not lock the owner out of their own admin page.
    log.warn('store.ratelimit_unavailable', { key, error: r.error });
    return 1;
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

/* ── Short-lived keyed records ───────────────────────────────────────────────
 *
 * TTL-bounded primitives for email verification (app/api/verify-email/store.js).
 * They differ from everything above in one way that matters: they must NOT
 * quietly degrade to per-instance memory in production. A code written by the
 * instance that handled `send-code` is invisible to the instance that handles
 * `check-code`, and a "verified" marker invisible to `create-session` turns a
 * customer away at the last button. So these report where the answer came from
 * and their callers refuse the flow when the store is configured but silent.
 *
 * With no store configured at all (local dev, one process) memory IS the store,
 * so a read is `ok:true, durable:false` and the flow proceeds.
 */

const SKEY = (key) => `astralis:s:${key}`;

/** Memory fallback for the above. Tolerated as missing on an object an older
 *  build created, like kvState. Expiry is explicit, with lazy eviction. */
const memShort = () => (mem.short ||= new Map());

function memShortGet(key) {
  const m = memShort();
  const rec = m.get(key);
  if (!rec) return undefined;
  if (rec.expires <= Date.now()) {
    m.delete(key);
    return undefined;
  }
  return rec;
}

/**
 * Write a short-lived record. `onlyIfAbsent` makes it an atomic claim (SET NX),
 * which is how the resend cooldown is enforced: a read-then-write check lets two
 * concurrent requests both pass and send two codes.
 * @returns {Promise<{ok:boolean, durable:boolean, store:string, set:boolean}>}
 *   `set:false` with `ok:true` means the key already existed — a refusal, not a
 *   failure. `ok:false` means the store was asked and did not answer.
 */
export async function putShortLived(key, value, ttlSec, { onlyIfAbsent = false } = {}) {
  const k = await kvClient();
  if (!k) {
    if (isKvConfigured()) return { ...breakerOpenWrite(), set: false };
    if (onlyIfAbsent && memShortGet(key)) return { ...wrote('memory'), set: false };
    memShort().set(key, { value, expires: Date.now() + ttlSec * 1000 });
    return { ...wrote('memory'), set: true };
  }
  const opts = onlyIfAbsent ? { nx: true, ex: ttlSec } : { ex: ttlSec };
  const r = await kvOp('short_write', () => k.set(SKEY(key), value, opts));
  if (!r.ok) return { ...writeFailed(r), set: false };
  // Under NX a null reply means the key was already there, which is the whole
  // point of the claim — so it is a successful command with `set:false`.
  return { ...wrote('kv'), set: !onlyIfAbsent || r.value === 'OK' || r.value === true };
}

/**
 * Read a short-lived record.
 * @returns {Promise<{ok:boolean, durable:boolean, store:string, value:any}>}
 *   `ok` means the answer is trustworthy, so a caller can tell "no such key"
 *   (`ok:true, value:null`) from "there was nobody to ask" (`ok:false`).
 */
export async function getShortLived(key) {
  const k = await kvClient();
  if (!k) {
    const rec = memShortGet(key);
    const configured = isKvConfigured();
    return {
      ok: !configured,
      durable: false,
      store: 'memory',
      ...(configured ? { reason: 'kv_unreachable', error: kvState.lastError || 'breaker_open' } : {}),
      value: rec ? rec.value : null,
    };
  }
  const r = await kvOp('short_read', () => k.get(SKEY(key)));
  if (!r.ok) {
    return {
      ok: false,
      durable: false,
      store: 'memory',
      reason: r.unreachable ? 'kv_unreachable' : 'kv_rejected',
      error: r.error,
      value: null,
    };
  }
  return { ok: true, durable: true, store: 'kv', value: r.value ?? null };
}

/** Drop a short-lived record. Best-effort: a key that outlives its delete still
 *  expires on its own, and the caller has already made its decision. */
export async function delShortLived(key) {
  const k = await kvClient();
  if (!k) {
    memShort().delete(key);
    return;
  }
  const r = await kvOp('short_del', () => k.del(SKEY(key)));
  // The key is hashed, but never log it anyway — it identifies one buyer.
  if (!r.ok) log.warn('store.short_del_failed', { error: r.error });
}

/**
 * Atomically increment a short-lived counter; returns the count after this hit.
 *
 * Unlike incrWithTtl() this does NOT fail open, and returns null instead: that
 * one guards an admin login where locking the owner out is the worse outcome,
 * whereas this one counts verification attempts, and a counter that answers "1"
 * through an outage hands out unlimited guesses at a 6-digit code.
 * @returns {Promise<number|null>} null when the store did not answer.
 */
export async function bumpShortLived(key, ttlSec) {
  const k = await kvClient();
  if (k) {
    const r = await kvOp('short_incr', () => k.incr(SKEY(key)));
    if (!r.ok) return null;
    // Window set on the first hit only, so it is fixed from the first attempt
    // rather than sliding forward with every guess.
    if (r.value === 1) await kvOp('short_expire', () => k.expire(SKEY(key), ttlSec));
    return r.value;
  }
  if (isKvConfigured()) return null;
  const rec = memShortGet(key);
  const n = (rec ? Number(rec.value) || 0 : 0) + 1;
  memShort().set(key, { value: n, expires: rec ? rec.expires : Date.now() + ttlSec * 1000 });
  return n;
}

/** Seconds left on a short-lived key, or null when that is not knowable. Used to
 *  tell the browser how long a resend cooldown has left to run. */
export async function ttlShortLived(key) {
  const k = await kvClient();
  if (!k) {
    const rec = memShortGet(key);
    return rec ? Math.max(1, Math.ceil((rec.expires - Date.now()) / 1000)) : null;
  }
  const r = await kvOp('short_ttl', () => k.ttl(SKEY(key)));
  if (!r.ok || typeof r.value !== 'number' || r.value < 0) return null;
  return r.value;
}

export async function releaseLock(orderId) {
  const k = await kvClient();
  if (k) {
    const r = await kvOp('lock_release', () => k.del(LKEY(orderId)));
    if (!r.ok) log.warn('store.lock_release_failed', { orderId, error: r.error });
    return;
  }
  mem.locks.delete(orderId);
}

/**
 * Live round trip against the store, for /api/health. Does a real write and
 * reads it back, because a configured-but-deleted database passes every env
 * check perfectly while failing every command.
 *
 * Memoised for PING_CACHE_MS and short-circuited while the breaker is open, so
 * a public health endpoint cannot be turned into load against the store.
 * @returns {Promise<{configured:boolean, reachable:boolean, latencyMs:number|null, error:string|null, cached?:boolean, breakerOpen?:boolean}>}
 */
export async function pingKv({ maxAgeMs = PING_CACHE_MS, timeoutMs = KV_PING_TIMEOUT_MS } = {}) {
  if (!isKvConfigured()) {
    return { configured: false, reachable: false, latencyMs: null, error: null };
  }

  const cached = kvState.ping;
  if (cached && Date.now() - cached.at < maxAgeMs) return { ...cached.result, cached: true };

  if (kvState.downUntil > Date.now()) {
    // It failed moments ago; report that rather than queueing another timeout.
    return {
      configured: true,
      reachable: false,
      latencyMs: null,
      error: kvState.lastError || 'kv_unreachable',
      breakerOpen: true,
    };
  }

  const k = await kvClient();
  const t0 = Date.now();
  const stamp = `${t0}-${randomUUID().slice(0, 8)}`;
  const key = probeKey(stamp);
  const w = await kvOp('health_ping_write', () => k.set(key, stamp, { ex: 60 }), { timeoutMs });
  const r = w.ok ? await kvOp('health_ping_read', () => k.get(key), { timeoutMs }) : w;
  const result = {
    configured: true,
    reachable: !!(w.ok && r.ok && String(r.value) === stamp),
    latencyMs: Date.now() - t0,
    error: w.ok ? (r.ok ? null : r.error) : w.error,
  };
  kvState.ping = { at: Date.now(), result };
  return result;
}

/**
 * The keepalive write. A free Upstash database is deleted after 14 days with no
 * commands, which is how fulfilment broke: the store vanished underneath a live
 * site. /api/keepalive runs this daily from a Vercel Cron.
 *
 * Deliberately a real write + read back + counter, not a ping: resetting an idle
 * timer has to be an actual command, and reading the value back proves the round
 * trip rather than just that a request was accepted. Ignores the breaker — this
 * is the authoritative once-a-day probe.
 * @returns {Promise<object>} never throws.
 */
export async function touchKv(meta = {}) {
  if (!isKvConfigured()) {
    return { configured: false, reachable: false, wrote: false, readBack: false, latencyMs: null, error: null };
  }
  const k = await kvClient({ ignoreBreaker: true });
  const t0 = Date.now();
  const timeoutMs = KV_PING_TIMEOUT_MS;
  const stamp = `${t0}-${randomUUID().slice(0, 8)}`;

  // 1. The proof: a write and a read of a key no previous run used, so neither
  //    command can be answered from a cache.
  const key = probeKey(stamp);
  const w = await kvOp('keepalive_write', () => k.set(key, stamp, { ex: 300 }), { timeoutMs });
  const r = w.ok ? await kvOp('keepalive_read', () => k.get(key), { timeoutMs }) : w;
  const readBack = !!(r.ok && String(r.value) === stamp);

  // 2. The durable marker, so `astralis:keepalive` always shows when the store
  //    was last touched. Its body carries the stamp, so it is unique too. The
  //    30-day TTL is comfortably longer than the cron interval and does not
  //    linger forever if the cron is ever removed.
  const marker = { ts: t0, iso: new Date(t0).toISOString(), stamp, ...meta };
  const m = readBack
    ? await kvOp('keepalive_marker', () => k.set(KEEPALIVE_KEY, marker, { ex: 2_592_000 }), { timeoutMs })
    : { ok: false, error: 'skipped' };

  // 3. Informational run counter. Its body is NOT unique, so its value is never
  //    allowed to decide whether the store is reachable.
  const hits = readBack ? await kvOp('keepalive_incr', () => k.incr(KEEPALIVE_HITS_KEY), { timeoutMs }) : null;

  return {
    configured: true,
    reachable: !!(w.ok && readBack && m.ok),
    wrote: !!w.ok,
    readBack,
    marked: !!m.ok,
    hits: hits && hits.ok ? hits.value : null,
    latencyMs: Date.now() - t0,
    error: w.ok ? (r.ok ? m.ok ? null : m.error : r.error) : w.error,
  };
}

/** Current breaker view, for diagnostics. */
export function kvStatus() {
  return {
    configured: isKvConfigured(),
    breakerOpen: kvState.downUntil > Date.now(),
    lastError: kvState.lastError || null,
  };
}
