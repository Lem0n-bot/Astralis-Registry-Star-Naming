/**
 * GET /api/keepalive — daily Vercel Cron (see vercel.json).
 *
 * WHY THIS EXISTS: the free Upstash Redis database behind Vercel KV is deleted
 * after 14 days without a single command. Ours was, and because the site had
 * been quiet, the deletion was discovered through fulfilment failing with
 * `getaddrinfo ENOTFOUND` on a live order. One real write a day resets that idle
 * timer, so a slow week can never take the order store with it again.
 *
 * It is a genuine round trip, not a ping: write a timestamp, read it back,
 * increment a counter (lib/store.js -> touchKv). A request that merely reaches
 * this route proves nothing about the database.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` — the header Vercel Cron sends
 * automatically when CRON_SECRET is set in the project's env. `x-cron-secret` is
 * accepted too, so it can be driven from curl during an incident. Compared in
 * constant time, and while CRON_SECRET is unset the route 404s: inert by
 * default, and it cannot be probed into existence.
 *
 * Status codes are for the cron dashboard: 200 healthy, 503 when the store is
 * configured but unreachable — a red cron run is the alarm that this whole route
 * exists to raise.
 *
 *   curl -s -H "x-cron-secret: $CRON_SECRET" https://astralisregistry.com/api/keepalive | jq
 */
import crypto from 'node:crypto';
import { touchKv } from '../../lib/store.js';
import { isKvConfigured } from '../../lib/env.js';
import { log, now, since } from '../../lib/log.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The KV client speaks HTTP, and a cached response would defeat the entire
// point: a repeated POST answered from cache never reaches the database, so the
// idle timer is never reset and the probe reports on a request that never
// happened. lib/store.js also makes every probe command unique per run.
export const fetchCache = 'force-no-store';
// A couple of Redis commands. Generous only so a cold start cannot fail the run.
export const maxDuration = 15;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** Minimum length for the secret, matching ADMIN_API_TOKEN's posture: a short
 *  secret is treated as unconfigured rather than silently accepted. */
const MIN_SECRET_LENGTH = 16;

function presentedSecret(req) {
  const header = req.headers.get('x-cron-secret');
  if (header) return header.trim();
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** @returns {Response|null} a response to return immediately, or null when authorised. */
function authorise(req) {
  const expected = process.env.CRON_SECRET || '';
  if (expected.length < MIN_SECRET_LENGTH) {
    if (expected) log.error('keepalive.secret_too_short', { minLength: MIN_SECRET_LENGTH });
    else log.warn('keepalive.not_configured', { hint: 'set CRON_SECRET to enable the keepalive cron' });
    return json({ error: 'not_found' }, 404);
  }
  const got = presentedSecret(req);
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn('keepalive.unauthorised', { hasSecret: !!got, isVercelCron: !!req.headers.get('x-vercel-cron') });
    return json({ error: 'unauthorised' }, 401);
  }
  return null;
}

export async function GET(req) {
  const denied = authorise(req);
  if (denied) return denied;

  const t0 = now();
  // `x-vercel-cron` is set by the platform on scheduled invocations, so the logs
  // distinguish the daily run from a manual curl. Never used for auth.
  const source = req.headers.get('x-vercel-cron') ? 'cron' : 'manual';

  if (!isKvConfigured()) {
    // Nothing to keep alive. Not an error: the site runs without KV on the
    // Stripe-metadata fallback, and this must not page anyone for that.
    log.warn('keepalive.skipped', { source, reason: 'kv_not_configured' });
    return json({ ok: true, skipped: true, kv: { configured: false }, source, ts: new Date().toISOString() });
  }

  const kv = await touchKv({ source });
  const ms = since(t0);

  if (!kv.reachable) {
    // The database is gone or unreachable. Loud, and a 503 so the cron run shows
    // as failed in the Vercel dashboard instead of passing quietly.
    log.error('keepalive.failed', { source, wrote: kv.wrote, readBack: kv.readBack, error: kv.error, ms });
    return json(
      { ok: false, error: 'kv_unreachable', kv, source, ms, ts: new Date().toISOString() },
      503
    );
  }

  log.info('keepalive.ok', { source, hits: kv.hits, latencyMs: kv.latencyMs, ms });
  return json({ ok: true, kv, source, ms, ts: new Date().toISOString() });
}
