/**
 * Structured logging for the payment → fulfilment → delivery path.
 *
 * Every line is a single JSON object so Vercel's log search can filter by stage
 * ("stage":"cert.render") or by order ("AST-ORD-12345") and so a stranded order
 * can be reconstructed after the fact. This path takes customers' money; when it
 * fails we need to know exactly which step failed and how long it had been
 * running, not just that "something" threw.
 *
 * Never throws and never logs PII beyond the order's own email domain.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

/** anh@gmail.com -> a***@gmail.com. Enough to correlate, not to harvest. */
function maskEmail(value) {
  const m = String(value || '').match(/([^\s<>@]+)@([^\s<>]+)/);
  return m ? `${m[1].slice(0, 1)}***@${m[2]}` : undefined;
}

function emit(level, stage, fields) {
  if (LEVELS[level] < MIN) return;
  let line;
  try {
    const { email, ...rest } = fields || {};
    line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      stage,
      ...(email ? { email: maskEmail(email) } : {}),
      ...rest,
    });
  } catch {
    line = `{"level":"${level}","stage":"${stage}","err":"unserialisable_log_fields"}`;
  }
  // error/warn go to stderr so they surface as errors in the Vercel dashboard.
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (stage, fields) => emit('debug', stage, fields),
  info: (stage, fields) => emit('info', stage, fields),
  warn: (stage, fields) => emit('warn', stage, fields),
  error: (stage, fields) => emit('error', stage, fields),
};

/** Normalise a thrown value into loggable fields. */
export function errFields(err) {
  if (!err) return { error: 'unknown' };
  return {
    error: String(err.message || err),
    ...(err.name && err.name !== 'Error' ? { errorName: err.name } : {}),
    ...(err.code ? { errorCode: String(err.code) } : {}),
  };
}

/** Monotonic-ish stopwatch: `const ms = since(t0)`. */
export const now = () => Date.now();
export const since = (t) => Date.now() - t;
