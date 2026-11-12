// Retry an async fn with exponential backoff. `onError(err, attempt)` is invoked
// after each failure (e.g. to append a delivery log entry).
export async function withRetry(fn, { tries = 3, baseDelayMs = 400, onError } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (onError) { try { await onError(err, attempt); } catch { /* logging must never throw */ } }
      if (attempt < tries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Reject after `ms` so a wedged dependency cannot consume the whole invocation.
 * Used to bound headless-Chromium renders, which are the only step in the
 * fulfilment path that can outlive a serverless function's maxDuration.
 * Note the underlying work is abandoned, not cancelled — callers must be safe
 * to retry.
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + '_timeout_after_' + ms + 'ms')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
