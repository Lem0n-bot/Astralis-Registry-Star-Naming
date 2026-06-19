'use client';

import { useEffect, useRef, useState } from 'react';

const C = {
  gold: '#D9B96C',
  goldBright: '#F2DCA2',
  star: '#F2ECDD',
  mute: '#99A2C4',
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "'Outfit', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
};

const PKG = { standard: 'Standard', premium: 'Premium', ultimate: 'Ultimate Gift' };
const money = (cents, cur) => (cents == null ? '' : `$${(cents / 100).toFixed(2)} ${String(cur || 'AUD').toUpperCase()}`);

export default function CheckoutSuccess() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const skyRef = useRef(null);

  // twinkling starfield + occasional shooting stars, matching the hero background
  useEffect(() => {
    const cv = skyRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W, H, raf = 0, stars = [], shoots = [];
    const resize = () => {
      W = cv.width = Math.round(window.innerWidth * DPR);
      H = cv.height = Math.round(window.innerHeight * DPR);
      cv.style.width = window.innerWidth + 'px';
      cv.style.height = window.innerHeight + 'px';
      const n = Math.min(260, Math.floor((W * H) / 12000));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 1.3 + 0.3) * DPR,
        tw: Math.random() * 6.2832, sp: 0.4 + Math.random() * 1.1, fl: 0, up: false,
      }));
    };
    resize();
    window.addEventListener('resize', resize);
    const frame = () => {
      raf = requestAnimationFrame(frame);
      ctx.clearRect(0, 0, W, H);
      for (const s of stars) {
        s.tw += 0.015 * s.sp;
        if (s.fl === 0) { if (Math.random() < 0.00002) { s.fl = 0.01; s.up = true; } }
        else if (s.up) { s.fl = Math.min(1, s.fl + 0.04); if (s.fl >= 1) s.up = false; }
        else { s.fl *= 0.985; if (s.fl < 0.02) s.fl = 0; }
        const a = Math.min(1, 0.22 + 0.5 * Math.abs(Math.sin(s.tw)) + s.fl * 0.7);
        ctx.fillStyle = `rgba(${s.r > 1.1 * DPR ? '255,248,232' : '228,236,255'},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (1 + s.fl * 0.8), 0, 6.2832); ctx.fill();
      }
      if (Math.random() < 0.004 && shoots.length < 2)
        shoots.push({ x: W * (0.55 + Math.random() * 0.45), y: Math.random() * H * 0.3, vx: -(6 + Math.random() * 5) * DPR, vy: (3 + Math.random() * 2) * DPR, life: 1 });
      for (let i = shoots.length - 1; i >= 0; i--) {
        const sh = shoots[i]; sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.018;
        if (sh.life <= 0) { shoots.splice(i, 1); continue; }
        const g = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * 9, sh.y - sh.vy * 9);
        g.addColorStop(0, `rgba(255,250,235,${sh.life})`); g.addColorStop(1, 'rgba(255,250,235,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 1.6 * DPR;
        ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x - sh.vx * 9, sh.y - sh.vy * 9); ctx.stroke();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get('session_id');
    if (!sid) {
      setState({ loading: false, error: 'No checkout session was found.', data: null });
      return;
    }
    let cancelled = false;
    fetch(`/api/checkout/order?session_id=${encodeURIComponent(sid)}`)
      .then((r) => r.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return;
        if (data && data.paid) setState({ loading: false, error: null, data });
        else setState({ loading: false, error: 'We could not confirm this payment. If you were charged, please contact support.', data });
      })
      .catch(() => !cancelled && setState({ loading: false, error: 'Something went wrong confirming your order.', data: null }));
    return () => {
      cancelled = true;
    };
  }, []);

  const { loading, error, data } = state;

  return (
    <main style={styles.page}>
      <canvas ref={skyRef} style={styles.sky} aria-hidden="true" />
      <div style={styles.nebula} aria-hidden="true" />
      <div style={styles.card}>
        <div style={styles.brand}>ASTRALIS</div>
        <div style={styles.eyebrow}>Registry</div>

        {loading && (
          <>
            <div style={styles.spinner} aria-hidden="true" />
            <p style={styles.muted}>Confirming your payment…</p>
          </>
        )}

        {!loading && error && (
          <>
            <h1 style={styles.h1}>Hmm.</h1>
            <p style={styles.muted}>{error}</p>
            <a href="/" style={styles.btnGhost}>Return to Astralis</a>
          </>
        )}

        {!loading && !error && data && (
          <>
            <div style={styles.seal} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none">
                <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" stroke={C.goldBright} strokeWidth="1.2" fill="rgba(242,220,162,.25)" />
              </svg>
            </div>
            <h1 style={styles.h1}>Their star is named.</h1>
            <p style={styles.muted}>
              Payment confirmed. A receipt and your personalised certificate{(data.items?.length || 0) > 1 ? 's' : ''} are on the way to{' '}
              <b style={{ color: C.star }}>{data.email}</b>.
            </p>

            {data.orderNo && (
              <p style={styles.order}>
                Order <b style={{ color: C.goldBright }}>{data.orderNo}</b>
              </p>
            )}

            {!!(data.items && data.items.length) && (
              <ul style={styles.list}>
                {data.items.map((it, i) => (
                  <li key={i} style={styles.li}>
                    <span style={{ color: C.star }}>{it.name}</span>
                    <span style={{ color: C.mute, fontSize: 13 }}>
                      {PKG[it.pkg] || it.pkg}
                      {it.starId ? ` · ${it.starId}` : ''}
                      {it.cons ? ` · ${it.cons}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {data.amountTotal != null && (
              <div style={styles.total}>
                <span style={{ color: C.mute }}>Total paid</span>
                <span style={{ color: C.goldBright, fontFamily: C.serif, fontSize: 22 }}>{money(data.amountTotal, data.currency)}</span>
              </div>
            )}

            {!!(data.certificates && data.certificates.length) && (
              <div style={styles.certs}>
                {data.certificates.map((c, i) => (
                  <a key={i} href={c.pdfUrl} style={styles.certBtn}>
                    <span aria-hidden="true">⤓</span> Download “{c.name}” — PDF
                  </a>
                ))}
              </div>
            )}

            <p style={styles.next}>
              {(data.certificates && data.certificates.length)
                ? 'Your certificates are attached to the email and downloadable above. Printed keepsakes ship within Australia.'
                : 'Printed keepsakes ship within Australia. You can safely close this page — everything is on its way.'}
            </p>

            {(data.certViewUrl || data.portalUrl) ? (
              <>
                <a href={data.certViewUrl || data.portalUrl} style={styles.btnGold}>
                  View your certificate{(data.items?.length || 0) > 1 ? 's' : ''}
                </a>
                <a href="/" style={styles.btnGhost}>Back to Astralis</a>
              </>
            ) : (
              <a href="/" style={styles.btnGold}>Back to Astralis</a>
            )}
          </>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </main>
  );
}

const styles = {
  page: {
    minHeight: '100svh',
    margin: 0,
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    background: '#05070F',
    fontFamily: C.sans,
    color: C.star,
  },
  // full-screen twinkling starfield + nebula glow, exactly like the hero
  sky: { position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none' },
  nebula: {
    position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
    background:
      'radial-gradient(1200px 700px at 70% 20%,rgba(123,92,240,.16),transparent 60%),' +
      'radial-gradient(900px 600px at 15% 85%,rgba(27,17,64,.7),transparent 65%)',
  },
  card: {
    position: 'relative',
    zIndex: 1,
    width: 'min(480px, 100%)',
    background: 'linear-gradient(180deg,rgba(16,20,46,0.92),rgba(10,13,32,0.94))',
    border: '1px solid rgba(217,185,108,0.22)',
    borderRadius: 20,
    padding: '40px 28px',
    textAlign: 'center',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 40px 110px rgba(0,0,0,.6)',
  },
  brand: { fontFamily: C.serif, fontSize: 26, fontWeight: 600, letterSpacing: 2, color: C.gold },
  eyebrow: { fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: C.mute, marginTop: 6 },
  seal: {
    width: 74, height: 74, margin: '22px auto 0', borderRadius: '50%', border: `1px solid ${C.gold}`,
    display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 35% 30%, rgba(242,220,162,.3), transparent)',
  },
  h1: { fontFamily: C.serif, fontSize: 30, fontWeight: 500, margin: '18px 0 8px' },
  muted: { color: C.mute, fontSize: 15, lineHeight: 1.6, margin: '0 0 6px' },
  order: { fontSize: 14, color: C.mute, margin: '10px 0 4px' },
  list: { listStyle: 'none', padding: 0, margin: '16px 0', textAlign: 'left' },
  li: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 0', borderTop: '1px solid rgba(255,255,255,.07)' },
  total: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '8px 0 4px', paddingTop: 14, borderTop: '1px solid rgba(217,185,108,.3)' },
  next: { color: C.mute, fontSize: 12.5, lineHeight: 1.6, margin: '18px 0 22px' },
  certs: { display: 'grid', gap: 10, margin: '18px 0 4px' },
  certBtn: {
    display: 'block', padding: '12px 16px', borderRadius: 12, textDecoration: 'none',
    border: '1px solid rgba(217,185,108,0.3)', background: 'rgba(217,185,108,0.06)',
    color: C.goldBright, fontSize: 14, textAlign: 'left',
  },
  btnGold: {
    display: 'inline-block', width: '100%', boxSizing: 'border-box', padding: '14px 0', borderRadius: 999,
    background: `linear-gradient(135deg, ${C.goldBright}, ${C.gold})`, color: '#1a1405', fontWeight: 600, textDecoration: 'none',
  },
  btnGhost: {
    display: 'inline-block', marginTop: 18, padding: '12px 26px', borderRadius: 999,
    border: '1px solid rgba(217,185,108,0.4)', color: C.star, textDecoration: 'none',
  },
  spinner: {
    width: 38, height: 38, margin: '28px auto 16px', borderRadius: '50%',
    border: '3px solid rgba(217,185,108,.25)', borderTopColor: C.gold, animation: 'spin .8s linear infinite',
  },
};
