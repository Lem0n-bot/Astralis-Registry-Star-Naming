'use client';

/**
 * Private certificate generator. Reachable only with the admin session cookie —
 * middleware.js answers 401 with a bare password form otherwise, so none of this
 * markup is ever served to an unauthenticated visitor.
 *
 * Fields mirror the live personalisation form in public/index.html (and its
 * length limits), plus the star attributes the galaxy explorer would normally
 * supply. "Auto-fill" resolves those from a catalogue id through
 * lib/star-catalog.js, which reproduces the explorer's own deterministic maths,
 * so a certificate issued here carries the same coordinates a buyer would get.
 */

import { useState } from 'react';

const C = {
  gold: '#D9B96C',
  goldBright: '#F2DCA2',
  star: '#F2ECDD',
  mute: '#99A2C4',
  dim: '#6E7799',
  bad: '#E4807A',
  ok: '#7BD4A0',
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "'Outfit', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
};

// Must match the live form's <select id="f-occ">.
const OCCASIONS = [
  'Just because',
  'Birthday',
  'Anniversary',
  'Wedding',
  "Valentine's Day",
  "Mother's Day",
  "Father's Day",
  'New baby',
  'Memorial tribute',
];

const BLANK = {
  name: '',
  recip: '',
  occ: 'Just because',
  theme: 'midnight',
  msg: '',
  starId: '',
  cons: '',
  ra: '',
  dec: '',
  mag: '',
  cls: '',
  sec: '',
  seed: '',
};

export default function AdminCertificate() {
  const [f, setF] = useState(BLANK);
  const [sendEmail, setSendEmail] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const say = (tone, text) => setMsg({ tone, text });

  async function autoFill() {
    if (!f.starId.trim()) return say('bad', 'Enter a star ID first.');
    setBusy('fill');
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/certificate/generate?star_id=${encodeURIComponent(f.starId.trim())}`);
      if (r.status === 401) return say('bad', 'Session expired — reload the page to sign in again.');
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.star) return say('bad', 'No star with that ID. The catalogue runs AST-100000 to AST-999999.');
      const s = d.star;
      setF((p) => ({
        ...p,
        starId: s.id,
        cons: s.cons,
        ra: s.ra,
        dec: s.dec,
        mag: s.mag,
        cls: s.cls,
        sec: s.sec,
        seed: String(s.seed),
      }));
      say('ok', `Filled from ${s.id} — ${s.cons}, ${s.status}.`);
    } catch {
      say('bad', 'Could not reach the star catalogue.');
    } finally {
      setBusy('');
    }
  }

  async function generate() {
    if (!f.name.trim()) return say('bad', 'Star name is required.');
    if (sendEmail && !emailTo.trim()) return say('bad', 'Enter an email address, or untick the email option.');
    setBusy('gen');
    setMsg(null);
    try {
      const r = await fetch('/api/admin/certificate/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...f, sendEmail, emailTo }),
      });

      if (r.status === 401) return say('bad', 'Session expired — reload the page to sign in again.');

      // Emailing returns JSON; a plain generate returns the PDF itself.
      if ((r.headers.get('content-type') || '').includes('application/json')) {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.emailStatus === 'sent') return say('ok', `Sent to ${emailTo} · certificate ${d.certId}`);
        return say('bad', d.emailError || d.error || 'Something went wrong.');
      }

      const blob = await r.blob();
      const certId = r.headers.get('x-astralis-cert-id') || 'certificate';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Astralis-Certificate-${certId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      say('ok', `Downloaded · certificate ${certId}`);
    } catch {
      say('bad', 'Render failed. Check the function logs.');
    } finally {
      setBusy('');
    }
  }

  const field = (label, k, props = {}) => (
    <label style={S.field}>
      <span style={S.label}>{label}</span>
      <input style={S.input} value={f[k]} onChange={set(k)} autoComplete="off" {...props} />
    </label>
  );

  return (
    <main style={S.page}>
      <div style={S.card}>
        <div style={S.brand}>ASTRALIS</div>
        <div style={S.eyebrow}>Certificate generator · private</div>
        <p style={S.note}>
          Renders through the same pipeline a paying customer goes through. No Stripe session is created and nothing is
          charged. The star is not recorded as claimed — see the README for why.
        </p>

        <div style={S.section}>Personalisation</div>
        {field('Star name', 'name', { maxLength: 28, placeholder: 'e.g. Amelia Rose' })}
        {field('Recipient name', 'recip', { maxLength: 40, placeholder: 'Who is this gift for?' })}
        <label style={S.field}>
          <span style={S.label}>Occasion</span>
          <select style={S.input} value={f.occ} onChange={set('occ')}>
            {OCCASIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <div style={S.field}>
          <span style={S.label}>Certificate style</span>
          <div style={S.row}>
            {[
              ['midnight', 'Midnight'],
              ['ivory', 'Ivory'],
            ].map(([v, text]) => (
              <button
                key={v}
                type="button"
                onClick={() => setF((p) => ({ ...p, theme: v }))}
                style={{ ...S.toggle, ...(f.theme === v ? S.toggleOn : null) }}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        <label style={S.field}>
          <span style={S.label}>
            Custom message <span style={S.count}>{f.msg.length}/120</span>
          </span>
          <textarea style={{ ...S.input, minHeight: 74, resize: 'vertical' }} maxLength={120} value={f.msg} onChange={set('msg')} />
        </label>

        <div style={S.section}>Star details</div>
        <div style={S.field}>
          <span style={S.label}>Star ID</span>
          <div style={S.row}>
            <input style={{ ...S.input, flex: 1 }} value={f.starId} onChange={set('starId')} placeholder="AST-660055" autoComplete="off" />
            <button type="button" onClick={autoFill} disabled={!!busy} style={S.ghost}>
              {busy === 'fill' ? 'Looking up…' : 'Auto-fill'}
            </button>
          </div>
          <span style={S.hint}>Resolves coordinates, constellation, magnitude and class from the registry — or fill them in by hand below.</span>
        </div>
        <div style={S.grid}>
          {field('Constellation', 'cons', { maxLength: 40, placeholder: 'Lyra' })}
          {field('Magnitude', 'mag', { maxLength: 20, placeholder: '4.21' })}
          {field('Right ascension', 'ra', { maxLength: 30, placeholder: '18h 36m 56s' })}
          {field('Declination', 'dec', { maxLength: 30, placeholder: "+38° 47′ 01″" })}
          {field('Star class', 'cls', { maxLength: 40, placeholder: 'A1 V' })}
          {field('Sector', 'sec', { maxLength: 40, placeholder: 'Orion Spur' })}
        </div>

        <div style={S.section}>Delivery</div>
        <label style={{ ...S.row, gap: 9, cursor: 'pointer', marginBottom: sendEmail ? 10 : 0 }}>
          <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} style={S.check} />
          <span style={{ color: C.mute, fontSize: 13.5 }}>Email this certificate to</span>
        </label>
        {sendEmail && (
          <input
            style={S.input}
            type="email"
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            placeholder="customer@example.com"
            autoComplete="off"
          />
        )}

        <button type="button" onClick={generate} disabled={!!busy} style={{ ...S.primary, opacity: busy ? 0.6 : 1 }}>
          {busy === 'gen' ? 'Rendering…' : sendEmail ? 'Generate & email PDF' : 'Generate PDF'}
        </button>

        {msg && <p style={{ ...S.result, color: msg.tone === 'ok' ? C.ok : C.bad }}>{msg.text}</p>}

        <button type="button" onClick={() => { setF(BLANK); setMsg(null); }} style={S.reset}>
          Clear form
        </button>
      </div>
    </main>
  );
}

const S = {
  page: {
    minHeight: '100svh',
    margin: 0,
    padding: '32px 16px',
    background: '#05070F',
    fontFamily: C.sans,
    color: C.star,
    display: 'flex',
    justifyContent: 'center',
  },
  card: {
    width: 'min(560px, 100%)',
    background: 'linear-gradient(180deg,rgba(16,20,46,0.92),rgba(10,13,32,0.94))',
    border: '1px solid rgba(217,185,108,0.22)',
    borderRadius: 20,
    padding: '32px 26px 26px',
  },
  brand: { fontFamily: C.serif, fontSize: 24, fontWeight: 600, letterSpacing: 2, color: C.gold },
  eyebrow: { fontSize: 11, letterSpacing: 2.5, textTransform: 'uppercase', color: C.mute, marginTop: 5 },
  note: { fontSize: 12.5, lineHeight: 1.6, color: C.dim, margin: '14px 0 0' },
  section: {
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: C.gold,
    margin: '26px 0 14px',
    paddingBottom: 7,
    borderBottom: '1px solid rgba(217,185,108,0.18)',
  },
  field: { display: 'block', marginBottom: 14 },
  label: { display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: C.mute, marginBottom: 6 },
  count: { color: C.dim, fontSize: 11 },
  hint: { display: 'block', fontSize: 11.5, lineHeight: 1.5, color: C.dim, marginTop: 6 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(217,185,108,0.26)',
    background: 'rgba(255,255,255,0.04)',
    color: C.star,
    fontSize: 14,
    fontFamily: C.sans,
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0 14px' },
  row: { display: 'flex', alignItems: 'center', gap: 10 },
  toggle: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: '1px solid rgba(217,185,108,0.26)',
    background: 'rgba(255,255,255,0.04)',
    color: C.mute,
    fontSize: 13.5,
    fontFamily: C.sans,
    cursor: 'pointer',
  },
  toggleOn: { borderColor: C.gold, background: 'rgba(217,185,108,0.12)', color: C.goldBright },
  check: { width: 16, height: 16, accentColor: C.gold },
  ghost: {
    padding: '10px 16px',
    borderRadius: 10,
    border: `1px solid rgba(217,185,108,0.4)`,
    background: 'transparent',
    color: C.star,
    fontSize: 13.5,
    fontFamily: C.sans,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  primary: {
    width: '100%',
    marginTop: 22,
    padding: '14px 0',
    borderRadius: 999,
    border: 0,
    background: `linear-gradient(135deg, ${C.goldBright}, ${C.gold})`,
    color: '#1a1405',
    fontWeight: 600,
    fontSize: 15,
    fontFamily: C.sans,
    cursor: 'pointer',
  },
  result: { fontSize: 13, lineHeight: 1.5, margin: '14px 0 0', textAlign: 'center' },
  reset: {
    display: 'block',
    margin: '16px auto 0',
    padding: 0,
    border: 0,
    background: 'none',
    color: C.dim,
    fontSize: 12.5,
    fontFamily: C.sans,
    textDecoration: 'underline',
    cursor: 'pointer',
  },
};
