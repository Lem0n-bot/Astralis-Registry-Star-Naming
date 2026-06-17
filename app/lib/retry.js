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
