'use client';

import { useEffect, useState } from 'react';

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

            {data.portalUrl ? (
              <>
                <a href={data.portalUrl} style={styles.btnGold}>
                  View &amp; download your certificate{(data.items?.length || 0) > 1 ? 's' : ''}
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    background: `radial-gradient(900px 600px at 70% 10%, rgba(123,92,240,.16), transparent 60%), #070917`,
    fontFamily: C.sans,
    color: C.star,
  },
  card: {
    width: 'min(480px, 100%)',
    background: 'linear-gradient(180deg,#10142E,#0A0D20)',
    border: '1px solid rgba(217,185,108,0.22)',
    borderRadius: 20,
    padding: '40px 28px',
    textAlign: 'center',
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
