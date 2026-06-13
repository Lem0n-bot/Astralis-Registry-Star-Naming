/**
 * In-memory verification-code store, shared by the send-code and check-code
 * routes. Keyed by (normalised) email.
 *
 * TODO: This is intentionally an in-memory Map for the soft launch. A code is
 * lost only if a serverless instance recycles between the send and the check,
 * which is rare inside the 10-minute window. Before scaling, move this to
 * Vercel KV (or a database) so codes are durable across instances.
 *
 * The store is attached to globalThis so it survives module re-evaluation
 * during Next.js dev hot-reload (and is shared by both routes within one
 * serverless instance).
 */
const store = globalThis.__astralisVerifyStore || (globalThis.__astralisVerifyStore = new Map());

export const CODE_TTL_MS = 10 * 60 * 1000;     // 10 minutes
export const RESEND_COOLDOWN_MS = 60 * 1000;   // 60 seconds between sends
export const MAX_ATTEMPTS = 5;                 // checks allowed per code

export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Whether a new code may be sent for this email (60s rate limit). */
export function canSend(email) {
  const rec = store.get(normaliseEmail(email));
  if (!rec) return { ok: true };
  const wait = rec.lastSent + RESEND_COOLDOWN_MS - Date.now();
  if (wait > 0) return { ok: false, retryAfter: Math.ceil(wait / 1000) };
  return { ok: true };
}

/** Persist a freshly generated code with a 10-minute expiry. */
export function saveCode(email, code) {
  store.set(normaliseEmail(email), {
    code,
    expires: Date.now() + CODE_TTL_MS,
    attempts: 0,
    lastSent: Date.now(),
  });
}

/**
 * Check a submitted code. Consumes one of the MAX_ATTEMPTS tries. On success
 * the code is deleted so it can't be reused. Never reveals the stored code.
 */
export function checkCode(email, code) {
  const key = normaliseEmail(email);
  const submitted = String(code || '').replace(/\s+/g, '');
  const rec = store.get(key);
  if (!rec) return { ok: false, reason: 'no_code' };
  if (Date.now() > rec.expires) { store.delete(key); return { ok: false, reason: 'expired' }; }
  rec.attempts += 1;
  if (submitted === rec.code) { store.delete(key); return { ok: true }; }
  if (rec.attempts >= MAX_ATTEMPTS) { store.delete(key); return { ok: false, reason: 'too_many' }; }
  return { ok: false, reason: 'mismatch', attemptsRemaining: MAX_ATTEMPTS - rec.attempts };
}
