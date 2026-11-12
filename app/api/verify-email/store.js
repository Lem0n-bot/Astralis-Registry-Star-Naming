/**
 * Email-verification state, held in the durable store (Vercel KV) via the
 * short-lived primitives in app/lib/store.js. Shared by send-code, check-code
 * and — the part that makes it an authorisation boundary rather than decoration
 * — /api/checkout/create-session, which re-checks isVerified() before it opens a
 * Stripe session.
 *
 * THIS WAS AN IN-MEMORY MAP AND THAT WAS A BUG, not just technical debt. Nothing
 * is shared between serverless instances, so the instance that handled a
 * customer's `send-code` is usually not the one that handles their `check-code`:
 * the record simply isn't there, and a real buyer who typed the right code off
 * their screen was told `no_code`. Everything here is therefore keyed in the
 * store, and no path falls back to memory while a store is configured — see
 * `store_unavailable` below.
 *
 * Four records per address, all TTL-bounded so nothing needs sweeping:
 *
 *   vcode:<id>  the code itself, salted-hashed, 10 min   — the challenge
 *   vatt:<id>   attempts used, same 10 min               — atomic, max 5
 *   vcool:<id>  the resend claim, 60 s                   — atomic (SET NX)
 *   vok:<id>    "this address was verified", 30 min      — what checkout reads
 *
 * The code is stored only as a salted SHA-256, so the one value an attacker
 * could type into the form is never at rest and cannot be read back out by
 * anything — including us. It leaves the server exactly once, in the email.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  putShortLived,
  getShortLived,
  delShortLived,
  bumpShortLived,
  ttlShortLived,
} from '../../lib/store.js';
import { isKvConfigured } from '../../lib/env.js';

/** Codes expire 10 minutes after they are sent. */
export const CODE_TTL_SEC = 10 * 60;
/** One code per address per minute. */
export const RESEND_COOLDOWN_SEC = 60;
/** Guesses allowed against a single code before it is burned. */
export const MAX_ATTEMPTS = 5;
/**
 * How long a successful verification lets the buyer pay. It has to outlast the
 * rest of the funnel — after verifying, step 2 still goes through the delivery
 * form and the review step — or a slow, legitimate customer gets refused at
 * "Continue to Payment" with nothing they can do about it. It must also stay
 * short enough that a verification is not a standing permission.
 */
export const VERIFIED_TTL_SEC = 30 * 60;

/**
 * In production the verification store must be the SHARED one, so an unconfigured
 * store counts as no store rather than as "use this instance's memory".
 *
 * Memory is not a weaker version of KV here, it is wrong: send-code and
 * check-code land on different instances, so the buyer is told their correct
 * code is wrong — and create-session, which re-reads the marker, would refuse a
 * buyer who did verify. Both failures are silent and intermittent, which is the
 * worst way for a payment funnel to break. Refusing loudly is the same call this
 * codebase already makes for a missing Resend key or webhook secret.
 *
 * Locally (one process, no KV) memory is the real store and everything works.
 */
const REQUIRE_DURABLE = process.env.NODE_ENV === 'production';

/** Whether verification can run at all. /api/health surfaces the same fact. */
export const isVerificationStoreReady = () => !REQUIRE_DURABLE || isKvConfigured();

/**
 * Did the store give an answer we are willing to act on? An in-memory answer is
 * acceptable only when memory is legitimately the store.
 */
const answered = (r) => !!r.ok && (!REQUIRE_DURABLE || !!r.durable);

export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Raw addresses never become store keys: a truncated SHA-256 is enough to look a
 * record up and keeps a store dump from being a mailing list. 128 bits of a
 * SHA-256 over a namespaced input — collisions are not a practical concern, and
 * the input space (email addresses) is not secret anyway, so no secret is mixed
 * in; that keeps lookups stable across a key rotation.
 */
const idOf = (email) =>
  createHash('sha256').update(`astralis:verify:${normaliseEmail(email)}`).digest('hex').slice(0, 32);

const CODE_KEY = (id) => `vcode:${id}`;
const ATTEMPT_KEY = (id) => `vatt:${id}`;
const COOL_KEY = (id) => `vcool:${id}`;
const OK_KEY = (id) => `vok:${id}`;

const hashCode = (code, salt) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

/** Constant-time compare of two hex digests of equal length. */
function sameDigest(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/**
 * Claim the right to send a code to this address — the 60-second cooldown.
 *
 * SET NX, not read-then-write: two requests racing (a double-clicked button, or
 * someone driving the endpoint) would both pass a read-then-write check and both
 * send an email.
 *
 * @returns {Promise<{ok:true}|{ok:false, reason:'rate_limited', retryAfter:number}|{ok:false, reason:'store_unavailable'}>}
 */
export async function beginSend(email) {
  const id = idOf(email);
  const claim = await putShortLived(COOL_KEY(id), String(Date.now()), RESEND_COOLDOWN_SEC, {
    onlyIfAbsent: true,
  });
  // A configured store that did not answer. Sending now would mean saving the
  // code where the check cannot see it, so refuse instead of emailing a code
  // that is guaranteed not to work.
  if (!answered(claim)) return { ok: false, reason: 'store_unavailable' };
  if (!claim.set) {
    const left = await ttlShortLived(COOL_KEY(id));
    return { ok: false, reason: 'rate_limited', retryAfter: left || RESEND_COOLDOWN_SEC };
  }
  return { ok: true };
}

/**
 * Give the cooldown back. Called when the email provider refused the send: the
 * buyer did nothing wrong and should not wait a minute to retry. Safe to call
 * when no claim is held.
 */
export async function releaseSend(email) {
  await delShortLived(COOL_KEY(idOf(email)));
}

/**
 * Persist a freshly generated code. Only its salted hash is written. A new code
 * also clears the attempt counter, so a resend restores the full five guesses.
 * @returns {Promise<{ok:boolean, durable:boolean}>}
 */
export async function saveCode(email, code) {
  const id = idOf(email);
  const salt = randomBytes(16).toString('hex');
  await delShortLived(ATTEMPT_KEY(id));
  const w = await putShortLived(
    CODE_KEY(id),
    { salt, hash: hashCode(code, salt), at: Date.now() },
    CODE_TTL_SEC
  );
  return { ok: answered(w), durable: !!w.durable };
}

/**
 * Check a submitted code, consuming one attempt. On success the code is burned
 * and the verified marker is written — that marker, not this return value, is
 * what authorises checkout.
 *
 * An expired code is simply gone (the store's TTL is the expiry), so it reports
 * `no_code` rather than a distinct `expired`; both mean "ask for a new one".
 *
 * @returns {Promise<{ok:true}|{ok:false, reason:'no_code'|'too_many'|'mismatch'|'store_unavailable', attemptsRemaining?:number}>}
 */
export async function checkCode(email, code) {
  const id = idOf(email);
  const submitted = String(code || '').replace(/\s+/g, '');
  const rec = await getShortLived(CODE_KEY(id));
  if (!answered(rec)) return { ok: false, reason: 'store_unavailable' };
  if (!rec.value || !rec.value.hash || !rec.value.salt) return { ok: false, reason: 'no_code' };

  // Atomic, so parallel guesses each consume a distinct attempt instead of all
  // reading the same count and spending one between them.
  const used = await bumpShortLived(ATTEMPT_KEY(id), CODE_TTL_SEC);
  if (used == null) return { ok: false, reason: 'store_unavailable' };
  if (used > MAX_ATTEMPTS) {
    await burn(id);
    return { ok: false, reason: 'too_many' };
  }

  if (!sameDigest(rec.value.hash, hashCode(submitted, rec.value.salt))) {
    if (used >= MAX_ATTEMPTS) {
      await burn(id);
      return { ok: false, reason: 'too_many' };
    }
    return { ok: false, reason: 'mismatch', attemptsRemaining: MAX_ATTEMPTS - used };
  }

  // Correct. Burn the code so it cannot be replayed, drop the cooldown so a
  // later re-verification is not blocked, then record the verification.
  await Promise.all([burn(id), delShortLived(COOL_KEY(id))]);
  const mark = await putShortLived(OK_KEY(id), { at: Date.now() }, VERIFIED_TTL_SEC);
  // The code is already spent, so a store that dies in this gap means the buyer
  // must request another one. Say so rather than reporting a verification that
  // checkout will not be able to confirm.
  if (!answered(mark)) return { ok: false, reason: 'store_unavailable' };
  return { ok: true, expiresInSec: VERIFIED_TTL_SEC };
}

const burn = (id) => Promise.all([delShortLived(CODE_KEY(id)), delShortLived(ATTEMPT_KEY(id))]);

/**
 * Was this address verified within the last VERIFIED_TTL_SEC?
 *
 * The authoritative check, re-run server-side by /api/checkout/create-session.
 * The browser's own `emailVerified` flag proves nothing — the endpoint is public
 * and anyone can POST an order straight at it — so this is the only thing
 * standing between an unverified address and a charge.
 *
 * Deliberately NOT consumed. A customer who bounces off the Stripe page and
 * retries, or whose first redirect fails, must be able to pay without going
 * through verification again; the TTL is what bounds the permission.
 *
 * @returns {Promise<{ok:true}|{ok:false, reason:'not_verified'|'store_unavailable'}>}
 */
export async function isVerified(email) {
  const r = await getShortLived(OK_KEY(idOf(email)));
  if (!answered(r)) return { ok: false, reason: 'store_unavailable' };
  if (!r.value) return { ok: false, reason: 'not_verified' };
  return { ok: true };
}
