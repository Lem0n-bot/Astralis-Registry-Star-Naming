/**
 * Signed session token for the private admin pages.
 *
 * Built on Web Crypto (`crypto.subtle`) rather than `node:crypto` for one
 * reason: the same code has to run in Edge middleware — which gates the pages
 * before any admin markup is served — and in the Node route handlers that act
 * on them. Web Crypto exists in both, so there is one implementation of the
 * token format instead of two that can disagree about what counts as valid.
 *
 * Token format: `<expiryEpochMs>.<base64url HMAC-SHA256>` over
 * `v1:admin:<expiryEpochMs>`, keyed by ADMIN_SECRET. The payload is just an
 * expiry — there is one admin, so there is nothing else to carry. Verification
 * uses `crypto.subtle.verify`, so the signature comparison is not ours to get
 * wrong. Fails closed: an unset or short ADMIN_SECRET validates nothing.
 */

export const ADMIN_COOKIE = 'astralis_admin';
/** How long a login lasts. Short enough that a forgotten open tab expires. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
/** Minimum ADMIN_SECRET length. A weak secret here means a forgeable session. */
const MIN_SECRET_LENGTH = 16;

const enc = new TextEncoder();

function toBase64Url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

const message = (exp) => enc.encode(`v1:admin:${exp}`);

/** True when a usable ADMIN_SECRET is configured. */
export function isAdminSecretConfigured(secret = process.env.ADMIN_SECRET) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

/**
 * Mint a session token.
 * @returns {Promise<{value:string, expires:Date}|null>} null when unconfigured.
 */
export async function signSession(secret = process.env.ADMIN_SECRET, ttlMs = SESSION_TTL_MS) {
  if (!isAdminSecretConfigured(secret)) return null;
  const exp = Date.now() + ttlMs;
  const sig = await crypto.subtle.sign('HMAC', await key(secret), message(exp));
  return { value: `${exp}.${toBase64Url(sig)}`, expires: new Date(exp) };
}

/**
 * Verify a session token. Never throws — any malformed input is simply invalid.
 * @returns {Promise<boolean>}
 */
export async function verifySession(token, secret = process.env.ADMIN_SECRET) {
  if (!isAdminSecretConfigured(secret) || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const exp = Number(token.slice(0, dot));
  // Check the expiry before spending a verify, and reject absurd values rather
  // than trusting a parsed number.
  if (!Number.isSafeInteger(exp) || exp <= Date.now()) return false;

  try {
    return await crypto.subtle.verify('HMAC', await key(secret), fromBase64Url(token.slice(dot + 1)), message(exp));
  } catch {
    return false;
  }
}

/**
 * Cookie attributes for the session. `secure` is omitted on localhost only —
 * a browser silently drops a Secure cookie over plain HTTP, which would make
 * local login impossible. Same exemption the HTTPS redirect makes.
 */
export function cookieOptions(host, expires) {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(host || ''));
  return {
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'strict',
    path: '/',
    expires,
  };
}
