import { checkCode, normaliseEmail } from '../store';

export const runtime = 'nodejs';        // shares the in-memory store
export const dynamic = 'force-dynamic'; // never cache

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const email = normaliseEmail(body && body.email);
  // strip whitespace — people paste codes with spaces
  const code = String((body && body.code) || '').replace(/\s+/g, '');
  if (!email || !code) {
    return Response.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const res = checkCode(email, code);
  if (res.ok) return Response.json({ ok: true });

  switch (res.reason) {
    case 'too_many':
      return Response.json({ ok: false, error: 'too_many_attempts' }, { status: 429 });
    case 'expired':
      return Response.json({ ok: false, error: 'expired' }, { status: 410 });
    case 'no_code':
      return Response.json({ ok: false, error: 'no_code' }, { status: 404 });
    default:
      return Response.json({ ok: false, error: 'mismatch', attemptsRemaining: res.attemptsRemaining });
  }
}
